# BFD Changelog

## [0.16.0] - 2026-09-22

### Features
- **C** button in the title bar opens a color-preset picker. A preset is a name plus three hex values — **Primary**, **Secondary**, **Tertiary** — which map onto BFD's three background layers (main surface / sidebar + panels / title bar + terminal). **Apply** repaints the window instantly, and also saves the preset under its name; unnamed drafts apply without being saved. Presets and the active pick persist in `localStorage` (`bfd-theme-presets`, `bfd-theme-active`), and the saved preset is painted before React's first render so a light theme never flashes dark on launch
- Foregrounds are derived, not configured: `src/theme.ts` picks white or black text **per surface** by WCAG contrast, so a light title bar on a dark window gets black text while the window keeps white. Borders, hovers and muted text are blends of each surface with its own foreground; the accent is the most colorful of the three chosen colors pushed to ≥4.5:1 against the main background (a near-neutral palette falls back to BFD's blue, so the stock "BFD Dark" preset reproduces the original window exactly). Semantic green/red/yellow keep their hue but are re-lit for the new background, and Monaco switches between `vs` and `vs-dark`
- `App.css` panels on the secondary/tertiary layers now re-point `--text-*`, `--border` and `--bg-hover` at their own surface's vars, so existing rules keep working unchanged while their text follows the background it is drawn on. All fallbacks are the stock palette

## [0.15.0] - 2026-09-12

### Features
- Agents registry: `workbench/AGENTS.md` catalogs every agent BFD's Agent mode can discuss, grouped under `## Project:` / `## Agent Group:` headings — Claude Code's stock subagents plus your own agent definitions in `agents/`
- Agent-mode picker: clicking **Agent** in the mode bar no longer jumps straight into a generic "list everything" kickoff. It now opens an enumerated popover of the registry's projects/agent groups (parsed live from `AGENTS.md`), with **New** always last for scaffolding something not in the registry yet. Picking an entry loads agent `.md` files as before, but the kickoff message is scoped to that pick
- 🤖 **Active Agents** tab: a read-only snapshot of everything agent-shaped currently running in the background — launchd daemons, live `claude` processes classified as BFD sessions vs. headless bridges, other background worker processes, and the registry cross-referenced against what's actually alive. Data loads when the tab opens and changes only on ⟳ Refresh; no Rust changes, no relaunch needed

## [0.12.0] - 2026-08-01

### Features
- Startup tabs: BFD auto-opens a configured set of editor tabs on every launch, read from `.bfd/startup_tabs.json`. Spec forms per entry: `{ path }` (exact file), `{ dir, limit }` (newest N files in a folder), `{ dir, file, limit, exclude }` (that file inside each of the newest N subfolders, skipping excluded names like `archive`). "Newest" is a numeric-aware name sort, so ISO-date filenames and numbered folders both order correctly. Missing config or folders are skipped silently; launch lands on the first tab with Chat one click away

## [0.11.0] - 2026-07-27

### Features
- Git integration: sidebar Git panel — branch, dirty count (tracked files), ahead/behind, last commit; Status / Log / Diff / Pull / Push buttons, commit-all with a message box, Init for non-repos, one-field remote setup; command output in a mini console under the controls
- Backed by two new Rust commands: `git_overview` (one-call repo summary) and `git_run` (allowlisted git subcommands only). git spawns with argument vectors — nothing from the UI passes through /bin/sh (the 0.9.0 rule) — and both commands are async so network pushes/pulls never freeze the UI (the 0.8.0 lesson)
- Push auto-retries with `-u origin <branch>` when the branch has no upstream yet
- New UI on an old binary degrades gracefully: the panel shows a "relaunch BFD.app" notice instead of erroring

## [0.10.0] - 2026-07-14

### Features
- Operating-mode bar across the top: three segmented button groups (Memory / Interaction / Approval), one active option per class, persisted in localStorage, applied from the next message; buttons lock while a reply streams
  - **Memory** — Standard (history + memory files, as before) / Amnesia (each prompt is a fresh context: no conversation history, no memory files sent; the visible transcript still displays and records everything, so switching back to Standard resumes the thread)
  - **Interaction** — Chat (as before) / Agent (loads agent `.md` files from `~/.claude/agents/` or the repo's `agents/` folder into context — not into tabs — then BFD proactively opens a discussion about using existing agents or creating a new project with new agents; if none exist it offers to create the first one)
  - **Approval** — YOLO (act immediately, as before) / Standard (reply with a plan and ask before acting) / Caution (plan first, then confirm each meaningful action individually)

## [0.9.0] - 2026-07-13

### Features
- Live streaming chat: your prompt posts immediately and the reply streams in as it's written
- Simplified activity feed while Claude works ("Reading App.tsx", "Running a command…"), driven by the CLI's stream-json events — like claude.ai, but lighter
- Stop button cancels a response mid-flight (kills the CLI process)
- Graceful fallback: if the app binary predates this version, chat still works (temp-file prompt passing) and tells you to relaunch

### Fixes
- SECURITY: prompts were shell-interpolated via `echo "..." | claude`, so backticks or `$( )` in chat text executed as real shell commands and mangled history. Prompts now go to the CLI via stdin; nothing from chat touches /bin/sh.
- Prompt no longer visible in `ps` output or limited by ARG_MAX
- Removed the dead 3-minute abort timer that never actually cancelled the request

## [0.8.0] - 2026-07-13

### Features
- Model selector variants: Fast/Max effort levels per model (e.g. "Fable 5 - Fast"), mapped to Claude CLI `--effort` (no `--fast` flag exists in print mode)
- Chat input auto-grows up to 8 lines before scrolling
- Simplified live status indicator (pulsing dot + activity text like "Reading a file…") replaces braille spinner
- Status bar shows project name when project context is loaded

### Fixes
- App no longer beachballs during Claude calls: `run_command` is now async (`spawn_blocking`) instead of blocking the main thread

## [0.7.0] - 2025-05-03

### Features
- BFD Workbench desktop app (Tauri + React + TypeScript)
- Chat interface powered by Claude CLI (local)
- Monaco code editor with multi-language syntax highlighting
- Integrated terminal panel with shell execution
- File browser with directory navigation
- Hybrid memory system (global + per-project context)
- Tool calling: read/write files, run commands, manage processes
- Activity indicators (spinner, elapsed time, tool progress)
- Background process support for dev servers
- Port management (check/kill)
- Auto-context injection (active file in system prompt)
- Conversation history with token management
