# c-saver for the local Codex CLI

The Codex package requires Node 24+ on `PATH`. The standalone commands also work directly from this checkout.

The `PreToolUse` hook is c-saver's runtime integration for Codex. It reduces tool-result context when it intercepts a supported read. The [paired benchmark](codex-verification.md#paired-guard-benchmark) measures that effect independently of Codex's native output budget.

## Install and remove

From the root of this checkout:

```sh
codex plugin marketplace add .
codex plugin add c-saver@c-saver-local
codex plugin list --marketplace c-saver-local
```

Start a fresh Codex session and ask it to use the `c-saver-audit` skill. Use `/hooks` to review and trust the bundled `PreToolUse` hook if you want the shell guards. Change a hook's trust or enabled state in `/hooks` when needed. The audit works independently of the hook.

To remove the plugin and its marketplace entry:

```sh
codex plugin remove c-saver@c-saver-local
codex plugin marketplace remove c-saver-local
```

Restart existing Codex sessions after package or trust changes. Notes you explicitly saved live under `$CODEX_HOME/c-saver/handoffs` (default Codex home is `~/.codex`). Use the standalone `handoff delete` command to remove a saved note.

## Opt in to shell read guards

Set the environment variable for the shell that launches Codex. In PowerShell:

```powershell
$env:C_SAVER_CODEX_GUARDS = '1'
codex
```

In a POSIX shell:

```sh
C_SAVER_CODEX_GUARDS=1 codex
```

The hook looks for single literal-path commands. Covered forms include `cat "path"`, `head -n 10 "path"`, `tail -n 10 "path"`, and on Windows `Get-Content -LiteralPath "path"` with optional `-Tail` or `-TotalCount`. It denies direct `.env` and `.env.*` reads, with exceptions for common placeholder suffixes. It also detects direct reads of files in generated directories and whole reads of files over 40,000 bytes or known lockfiles and minified output. Bounded reads of ordinary large files and search exclusions pass through.

Pipelines, compound commands, globs, inherited shell functions, patch edits, and other tool paths are outside the guard's coverage. Codex sandboxing and permissions provide the access controls. A missing runtime or invalid hook response can leave a tool call to normal Codex handling.

Unset the variable and start a new session to switch off c-saver guards independently of other hooks. In PowerShell use `Remove-Item Env:C_SAVER_CODEX_GUARDS`. In a POSIX shell use `unset C_SAVER_CODEX_GUARDS` if it was exported.

## Audit instructions

```sh
node codex/cli.mjs audit --cwd .
node codex/cli.mjs audit --cwd . --root . --max-bytes 16384 --fallback TEAM.md
```

The report lists candidates in discovery order with byte counts, approximate tokens, and large or duplicate files. It reads files on disk using the supplied root, project byte budget, and fallback filenames. By default it looks for the nearest `.git` marker, uses a 32 KiB project budget, and omits custom fallbacks. A project override can shadow lower-priority files in its directory even when it is empty. Pass your effective settings explicitly if they differ. Codex session state, trust, and config layers can affect the actual prompt, so the output is a candidate report.

## Use Codex's output budget and status

```sh
codex -c tool_output_token_limit=2048
```

This example sets the per-tool history budget to 2,048 tokens for that invocation. A smaller limit can remove diagnostic lines. Prefer quiet command options and narrow outputs when those lines matter. Drop the override to resume your usual configuration. If you want a different auto-compaction threshold, pass `-c model_auto_compact_token_limit=<tokens>` with your chosen absolute token count. Remove a persistent override from the file where you added it.

Use `/statusline` for available footer fields and `/status` for session details. Use `/usage` where the client exposes it.

## Report usage and save a handoff

```sh
node codex/cli.mjs usage events.jsonl
codex exec --json "Summarize this repository" | node codex/cli.mjs usage -
node codex/cli.mjs handoff path --cwd .
node codex/cli.mjs handoff read --cwd .
```

Usage reads one `codex exec --json` stream at a time and reports completed-turn counters with coverage. Cached input and reasoning output are subsets of input and output, respectively. A saved event stream can contain command results and messages. The reporter does not create a copy or print the event contents.

Ask Codex to use `c-saver-handoff` to review and save a note, or pipe approved UTF-8 Markdown to `node codex/cli.mjs handoff save --cwd .`. A save replaces the current worktree's note, up to 16 KiB. Use `handoff read` in a fresh session for explicit retrieval, and `handoff delete` for explicit removal. c-saver leaves these notes out of startup context.

See the [verification results](codex-verification.md) for tested clients and platforms.

## Distribution

c-saver uses a local marketplace for Codex. OpenAI's public Plugin Directory excludes packages that contain lifecycle hooks, including this bundle. [OpenAI submission rules](https://developers.openai.com/plugins/deploy/submission)
