# BFD Workbench — Technical Reference

Everything about how this application is built: the process model, every IPC command, the streaming protocol, how a prompt is assembled, what differs between operating systems, and where to extend it.

For installation and day-to-day use, see [`../README.md`](../README.md).

---

## Table of contents

1. [What BFD actually is](#1-what-bfd-actually-is)
2. [Architecture](#2-architecture)
3. [Repository layout](#3-repository-layout)
4. [The Rust backend](#4-the-rust-backend)
5. [IPC command reference](#5-ipc-command-reference)
6. [The Claude CLI bridge](#6-the-claude-cli-bridge)
7. [The streaming protocol](#7-the-streaming-protocol)
8. [The tool-calling loop](#8-the-tool-calling-loop)
9. [Prompt assembly](#9-prompt-assembly)
10. [Operating modes](#10-operating-modes)
11. [The memory system](#11-the-memory-system)
12. [The frontend](#12-the-frontend)
13. [Cross-platform strategy](#13-cross-platform-strategy)
14. [Security model](#14-security-model)
15. [Build and release](#15-build-and-release)
16. [Extending BFD](#16-extending-bfd)
17. [Troubleshooting from the inside](#17-troubleshooting-from-the-inside)
18. [Design decisions and their history](#18-design-decisions-and-their-history)

---

## 1. What BFD actually is

BFD is a **desktop shell around a command-line program**. It does not talk to the Anthropic API. It does not hold an API key. It runs this, on your machine, as your user:

```
claude --model <id> --print --output-format stream-json --verbose --include-partial-messages
```

…writes your prompt to that process's **stdin**, reads newline-delimited JSON off its **stdout**, and renders the result. Authentication, model access, rate limits, and billing are entirely the Claude CLI's business. If `claude` works in your terminal, BFD works.

What BFD adds on top:

- A window with chat, a real code editor, a file tree, a terminal, and a git panel that share state.
- A **tool-calling loop** that lets the model read and write your filesystem and run commands, mediated by Rust functions rather than by the CLI's own tools.
- A **memory system** that injects standing notes and per-project context into every conversation.
- **Operating modes** that change how much the model is allowed to do without asking.

The consequence worth internalizing: BFD is an agent with your user's privileges. Section 14 covers what is and is not defended against.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Native window (WKWebView on macOS, WebView2 on Windows)          │
│                                                                  │
│   React 19 + TypeScript          src/App.tsx                     │
│     ├── chat view                src/platform.ts                 │
│     ├── Monaco editor            src/GitPanel.tsx                │
│     ├── file tree                                                │
│     ├── terminal                                                 │
│     └── git panel                                                │
└───────────────┬──────────────────────────────┬───────────────────┘
    invoke()    │                              │  listen()
   (request)    ▼                              │  (events)
┌──────────────────────────────────────────────┴───────────────────┐
│ Rust backend — src-tauri/src/lib.rs                              │
│                                                                  │
│   fs commands   process commands   git commands   claude bridge  │
│         │              │                 │              │        │
└─────────┼──────────────┼─────────────────┼──────────────┼────────┘
          ▼              ▼                 ▼              ▼
     filesystem      /bin/sh          git binary     claude CLI
                     cmd.exe                         (stdin/stdout)
```

**Two processes at dev time, one at release time.** In development, Vite serves the frontend on `localhost:1420` and the Tauri binary loads that URL — so frontend edits hot-reload, but *Rust edits require a rebuild and a relaunch*. In a packaged build the frontend is a static bundle embedded in the binary.

**Everything privileged lives in Rust.** The webview cannot touch the filesystem or spawn processes directly; the capability file (`src-tauri/capabilities/default.json`) grants only core, fs, dialog, and opener permissions to the window. Every meaningful action is a named `#[tauri::command]`, which makes the backend's surface area exactly the list in section 5.

---

## 3. Repository layout

```
bfd-workbench/
├── README.md                     quick start
├── LICENSE                       MIT
├── package.json                  frontend deps + npm scripts
├── vite.config.ts                dev server pinned to port 1420
├── tsconfig.json                 strict mode, noUnusedLocals
├── index.html                    webview entry point
│
├── src/                          frontend
│   ├── App.tsx                   ~1200 lines: all views, chat loop, tool loop
│   ├── App.css                   dark theme
│   ├── platform.ts               OS facts + path helpers  ← read this first
│   ├── GitPanel.tsx              git sidebar
│   ├── main.tsx                  React root
│   └── vite-env.d.ts
│
├── src-tauri/                    backend
│   ├── Cargo.toml                Rust deps, release profile
│   ├── tauri.conf.json           window, bundle, installer config
│   ├── build.rs                  tauri-build codegen
│   ├── capabilities/default.json webview permission grants
│   ├── icons/                    app icons (.icns, .ico, PNG set)
│   └── src/
│       ├── main.rs               6 lines; calls lib::run()
│       └── lib.rs                every command, ~500 lines
│
├── scripts/
│   ├── setup.sh                  macOS / Linux bootstrap
│   └── setup.ps1                 Windows bootstrap
│
├── docs/TECHNICAL.md             this file
└── .github/workflows/build.yml   CI on macOS, Windows, Linux
```

`src/platform.ts` is small and load-bearing — read it before touching anything that constructs a path.

---

## 4. The Rust backend

`src-tauri/src/lib.rs` is one file in six sections.

### 4.1 State

```rust
struct ClaudeProcs(Arc<Mutex<HashMap<String, u32>>>);
```

A map from **frontend request id → OS process id**, registered in Tauri's managed state. It exists so the Stop button can kill a specific in-flight request. Entries are inserted when a claude process spawns and removed in the same blocking task that reaps it, so a crashed CLI does not leak a map entry.

### 4.2 `harden()` — the environment fixup every subprocess gets

```rust
fn harden(cmd: &mut StdCommand)
```

Two unrelated problems, one function.

**On Unix it rebuilds `PATH`.** A GUI application launched from Finder or a `.app` bundle does *not* inherit your shell's environment — it gets a minimal `PATH` from `launchd`, typically without `/opt/homebrew/bin`. The symptom is maddening: `claude` and `git` work perfectly in Terminal and come back "command not found" inside the app. `harden` prepends the standard system directories plus `/opt/homebrew/bin`, `~/.cargo/bin`, `~/.local/bin`, `~/.bun/bin`, then **appends whatever `PATH` the process already had** so nvm/volta/asdf shims still resolve. It also pins `HOME`, which some tools read directly.

**On Windows it sets `CREATE_NO_WINDOW` (`0x08000000`).** Windows GUI processes inherit a usable `PATH` already, so that half is unnecessary — but every `cmd.exe` or `powershell.exe` spawn would pop a console window for a fraction of a second. With BFD polling ports and running git, that is a visible flicker. The creation flag suppresses it.

### 4.3 `shell()` — the one place an OS shell is chosen

```rust
fn shell(script: &str) -> StdCommand
```

`/bin/sh -c <script>` on Unix, `cmd.exe /C <script>` on Windows, `harden`ed either way. Every subprocess in the app that needs shell semantics goes through this, so adding a platform means editing one function.

### 4.4 `powershell()` — Windows only

Compiled only under `#[cfg(windows)]`. Used for the port commands, where the `cmd.exe` equivalents (`for /f` loops over `netstat` output with escaped pipes) are unreadable and fragile. PowerShell's `Get-NetTCPConnection` / `Stop-Process` are the direct expression of what `lsof -ti:PORT | xargs kill -9` means.

### 4.5 Path and home helpers

`home_dir_string()` wraps the `dirs` crate (`$HOME` on Unix, `%USERPROFILE%` on Windows). `default_cwd()` supplies the home directory when the frontend passes no working directory, and treats an empty string as absent — a subtle but real bug class, since `Command::current_dir("")` fails rather than defaulting.

### 4.6 `safe_flag()` — the injection guard

```rust
fn safe_flag(s: &str) -> bool   // [A-Za-z0-9._-]+ only
```

The only two values that ever reach a shell command line are the model id and the effort level, and both must pass this. Everything else — prompts, file paths, git arguments — travels by stdin or by argument vector. See section 14.

---

## 5. IPC command reference

Every command is invoked from the frontend as `invoke("name", { args })`. Arguments are listed in Rust snake_case; the JS side uses camelCase and Tauri converts (`start_path` ⇄ `startPath`).

### Platform

| Command | Args | Returns | Notes |
|---|---|---|---|
| `platform_info` | — | `{ os, sep, home, is_windows }` | `os` is `"macos"`/`"windows"`/`"linux"`; `sep` is `MAIN_SEPARATOR`. Called once at mount before anything builds a path. |

### Filesystem

| Command | Args | Returns | Notes |
|---|---|---|---|
| `read_file` | `path` | `String` | UTF-8 only; binary files error rather than corrupt. |
| `write_file` | `path`, `content` | `()` | **Creates parent directories** via `create_dir_all`, then overwrites unconditionally. No backup, no confirmation. |
| `list_dir` | `path` | `[{ name, path, is_dir, size }]` | Directories first, then case-insensitive name sort. Unreadable entries (broken symlinks, permission denied) are **skipped**, not fatal. Returns no mtime — see the note in §12.4. |
| `file_exists` | `path` | `bool` | |
| `create_dir` | `path` | `()` | Recursive. |
| `delete_file` | `path` | `()` | Recursive for directories (`remove_dir_all`). No trash, no undo. |
| `get_home_dir` | — | `String` | Errors if the home directory cannot be resolved. |

### Memory

| Command | Args | Returns | Notes |
|---|---|---|---|
| `find_project_context` | `start_path` | `String` | Walks **up** the tree looking for `.bfd/context.md`; errors when it reaches the root. |
| `load_global_memory` | — | `String` | Tries `~/.bfd/global.md`, then legacy `~/BFD/.bfd/global.md`. Missing file returns `""`, not an error. |

### Processes

| Command | Args | Returns | Notes |
|---|---|---|---|
| `run_command` | `command`, `cwd?` | `{ stdout, stderr, exit_code }` | **async.** Blocks until exit — no timeout. A `sleep 600` hangs that request (the window stays responsive). |
| `run_background` | `command`, `cwd?` | `"Process started (PID: n)"` | Fire and forget; stdout and stderr go to null. Not tracked, not killable by BFD. |
| `kill_port` | `port` | `String` | Unix: `lsof -ti:PORT \| xargs kill -9`. Windows: `Get-NetTCPConnection` → `Stop-Process -Force`. Always reports success. |
| `check_port` | `port` | `bool` | True when something is listening. |

### Claude

| Command | Args | Returns | Notes |
|---|---|---|---|
| `run_claude_stream` | `request_id`, `prompt`, `model`, `effort?`, `cwd?` | `{ exit_code, stderr }` | **async.** Emits `claude-stream` events while running; resolves at exit. `stderr` is tail-truncated to 2000 chars on a char boundary. |
| `stop_claude` | `request_id` | `String` | `kill -TERM` on Unix, `taskkill /PID n /T /F` on Windows. Errors if the id is not live. |

### Git

| Command | Args | Returns | Notes |
|---|---|---|---|
| `git_run` | `repo`, `args[]` | `{ stdout, stderr, exit_code }` | **async.** `args[0]` must be in the allowlist below or the call is rejected before spawning. |
| `git_overview` | `repo` | `{ is_repo, root, branch, changed, last_commit, remote, ahead, behind }` | **async.** Six git invocations behind one round-trip. `{ is_repo: false }` when the path is not a repository. |

Allowed git subcommands:

```
status  log     diff     add      commit   push    pull
fetch   init    branch   checkout switch   remote  rev-parse
rev-list show   stash    ls-files restore  merge
```

Deliberately absent: `reset`, `clean`, `rebase`, `filter-branch`, `gc`, `config`. Those either destroy uncommitted work or rewrite history, and a UI button is the wrong affordance for them.

### Why so many commands are `async`

A synchronous `#[tauri::command]` runs on the main thread, which is also the UI thread. A synchronous `run_command` that takes ten seconds freezes the window for ten seconds — spinning beachball, unresponsive everything. Every command that can block (process spawn, network git, the Claude bridge) is `async fn` and moves its blocking work into `tauri::async_runtime::spawn_blocking`. Pure filesystem commands stay synchronous because they complete in microseconds.

---

## 6. The Claude CLI bridge

The most important function in the codebase.

```rust
async fn run_claude_stream(app, state, request_id, prompt, model, effort, cwd)
```

**Step by step:**

1. **Validate.** `model` and `effort` must pass `safe_flag`. Reject otherwise, before anything spawns.

2. **Build the command line.** Only validated flags are interpolated:
   ```
   exec claude --model <model> --print --output-format stream-json --verbose --include-partial-messages [--effort <effort>]
   ```
   `exec` is Unix-only and deliberate: it replaces the shell process with `claude`, so the pid we record **is** the CLI's. Windows `cmd.exe` has no `exec`, so there the recorded pid is cmd.exe's and Stop compensates with `taskkill /T` (kill tree).

3. **Spawn** through `shell()` with all three stdio handles piped, and register `request_id → pid`.

4. **Three threads, inside one `spawn_blocking`:**
   - a writer thread pushes the prompt into stdin and drops the handle, signalling EOF (the CLI will not begin work until stdin closes);
   - a reader thread drains stderr to a `String` (an undrained stderr pipe can fill its buffer and deadlock the child);
   - the main body reads stdout line by line, emitting each non-empty line as a `claude-stream` event.

5. **Reap.** Wait for exit, join both threads, remove the pid from state, return `{ exit_code, stderr }` with stderr tail-truncated.

**The prompt never appears on a command line.** It goes over stdin exclusively. This is the single most important security property of the file — see §14.1 for why.

---

## 7. The streaming protocol

Each stdout line from the CLI is one JSON object. The backend forwards it verbatim:

```js
listen("claude-stream", ({ payload }) => {
  // payload = { requestId: string, line: string }
});
```

The frontend ignores events whose `requestId` is not the active one — a stale reply from a stopped request cannot bleed into a new conversation.

Event shapes the frontend acts on:

| `type` | Handling |
|---|---|
| `stream_event` → `content_block_delta` → `text_delta` | Append `.delta.text` to the assistant message. This is the token-by-token render. |
| `assistant` → `message.content[]` | Content blocks. `text` blocks are the authoritative final text; `tool_use` blocks drive the activity line. |
| `result` | Terminal. Carries the final text and the session result. |
| `system` / `init` | Ignored. |

Unrecognized types are skipped rather than treated as errors, so a CLI upgrade that adds event types degrades to "renders less detail" instead of breaking.

**Activity lines.** `tool_use` blocks are mapped to human phrasing by `CLI_TOOL_STATUS` and `toolActivityLine()` — `Read` → "Reading App.tsx", `Bash` → "Running: npm test" (truncated at 60 chars), `WebSearch` → "Searching the web: …". An unknown tool falls back to `Using <name>`. This is the "what is it doing right now" line under the streaming reply.

---

## 8. The tool-calling loop

Separate from and older than the CLI's own native tools. BFD defines its own tool schema (`TOOLS_SCHEMA` in `App.tsx`), describes the tools in the system prompt, and executes them through the Rust commands:

| Tool | Backend command |
|---|---|
| `read_file` | `read_file` |
| `write_file` | `write_file` |
| `list_dir` | `list_dir` |
| `delete_file` | `delete_file` |
| `file_exists` | `file_exists` |
| `run_command` | `run_command` |
| `run_background` | `run_background` |
| `kill_port` | `kill_port` |
| `check_port` | `check_port` |

The `TOOL_STATUS` map turns each into a UI status string ("Writing a file", "Freeing a port"). Because these run through BFD's own Rust layer, they are subject to BFD's approval modes rather than the CLI's permission prompts — which is why `--tools ""` style restrictions on the CLI do not disable them.

---

## 9. Prompt assembly

`basePrompt()` and the send path build one string per message, in this order:

```
1. BASE PROMPT          identity, the seven CRITICAL RULES, tool guidance,
                        and the absolute home path resolved at runtime
2. APPROVAL PROMPT      "" | STANDARD | CAUTION   (explicitly overrides rule 1)
3. AGENT MODE PROMPT    only in Agent interaction mode
4. AGENT DOCS           contents of every .md in the agent directories
5. GLOBAL MEMORY        ~/.bfd/global.md
6. PROJECT CONTEXT      nearest .bfd/context.md
7. CURRENT DIRECTORY    where the file browser is pointed
8. CONVERSATION HISTORY omitted entirely in Amnesia mode
9. THE USER MESSAGE
```

Two details that matter:

- **The base prompt is a function, not a constant.** It interpolates the real home directory, which is unknown until `platform_info` returns. A module-level constant would bake in `undefined`.
- **Approval prompts say they override the base rules.** The base prompt's rule 1 is "DO IT immediately"; Caution mode's is "confirm every action". Without an explicit precedence statement the model gets contradictory instructions and picks unpredictably.

---

## 10. Operating modes

Three independent switches, persisted to `localStorage` under `bfd-modes`, applied per send.

### Memory: `standard` | `amnesia`

`standard` sends prior turns. `amnesia` sends only the current message. History is still **recorded and displayed** — you see the conversation, the model does not. Useful for a clean read on a question the earlier context is poisoning.

### Interaction: `chat` | `agent`

`agent` reads every `.md` file from `~/.claude/agents` and `~/.bfd/agents` into context, adds `AGENT_MODE_PROMPT`, and on switch injects a kickoff message so the model opens the conversation. Switching back to `chat` drops the agent docs from subsequent sends.

### Approval: `yolo` | `standard` | `caution`

| Mode | Injected instruction |
|---|---|
| `yolo` | none — base rules stand, act immediately |
| `standard` | plan first; ask before any state change; read freely |
| `caution` | plan first; confirm **each** write, delete, and command individually; never batch |

These are **prompt-level**, not enforcement. A sufficiently confused model can ignore them; the Rust layer will still execute what it is asked to execute. Treat them as a strong steer, not a sandbox.

---

## 11. The memory system

| File | Loaded | Purpose |
|---|---|---|
| `~/.bfd/global.md` | at launch, and re-read whenever a file named `global.md` is saved in the editor | standing facts: who you are, your machine, your preferences |
| `<any ancestor>/.bfd/context.md` | when the file browser enters that folder or any descendant | project facts: what this repo is, conventions, current goals |

`find_project_context` walks upward, so `/work/myrepo/src/deep/nested` finds `/work/myrepo/.bfd/context.md`. The first `# Heading` in that file becomes the project name shown in the status bar.

Neither file exists on a fresh install. Both are plain Markdown you can edit by hand or ask BFD to update — and BFD editing its own memory is the intended workflow. `.bfd/` is in `.gitignore` so project context does not accidentally get committed.

---

## 12. The frontend

### 12.1 State

`App.tsx` is one component holding roughly twenty `useState` values. There is no Redux, no context, no router. At this size, prop drilling is shorter than the wiring that would replace it. If you add a fourth or fifth view, that calculus changes.

Notable refs (values that must not trigger re-render):

- `activeRequestId` — the request whose stream events are accepted;
- `stoppedRef` — set by Stop so the in-flight loop knows to abandon its result.

### 12.2 Views

`activeView` is `"chat" | "editor"`. The sidebar and tab strip both set it. The editor renders only when a tab is open; otherwise the pane falls through to empty.

### 12.3 The mount effect

```tsx
useEffect(() => {
  initPlatform().then(() => {
    loadHomeDir(); loadMemory(); openStartupTabs();
    if (modes.interaction === "agent") loadAgentDocs();
  });
}, []);
```

**Ordering is a correctness requirement, not a preference.** Every path helper reads module state populated by `platform_info`. Calling `loadHomeDir()` before that resolves builds paths against an empty home.

### 12.4 Startup tabs

Optional. If `~/.bfd/startup_tabs.json` exists, its specs open as editor tabs at launch:

```json
[
  { "path": "/absolute/path/to/file.md" },
  { "dir": "/some/folder", "limit": 3 },
  { "dir": "/some/folder", "file": "summary.md", "limit": 2, "exclude": ["archive"] }
]
```

- `path` — that exact file
- `dir` + `limit` — the *newest* N files in that directory
- `dir` + `file` + `limit` — `file` inside the newest N **subdirectories**

"Newest" is a **numeric-aware descending name sort**, not mtime: `list_dir` does not return timestamps. This works for ISO-dated filenames (`2026-08-10-notes.md`) and numbered folders (`run-2`, `run-10` — sorted correctly by `localeCompare(..., {numeric: true})`), and not much else.

The tabs are collected first and committed in a **single** `setTabs`. Calling `openFile()` in a loop would read a stale `tabs` closure on every iteration and set `activeTab` to the wrong index.

### 12.5 `platform.ts`

The whole cross-platform path story:

| Export | Behavior |
|---|---|
| `initPlatform()` | Idempotent; only the first call hits Rust. Everything else awaits its promise. |
| `platform()` | The cached `{ os, sep, home, is_windows }`. |
| `homeDir()` | `/Users/name` or `C:\Users\name`. |
| `joinPath(...)` | Joins with the host separator, tolerating stray leading/trailing separators. |
| `basename(p)` | Splits on **both** `/` and `\` — a config file may have been authored on the other OS. |
| `dirname(p)` | Parent path, `""` when there is none. Powers the file tree's "go up". |
| `bfdPath(...)` | `~/.bfd/<...>`. |

**Rule: no string literal `"/"` in path construction anywhere in the frontend.** That single discipline is what makes the UI work on Windows.

---

## 13. Cross-platform strategy

Every OS difference is isolated to two files: `src-tauri/src/lib.rs` and `src/platform.ts`.

| Concern | macOS / Linux | Windows | Where |
|---|---|---|---|
| Shell | `/bin/sh -c` | `cmd.exe /C` | `shell()` |
| Console window | n/a | `CREATE_NO_WINDOW` | `harden()` |
| PATH | rebuilt (Homebrew, cargo, npm, bun) + inherited | inherited untouched | `harden()` |
| Home | `$HOME` | `%USERPROFILE%` | `dirs` crate |
| Separator | `/` | `\` | `platform_info` → `platform.ts` |
| Free a port | `lsof -ti:P \| xargs kill -9` | `Get-NetTCPConnection` → `Stop-Process` | `kill_port` |
| Check a port | `lsof -ti:P` | `Get-NetTCPConnection` | `check_port` |
| Kill claude | `kill -TERM <pid>` | `taskkill /PID <pid> /T /F` | `stop_claude` |
| Claude pid | `exec` collapses the shell away | cmd.exe stays; kill the tree | `run_claude_stream` |
| Webview | WKWebView | WebView2 | Tauri |
| Modifier key | ⌘ (`metaKey`) | Ctrl (`ctrlKey`) | both accepted |
| Terminal glyph | `$` | `>` | `platform().is_windows` |

### Why Windows needs `cmd.exe` for the Claude CLI

`claude` on Windows is `claude.cmd`, an npm shim. Rust's `Command::new("claude")` uses `CreateProcess`, which appends `.exe` and does **not** consult `PATHEXT` — so a direct spawn fails with "program not found" even though `claude` runs fine in any terminal. Routing through `cmd.exe /C` makes the shim resolve. The cost is the extra process in the middle, which is exactly why `stop_claude` uses `/T`.

### Verifying the Windows paths without Windows

`#[cfg(windows)]` code is invisible to a macOS build — it is not even parsed. Two mitigations:

```bash
rustup target add x86_64-pc-windows-msvc
cargo check --target x86_64-pc-windows-msvc     # typechecks the cfg(windows) branches
```

and `.github/workflows/build.yml`, which runs check + clippy on `windows-latest`, `macos-latest`, and `ubuntu-22.04` for every push. If you touch a `cfg` branch, let CI confirm it before assuming it builds.

---

## 14. Security model

### 14.1 What is defended

**Prompt content cannot execute.** The prompt travels to the CLI over stdin. It is never interpolated into a shell string. This is not theoretical caution: an earlier version of this application built the command as `sh -c 'echo "<PROMPT>" | claude'`, and a reply containing backticks executed as a shell command in the user's home directory. Stdin delivery is the fix, and the reason `safe_flag` exists to guard the only two values that *do* reach a command line.

**Git arguments cannot inject.** `git_run` spawns `git` with an argument vector — no shell is involved — and rejects any subcommand outside the allowlist before spawning.

**The webview is not privileged.** `capabilities/default.json` grants core, fs, dialog, and opener. The shell plugin is deliberately **not** enabled: nothing in the frontend uses it, and its scope syntax is platform-specific (a hardcoded `/bin/sh` entry is meaningless on Windows). All process execution goes through named Rust commands instead.

**Stop actually stops.** Each request's pid is tracked, and Stop signals that specific process — on Windows the whole tree, since cmd.exe is in the middle.

### 14.2 What is not defended

Be clear-eyed about these.

- **`run_command` runs arbitrary shell commands with your full user privileges.** Both the terminal and the model's tool loop use it. There is no sandbox, no allowlist, no path jail.
- **`write_file` and `delete_file` are unconditional.** No confirmation, no backup, no trash. `delete_file` on a directory is `remove_dir_all`.
- **Approval modes are prompt text, not enforcement.** They instruct the model to ask first. A model that ignores them meets a backend that will comply.
- **No path restriction.** Any absolute path your user can reach is reachable, including `~/.ssh` and `~/.aws`.
- **Global memory is injected into every prompt.** Anything in `~/.bfd/global.md` is sent to the model on every message. Do not put secrets there.
- **Local builds are unsigned.** No notarization on macOS, no Authenticode on Windows; both OSes will warn.

The honest summary: BFD's security boundary is *the model's judgment plus your approval-mode setting*. Use `standard` or `caution` on anything you would not hand to a script running as you.

---

## 15. Build and release

### Development

```bash
npm run start          # tauri dev: Vite on :1420 + the Rust binary
```

Frontend edits hot-reload. **Rust edits do not** — `cargo build` and relaunch. A backend fix that is written and compiled is not delivered until the running binary is replaced.

### Checks

```bash
npm run typecheck                       # tsc --noEmit, strict
cd src-tauri && cargo clippy -- -D warnings
cd src-tauri && cargo check --target x86_64-pc-windows-msvc
```

### Packaging

```bash
npm run package
```

| Host | Artifact |
|---|---|
| macOS | `src-tauri/target/release/bundle/dmg/BFD_1.0.0_aarch64.dmg`, `…/macos/BFD.app` |
| Windows | `src-tauri/target/release/bundle/nsis/BFD_1.0.0_x64-setup.exe` |
| Linux | `…/deb/`, `…/rpm/`, `…/appimage/` |

No cross-compilation — build on the target OS. The release profile is tuned for size (`opt-level = "s"`, LTO, one codegen unit, symbols stripped); the app is not CPU-bound, and installer size is what users notice.

The Windows installer is NSIS in `currentUser` mode, so no administrator prompt.

### Version bumps

Three files, kept in sync by hand: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, plus `BFD_VERSION` in `src/App.tsx` (which drives the status bar and terminal banner).

---

## 16. Extending BFD

### Adding a backend command

1. Write the function in `lib.rs` with `#[tauri::command]`. Make it `async` with `spawn_blocking` if it can block for more than a few milliseconds.
2. Add its name to the `tauri::generate_handler![…]` list — forgetting this is the usual cause of "command not found" at runtime.
3. Call it with `invoke<ReturnType>("name", { args })`. Rust snake_case parameters arrive as camelCase from JS.
4. `cargo build` and **relaunch** — hot reload does not cover Rust.

### Adding a model

Append to `MODELS` in `App.tsx`:

```ts
{ key: "unique-key", id: "claude-model-id", effort: null | "low" | "max", name: "Display Name" }
```

`id` must pass `safe_flag` (alphanumerics, `.`, `-`, `_`). The CLI has no `--fast` flag in `--print` mode; speed variants are expressed as `--effort` levels.

### Adding a tool the model can call

1. Add the JSON Schema entry to `TOOLS_SCHEMA`.
2. Add a human label to `TOOL_STATUS`.
3. Handle the tool name in the execution switch, dispatching to a Rust command.
4. Mention it in the base prompt if its use is not obvious from the schema.

### Adding a view

`activeView` is a union type — widen it, add a sidebar entry, add a tab, add a render branch, and extend the status-bar expression. All five live in `App.tsx`; the type checker will find the ones you miss.

### Adding a platform

Implement the branches in `shell()`, `harden()`, `kill_port`, `check_port`, and `stop_claude`, then add the runner to the CI matrix. There is no sixth place to change.

---

## 17. Troubleshooting from the inside

| Symptom | Cause | Fix |
|---|---|---|
| "Failed to start claude" | `claude` not on the `harden()`-built PATH | verify `claude --version` in a terminal; add the install prefix to `harden()` if it lives somewhere unusual |
| Chat hangs, no tokens | CLI awaiting auth, or stdin never closed | `claude login`; confirm the writer thread drops stdin |
| Reply from a stopped request appears | `requestId` filter bypassed | check the guard in the `claude-stream` listener |
| Window freezes during an operation | a synchronous command doing blocking work | make it `async` + `spawn_blocking` |
| Rust change has no effect | dev mode only hot-reloads the frontend | `cargo build`, relaunch, confirm binary mtime is newer than process start |
| Windows: console flash on every git call | `harden()` not applied to that spawn | route it through `shell()` or call `harden()` |
| Windows: paths render with `/` | a literal `"/"` in the frontend | replace with `joinPath` / `basename` / `dirname` |
| Startup tabs open the wrong files | name sort, not mtime | rename to sort correctly, or use explicit `path` specs |
| Blank window on launch | Vite not up on 1420 | `npx kill-port 1420`, restart |
| Git panel says "relaunch needed" | running binary predates the git commands | rebuild |

---

## 18. Design decisions and their history

**Why the Claude CLI instead of the API?** No key management, no billing integration, no auth flow to build. The CLI already solves all three, and its sessions, model access, and updates come free. The cost is a hard dependency on an external binary and its stdout format.

**Why stdin for the prompt?** Because the alternative was a live shell-injection bug. An early build interpolated the prompt into `sh -c`, and backticks in a conversation executed as commands in the user's home directory. Stdin makes the class of bug structurally impossible.

**Why `exec` on Unix?** So the tracked pid is the CLI's rather than an intermediate shell's, which makes Stop a single signal instead of a tree walk. Windows lacks it, hence `taskkill /T`.

**Why three threads in the bridge?** stdin, stdout, and stderr must be serviced concurrently. Reading stdout to completion before draining stderr deadlocks the moment the CLI writes more than a pipe buffer's worth of diagnostics.

**Why is `list_dir` missing mtime?** It predates any need for it, and adding it would change the shape every caller destructures. The startup-tab sort works around it with numeric-aware name ordering. Worth revisiting if a second caller needs timestamps.

**Why a git subcommand allowlist rather than blocking dangerous flags?** Allowlists fail closed. `--force` is not the only way to lose work, and enumerating the safe operations is a shorter, more auditable list than enumerating the unsafe ones.

**Why one 1200-line `App.tsx`?** Two views, one chat loop, shared state. Splitting it would mean lifting state into a store and threading it back down — more total code, more indirection, for a file that fits in one editor buffer. This is a real threshold, not a permanent answer: a third or fourth view is the point to split.

**Why no tests?** There are none, and that is a genuine gap rather than a considered position. The highest-value additions would be unit tests for `platform.ts`'s path helpers (pure functions, both separator conventions) and for the stream-event parser (fixture JSON lines in, rendered state out). Both are testable without a window.
