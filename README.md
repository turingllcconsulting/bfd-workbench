# BFD Workbench

A local AI workbench: chat, code editor, terminal, file browser, git panel and
agent tooling in one window, wrapped around the **Claude CLI** running on your
own machine.

No API key. No server. BFD shells out to the `claude` command you already have
installed, streams the reply into the window, and gives the model tools to
read and write your local filesystem.

![Stack](https://img.shields.io/badge/stack-Tauri%202%20%2B%20React%2019%20%2B%20Rust-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## What it does

| | |
|---|---|
| 💬 **Chat** | Streaming conversation with Claude, with live activity ("Reading App.tsx", "Running a command") as the model works |
| 📝 **Editor** | Monaco (the VS Code editor) with tabs, syntax highlighting, and ⌘S save |
| 🗂 **File browser** | Navigate your machine, open files into tabs, expand folders in place |
| ⌨️ **Terminal** | Run shell commands without leaving the window |
| 🌿 **Git panel** | Status, log, diff, commit, push, pull — on whatever repo you are browsing |
| 🧠 **Memory** | A global notes file plus per-project context, injected into every conversation |
| 🎚 **Operating modes** | Memory, Interaction, and Approval switches that change how much autonomy the model has |
| 🤖 **Agent mode** | An `AGENTS.md` registry + picker for working with agent definition files, plus an **Active Agents** tab showing every agent-shaped process currently running |

## Requirements

- **macOS** (Apple Silicon or Intel). A handful of home-directory paths are
  currently hardcoded in `workbench/src/App.tsx` and
  `workbench/src/ActiveAgentsPanel.tsx` — adjust them to your machine. (A
  cross-platform 1.0.0 release is preserved earlier in this repo's history;
  its platform helpers are the donor if you want Windows/Linux support.)
- Node.js 18+ ([nodejs.org](https://nodejs.org) or `brew install node`)
- Rust ([rustup.rs](https://rustup.rs)) and `xcode-select --install`
- Claude CLI: `npm install -g @anthropic-ai/claude-code`, authenticated once

## Run it

```bash
cd workbench
npm install
npm run tauri dev
```

## Agents

Agent definitions live in `agents/` — see [`agents/EXAMPLE.md`](agents/EXAMPLE.md)
for the frontmatter + instructions shape. Register them in
[`workbench/AGENTS.md`](workbench/AGENTS.md), which the Agent-mode picker reads
directly; the Active Agents tab cross-references that registry against the
daemons and `claude` processes actually alive on the machine.

See [CHANGELOG.md](CHANGELOG.md) for the full feature history.

## License

MIT — see [LICENSE](LICENSE).
