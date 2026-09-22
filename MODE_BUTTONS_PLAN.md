# BFD Operating Modes — Implementation Instructions

> **Status:** DONE — executed 2026-07-14, shipped as v0.10.0. Decisions made at execution time are recorded in the Execution Record at the bottom.

## Goal

Add a row of mode buttons across the top of the BFD Workbench UI. There are **three classes** of operating modes. Exactly **one option per class** is active at any time (radio-button behavior within each class). The selected combination changes how the assistant behaves for every subsequent prompt.

## Mode Classes

### Class I — Memory
| Option | Default | Behavior |
|---|---|---|
| **Standard** | ✅ | Current behavior: conversation history and memory files are loaded into context as they are now. |
| **Amnesia** | | No memory. Every prompt is a completely separate interaction — no conversation history, no memory files injected. Each send starts a fresh context. |

### Class II — Interaction
| Option | Default | Behavior |
|---|---|---|
| **Chat** | ✅ | Current behavior — normal conversational assistant (confirm with Adam this matches his understanding; he believes this is how we work today, and I believe he's right). |
| **Agent** | | On selection: the app opens the existing agent `.md` files in the background (load them into context, not necessarily into visible tabs), then the assistant proactively starts a conversation with the user about (a) how to use the existing agents, or (b) creating a new project with new agents. |

### Class III — Approval
| Option | Default | Behavior |
|---|---|---|
| **YOLO** | ✅ | Current behavior: no approval requests. Act immediately, never ask before writing files or running commands. |
| **Standard** | | Come back with a plan first and ask how to proceed before acting. |
| **Caution** | | Like Standard but much stricter — plan first, ask before every meaningful action (file writes, command execution, deletions), confirm each step. |

## Implementation Notes (for future me)

- **App location:** `/Users/rowe/BFD/workbench/` — Vite + React (`src/App.tsx`) with Tauri backend (`src-tauri/`).
- **UI:** Button bar across the top of the window. Three visually distinct groups (Class I / II / III), segmented-control style. Active option highlighted. Defaults on launch: Standard / Chat / YOLO.
- **State:** Mode selection should persist (e.g. localStorage or existing settings mechanism) — verify what BFD already uses before adding a new one.
- **Prompt plumbing:** The selected modes must alter the system prompt / context assembly sent to the Claude CLI:
  - *Amnesia*: skip injecting conversation history and memory files (`/Users/rowe/bfd/.bfd/global.md`, `.bfd/context.md`).
  - *Agent*: find and load the existing agent md files (locate them first — likely under `.claude/agents/` or a BFD-specific folder; verify), and inject an instruction telling the assistant to open the agent discussion.
  - *Standard/Caution (Class III)*: inject approval-behavior instructions into the system prompt; YOLO injects nothing (current behavior).
- **Rust changes** (if any Tauri command changes are needed) require `cargo build` and app relaunch.
- **Never edit `App.tsx` mid-turn** — stage changes and do a delayed swap (per established BFD workflow).
- Before building, read `src/App.tsx` and the prompt-assembly code in `src-tauri/` to see how the system prompt is currently constructed, and reuse that path rather than inventing a parallel one.

## Open Questions to Confirm with Adam at Execution Time

1. Where do the agent md files live (for Class II Agent mode)?
2. Should mode changes take effect mid-conversation or only on new conversation?
3. In Amnesia mode, should the visible chat transcript still display history (UI only) even though it isn't sent to the model?

## Execution Record (2026-07-14)

Executed autonomously; Adam wasn't available mid-task, so the open questions were resolved with defaults — all three are easy to change if he wants different behavior:

1. **Agent files:** none existed anywhere at execution time (`~/.claude/agents/` didn't exist, no BFD agents folder). Agent mode now searches `/Users/rowe/.claude/agents/` then `/Users/rowe/BFD/agents/` at click time (up to 10 `.md` files, first 6000 chars each). With none found, BFD's opener says so and offers to create the first agent or a new project — plan option (b).
2. **Effect timing:** modes apply immediately, i.e. to the next send mid-conversation. Buttons are disabled while a reply is streaming.
3. **Amnesia display:** the visible transcript keeps displaying (and recording) everything; it just isn't sent to the model. Switching back to Standard resumes with full history, including the amnesia-era turns.

Also confirmed: Chat **is** the current behavior (plain conversational loop), and YOLO **is** the current behavior — `BASE_PROMPT` is untouched; Standard/Caution inject an overriding approval section right after it.

Implementation: all frontend (`App.tsx` + `App.css`), no Rust changes, so no cargo build/relaunch needed. State persists via localStorage (`bfd-modes`) — nothing else in the app persisted settings, which is why a new mechanism was added. Selection flows through `buildSystemPrompt(modesOverride?, agentDocsOverride?)` and `chatLoop(..., opts)`; the Agent kickoff is sent as a hidden Human turn (`AGENT_KICKOFF_PROMPT`) that never renders in the transcript. Versions bumped to 0.10.0 (App.tsx ×2, tauri.conf.json) + CHANGELOG entry. Staged as `App.staged.tsx`, typechecked (`tsc --noEmit` clean), swapped in via detached delayed `mv`; pre-swap backup at `workbench/App.tsx.pre-0.10.bak`.
