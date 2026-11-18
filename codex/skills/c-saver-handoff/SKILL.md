---
name: c-saver-handoff
description: Save, retrieve, or delete an explicit local Codex handoff for this project or Git worktree. Use when the user asks to save or resume a c-saver handoff.
---

Resolve `../../cli.mjs` relative to this skill file's directory and use Node 24 or later. Pass the current workspace using `--cwd "<current project directory>"`.

- For a save, run `node "<resolved script path>" handoff path --cwd "<current project directory>"` and show the destination. Draft the objective, current state, working files, checks, open decisions, and next steps. Show the note and obtain the user's approval to save or replace it. Pass exactly the approved Markdown as UTF-8 stdin to the same command with `handoff save`. Omit credentials and raw transcripts.
- To retrieve, use `handoff read`. Summarize the saved note and check its claims against the current workspace before using it as context.
- Use `handoff delete` only when the user asks to remove the stored note.
