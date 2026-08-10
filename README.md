# BFD Workbench

A local AI workbench: chat, code editor, terminal, and file browser in one window, wrapped around the **Claude CLI** running on your own machine.

No API key. No server. Your files never leave your computer — BFD shells out to the `claude` command you already have installed, streams the reply into the window, and gives the model tools to read and write your local filesystem.

Runs on **macOS**, **Windows**, and **Linux**.

![Stack](https://img.shields.io/badge/stack-Tauri%202%20%2B%20React%2019%20%2B%20Rust-blue) ![License](https://img.shields.io/badge/license-MIT-green)

---

## What it does

| | |
|---|---|
| 💬 **Chat** | Streaming conversation with Claude, with live activity ("Reading App.tsx", "Running a command") as the model works |
| 📝 **Editor** | Monaco (the VS Code editor) with tabs, syntax highlighting, and ⌘/Ctrl+S save |
| 🗂 **File browser** | Navigate your machine, open files into tabs, expand folders in place |
| ⌨️ **Terminal** | Run shell commands without leaving the window |
| 🌿 **Git panel** | Status, log, diff, commit, push, pull — on whatever repo you are browsing |
| 🧠 **Memory** | A global notes file plus per-project context, injected into every conversation |
| 🎚 **Operating modes** | Memory, Interaction, and Approval switches that change how much autonomy the model has |

---

## Requirements

| | macOS | Windows | Linux |
|---|---|---|---|
| Node.js 18+ | [nodejs.org](https://nodejs.org) or `brew install node` | [nodejs.org](https://nodejs.org) or `winget install OpenJS.NodeJS.LTS` | your package manager |
| Rust | [rustup.rs](https://rustup.rs) | [rustup.rs](https://rustup.rs) | [rustup.rs](https://rustup.rs) |
| Compiler toolchain | `xcode-select --install` | VS 2022 Build Tools, "Desktop development with C++" | `build-essential`, `libwebkit2gtk-4.1-dev` |
| WebView | built in | [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled on Win 11) | `webkit2gtk` |
| Claude CLI | `npm install -g @anthropic-ai/claude-code` | same | same |

Then authenticate once:

```
claude login
```

---

## Quick start

**macOS / Linux**

```bash
git clone https://github.com/turingllcconsulting/bfd-workbench.git
cd bfd-workbench
bash scripts/setup.sh      # checks and installs everything above
npm run start
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/turingllcconsulting/bfd-workbench.git
cd bfd-workbench
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
npm run start
```

The setup scripts are re-runnable — every step is skipped if the tool is already there.

Already have the prerequisites? Skip the script:

```
npm install
npm run start
```

First launch compiles the Rust backend, which takes a few minutes. After that it starts in seconds.

---

## Building an installer

```
npm run package
```

Output lands in `src-tauri/target/release/bundle/`:

- **macOS** — `dmg/BFD_1.0.0_aarch64.dmg` and `macos/BFD.app`
- **Windows** — `nsis/BFD_1.0.0_x64-setup.exe`
- **Linux** — `deb/`, `rpm/`, and `appimage/`

You can only build an installer for the OS you are on. The bundled app still needs the Claude CLI installed and logged in on the target machine.

---

## Memory

BFD reads two files and prepends them to every conversation.

| File | Scope |
|---|---|
| `~/.bfd/global.md` | Always loaded. Your name, environment, standing preferences. |
| `<project>/.bfd/context.md` | Loaded when you browse into that folder or any subfolder. |

Neither exists by default. Create them and BFD picks them up; it will also write to them if you ask it to remember something. On Windows, `~` is `%USERPROFILE%`.

---

## Operating modes

The bar above the chat box has three independent switches.

**Memory** — `Standard` sends prior turns as context. `Amnesia` sends only the current message (history is still recorded on screen).

**Interaction** — `Chat` is normal. `Agent` loads agent definition `.md` files from `~/.claude/agents` and `~/.bfd/agents` and steers the conversation toward building and using them.

**Approval** — how much BFD does without asking:

| Mode | Behavior |
|---|---|
| `YOLO` | Acts immediately. Fastest, and it will change files without checking. |
| `Standard` | Plans first, asks before anything that changes state. Reads freely. |
| `Caution` | Plans first, then confirms every single write, delete, or command. |

Selections persist across launches.

---

## Shortcuts

| | |
|---|---|
| ⌘/Ctrl + O | Open file |
| ⌘/Ctrl + N | New file |
| ⌘/Ctrl + S | Save file |
| Enter | Send message |
| Shift + Enter | Newline in the chat box |

---

## Troubleshooting

**"Failed to start claude"** — the CLI is not on the PATH the app inherits. Confirm `claude --version` works in a terminal, then relaunch BFD. GUI apps on macOS start with a reduced PATH; BFD rebuilds it to include Homebrew, cargo, and npm prefixes, but a nonstandard install location may still be missed.

**Chat returns nothing, or asks you to log in** — run `claude login`.

**Port 1420 in use** — a previous dev server is still alive. `npx kill-port 1420`, or ask BFD's terminal to free it.

**Windows: cargo fails at the link step** — the MSVC C++ build tools are missing. Install "Desktop development with C++" from the Visual Studio installer.

**Windows: a black console window flashes** — you are on a build predating the `CREATE_NO_WINDOW` fix; rebuild from `main`.

**macOS: "BFD is damaged and can't be opened"** — an unsigned local build hit Gatekeeper quarantine. `xattr -cr /Applications/BFD.app`.

---

## Security

BFD is a tool that runs commands and edits files on your machine on the model's initiative. That is the point of it, and it is also the risk. Two things worth knowing:

- Chat prompts reach the Claude CLI over **stdin**, never interpolated into a shell string — so backticks and `$( )` in a conversation cannot execute.
- The git panel runs `git` with argument vectors against an allowlist of subcommands, never through a shell.

The terminal and the model's `run_command` tool do run real shell commands with your full user privileges. Use `Standard` or `Caution` approval mode on anything you care about.

Full detail: [`docs/TECHNICAL.md`](docs/TECHNICAL.md).

---

## Docs

- [`docs/TECHNICAL.md`](docs/TECHNICAL.md) — architecture, every IPC command, the streaming protocol, prompt assembly, cross-platform strategy, extension points.

## License

MIT — see [LICENSE](LICENSE).
