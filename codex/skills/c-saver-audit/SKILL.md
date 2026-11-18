---
name: c-saver-audit
description: Estimate the context cost of Codex project instructions and find large or duplicate instruction files. Use when asked to audit Codex startup context or AGENTS.md.
---

Resolve `../../cli.mjs` relative to this skill file's directory. Run `node "<resolved script path>" audit --cwd "<current project directory>"` using Node 24 or newer. If the user supplies effective Codex instruction settings, pass them using the options shown by `node "<resolved script path>" --help`. Treat the result as a scan of files on disk. Summarize their order, size, and findings without reading back their contents or editing the files.
