# c-saver

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Claude Code: v2.1.287+](https://img.shields.io/badge/Claude_Code-v2.1.287%2B-brightblue.svg)
![Dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg)

**Keep Claude Code sessions lean, and see what they cost while you work.**

![c-saver status line: context used, usage limits with a run-out time, prompt cache left](statusline.svg)

Every API call re-sends your CLAUDE.md, tool schemas and the whole conversation, so one noisy command is paid for again on every later call.
c-saver stops that waste before it enters context: it trims long shell output, blocks reads of generated files, and shows context, limits and cache time on the status line.

It runs inside [Claude Code](https://claude.com/claude-code) as a single plugin, with no dependencies and no daemon. Every feature has an off switch.

## Install

In Claude Code:

```
/plugin marketplace add pianburp/c-saver
/plugin install c-saver@pianburp
/saver-setup --yes
```

Restart Claude Code. Run `/saver-setup` without `--yes` first to see what it changes in `settings.json`.

## What it saves

![Bar chart: c-saver would have cut 159k of 987k tool-result tokens (16%). Output trim 116.5k, whole-file reads 25.2k, folder guard 15.3k, re-reads 2.0k.](proof.svg)

119 real sessions (14 projects, one month) were replayed through c-saver's guards, with no model calls.
The chart covers the 45 sessions that showed no sign of c-saver.
In the 74 that ran with it, the mod's own notes record 137 output trims cutting 208k tokens.

A cut token also stays out of every later call, so the real saving is larger than the chart.
Limits: one person's sessions, counted as `chars / 4`. [Method and full numbers](docs/reference.md#proof).

Measure your own sessions. It prints counts only, never their content:

```sh
node bench/replay.ts
```

## What you get

- **Status line:** context, usage limits with a run-out forecast, and a prompt cache countdown. It tells you when to `/compact` or `/clear`.
- **Output trim:** a shell output over 2k tokens is cut to its head, error lines and tail.
- **Read guards:** no reads of `node_modules`, build folders, lockfiles, minified or huge files, or unchanged files read twice.
- **Secret guard:** blocks `.env` reads and API keys written into code.
- **Auto-compact at 50%** instead of near full.
- **`/token-audit`:** lists what loads before you type and proposes cuts.
- **`/savings`:** what each saver saved this session.

Also: focus mode, `/handoff`, `/wrapped`, a pet, and an on/off switch for everything.
See the [full reference](docs/reference.md).

## What it changes

c-saver changes what Claude sees and what you see, so here is exactly how. Use `/toggle` to switch off any of its mid-session features.

- **Tool calls:** guards can block a call or shorten its output, and Claude is told when they do.
- **Focus mode (on by default):** hides tool calls and Claude's in-between text, and shows a step list instead. `ctrl+o` shows everything. Claude's first edit or command in a task is refused once until it writes its steps.
- **`settings.json`:** changed only by `/saver-setup --yes`, which backs it up first and sets auto-compact and three `.env` deny rules. The auto-compact variable is undocumented, so it may change.
- **Third-party software:** installed only if you pass `--with-plugins`, `--graphify` or `--all`. Read those projects first, because they run their own code.

## Privacy

c-saver has no telemetry, and its own code makes no network requests. The only network use is the third-party install flags above.

It reads session transcripts and instruction files on your machine, and keeps its state in `~/.claude/.statusline-ctx/`.
That folder holds the full text of trimmed shell output (last 50 outputs), which can include anything a command printed.
`/saver-setup --yes --uninstall` deletes the folder.

## Support

Report bugs and ask questions in [GitHub issues](https://github.com/pianburp/c-saver/issues).
Include your OS, Claude Code version, and the output of `/toggle`.

## License

[MIT](LICENSE)
