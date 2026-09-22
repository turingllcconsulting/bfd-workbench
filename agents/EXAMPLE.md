---
name: example-agent
description: Template agent definition. Copy this file, rename it, and describe here WHEN the agent should be used — this description is what BFD's Agent mode (and Claude Code's subagent picker) matches against.
tools: Read, Bash
---

You are an example agent. Replace this body with the agent's actual working
instructions: what it owns, how a session starts, and what it must never do.

A structure that works well in practice:

## Start of every session

Where to look first — a status file, a database, a log — before doing
anything, so every session begins grounded in current state instead of
assumptions.

## Process

The loop the agent runs, step by step, with exact commands where they matter.

## Locked — do not re-litigate

Decisions already made, with the date and the reason. An agent that re-opens
settled questions wastes every session it runs in.

---

To make the agent selectable in BFD's Agent-mode picker, register it in
`workbench/AGENTS.md` under a `## Project:` or `## Agent Group:` heading.
