# Codex benchmarks and compatibility

The smoke harness uses Codex CLI with a deterministic local Responses fixture, a disposable Git repository and Codex home, and synthetic command output. It inspects what the client sends on the next model request. It does not require an account or contact a hosted model.

## Reproduce

```sh
node --test "codex/test/*.test.mjs"
node codex/test/smoke.mjs
```

If the Windows binary is outside the npm layout, set `C_SAVER_CODEX_BIN` to its absolute path. The harness selects the unelevated Windows sandbox and read-only permissions for the disposable fixture. It first exercises Codex's default unreviewed-hook behavior. For subsequent fixture cases it uses the one-shot hook trust override with its own reviewed bundle. The user-facing install flow uses `/hooks`. [Hook runtime and trust](https://learn.chatgpt.com/docs/hooks)

## Paired guard benchmark

The harness starts a fresh session for each command. Both runs use the same installed plugin, prompt, synthetic file, shell command, and default Codex output budget. The only change in each pair is `C_SAVER_CODEX_GUARDS=0` or `1`. The fixture checks that a baseline result contains file content and that the guarded result comes back before any shell execution. It also checks that a five-line read of the ordinary large log still returns those lines with the guard on.

Windows PowerShell, Codex CLI `0.169.0`, Node `24.6.0`, tiktoken `0.14.0`.

| Command (PowerShell) | Guard off (bytes / tokens) | Guard on (bytes / tokens) | Tokens avoided |
| --- | ---: | ---: | ---: |
| `Get-Content -LiteralPath "dist/build.log"` | 4,575 / 1,395 | 182 / 40 | 1,355 |
| `Get-Content -LiteralPath "alternate.log"` from the tool's alternate working directory | 40,214 / 12,022 | 178 / 40 | 11,982 |

The counts use the tool-result text Codex supplied in the next Responses request, after Codex applied its normal output budget. They include the shell result or denial as sent, and exclude request framing, system instructions, skill metadata, subsequent commands, and cache effects. The fixture uses scripted responses, so it does not measure how often real sessions attempt these reads, how the model responds to a denial, or net usage and cost.

The default run prints UTF-8 bytes. To reproduce token counts, install `tiktoken==0.14.0` in a Python environment and point `C_SAVER_TIKTOKEN_PYTHON` at that environment's Python executable before running the same smoke command. Token counting uses `o200k_base` locally. Its vocabulary may download on first use. [OpenAI tokenizer](https://github.com/openai/tiktoken)

## Results

Windows PowerShell, Codex CLI `0.169.0`, Node `24.6.0`.

| Check | Result |
| --- | --- |
| Marketplace and plugin | Registered the marketplace with `codex plugin marketplace add .`, installed the plugin twice to the same cache path, and verified the enabled entry in `codex plugin list`. After the source marketplace moved away, Codex discovered both skills from the cache, ran the bundled hook, and the listing assets were present in the cached bundle. The cache path contained spaces. Verified disabling the plugin in the isolated config and removing the installation and marketplace. |
| Instruction audit | The provider request included global, project-root, and nested override instructions, and omitted the shadowed project file. Codex ran the installed audit script from a nested directory. Node fixtures cover a custom fallback, an empty override, a tight byte budget, and counts-only output. |
| Shell guard | The CLI denied `Get-Content -LiteralPath ".env"` before a shell execution event and allowed the placeholder read. With the c-saver environment variable off the hook passed through. The `Bash` hook received only `tool_input.command`, and `cwd` matched the tool's directory when it differed from the launch directory. The hook denied a relative whole-file read of the synthetic 900-line log in that directory. |
| Native output budget | For a command ending with exit code 9, the model-facing result measured 18,142 serialized characters by default and 2,266 with `tool_output_token_limit=512`. The cap removed the synthetic middle error from that model result. The CLI JSONL still reported the middle error and exit code 9. |
| Offline usage | The reporter consumed real `codex exec --json` events from the fixture provider and matched the input and reasoning counts. Node fixtures check repeated completion events, a second stream header, malformed input, absent fields, and privacy. |
| Handoff | Saved an approved synthetic note and explicitly read it from a fresh Codex session. It was absent from that session's initial provider request. Node fixtures exercise replacement, deletion, oversized input, and isolation across Git worktrees. |
| Tests | All five Codex Node tests passed on Windows. The repository includes Node CI jobs for Windows, Linux, and macOS. |

`0.169.0` detected the Codex-native manifest and used its explicit skill and hook paths. The Windows hook loader resolves the installation directory in Node so the path works from the client's command shell. The smoke harness verifies skill discovery and command execution under a deterministic provider. Skill selection and instruction following by a hosted model still need a follow-up check.

## Output trimming

c-saver uses Codex's native output budget for commands that run. In the fixture, a custom `PostToolUse` replacement dropped the exit marker for a failed command. At a 512-token budget, the diagnostic in the middle of the output was already absent when the hook received it.

## Compatibility limits

The end-to-end results cover `codex exec` on Windows. Interactive hook review, Desktop, IDE, Linux, and macOS installation and hook behavior still need end-to-end testing.
