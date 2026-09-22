# BFD Agents Registry

Tracks every agent BFD's Agent mode can discuss, grouped under a `## Project:`
or `## Agent Group:` heading. BFD's Agent-mode picker (the prompt that opens
when you click **Agent** in the mode bar) reads these headings directly to
build its enumerated list, with "New" always added as the last option — so
adding a project or agent group here is enough to make it selectable in the
GUI. Keep each entry short: name, where its definition lives (if any), and a
one-line purpose per agent.

## Agent Group: Claude Code Stock

Built-in Claude Code subagent types, available in every project via the
`Agent` tool. Not defined by `.md` files — these ship with Claude Code itself.

- **claude** — catch-all for anything that doesn't fit a more specific agent
- **general-purpose** — broad research / multi-step tasks, full tool access
- **Explore** — fast read-only code search (files/symbols), no edits
- **Plan** — architecture and implementation planning, no edits
- **statusline-setup** — narrow config helper for the Claude Code status line

## Project: Example

Template entry — copy this block for your first real project and point it at
your own agent definitions.

- **example-agent** (`agents/EXAMPLE.md`) — template agent definition showing
  the frontmatter + instructions shape BFD and Claude Code both read. Tools:
  Read, Bash.
