import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url))
const hook = fileURLToPath(new URL('../hook.mjs', import.meta.url))
const windows = process.platform === 'win32'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'c-saver node test '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'Codex home')
  const repo = join(root, 'project')
  const cwd = join(repo, 'nested dir')
  mkdirSync(home)
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(repo, '.git'))
  const env = { ...process.env, CODEX_HOME: home, C_SAVER_CODEX_GUARDS: '1' }
  const invoke = (script, args, input, overrides) => spawnSync(process.execPath, [script, ...args], {
    env: { ...env, ...overrides }, input, encoding: 'utf8',
  })
  const run = (args, input) => invoke(cli, args, input)
  return { root, home, repo, cwd, run, invoke }
}

test('audit lists global override, project instructions and a fallback without printing contents', t => {
  const { home, repo, cwd, run } = fixture(t)
  const secret = 'SYNTHETIC_PRIVATE_DATA_DO_NOT_PRINT'
  writeFileSync(join(home, 'AGENTS.override.md'), secret)
  writeFileSync(join(home, 'AGENTS.md'), 'shadowed')
  writeFileSync(join(repo, 'AGENTS.md'), secret)
  writeFileSync(join(cwd, 'INSTRUCTIONS.md'), 'ééééé')
  const result = run(['audit', '--cwd', cwd, '--fallback', 'INSTRUCTIONS.md', '--max-bytes', String(secret.length + 5)])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /AGENTS\.override\.md[\s\S]+AGENTS\.md[\s\S]+INSTRUCTIONS\.md/)
  assert.match(result.stdout, /duplicates.*AGENTS\.override\.md/)
  assert.match(result.stdout, /5 bytes, ~1 tokens.*truncated/)
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret))
  writeFileSync(join(cwd, 'AGENTS.override.md'), ' \n')
  const shadowed = run(['audit', '--cwd', cwd, '--fallback', 'INSTRUCTIONS.md'])
  assert.match(shadowed.stdout, /whitespace-only project file shadowed/)
  assert.doesNotMatch(shadowed.stdout, /- project .*INSTRUCTIONS\.md/)
  const zero = run(['audit', '--cwd', cwd, '--max-bytes', '0'])
  assert.match(zero.stdout, /global.*AGENTS\.override\.md/)
  assert.doesNotMatch(zero.stdout, /- project/)
})

test('audit handles missing candidates and refuses an unrelated root or path-valued fallback', t => {
  const { home, cwd, run } = fixture(t)
  assert.match(run(['audit', '--cwd', cwd]).stdout, /No instruction candidates/)
  assert.equal(run(['audit', '--cwd', cwd, '--root', home]).status, 1)
  assert.equal(run(['audit', '--cwd', cwd, '--fallback', '../hidden']).status, 1)
})

test('opt-in hook denies clear literal reads and passes through everything outside its subset', t => {
  const { repo, cwd, invoke } = fixture(t)
  mkdirSync(join(cwd, 'node_modules'))
  writeFileSync(join(cwd, 'node_modules', 'example.js'), 'sample')
  writeFileSync(join(cwd, 'large log.txt'), 'z'.repeat(40_001))
  writeFileSync(join(cwd, 'package-lock.json'), '{}')
  const command = path => windows ? `Get-Content -LiteralPath "${path}"` : `cat "${path}"`
  const send = (cmd, { tool = 'Bash', workdir = cwd, enabled = '1' } = {}) => {
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, cwd: repo,
      tool_input: { command: cmd, workdir } })
    const result = invoke(hook, [], payload, { C_SAVER_CODEX_GUARDS: enabled })
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    return result.stdout
  }
  for (const path of ['.env', '.env.local', 'node_modules/example.js', 'large log.txt', 'package-lock.json']) {
    const { hookSpecificOutput: output } = JSON.parse(send(command(path)))
    assert.equal(output.permissionDecision, 'deny')
    assert.doesNotMatch(output.permissionDecisionReason, /example\.js|large log\.txt|\.env\.local/)
  }
  assert.equal(send(command('.env.example')), '')
  assert.equal(send(command('.env'), { enabled: '0' }), '')
  assert.equal(send(command('.env'), { tool: 'apply_patch' }), '')
  assert.equal(send(command('large log.txt'), { workdir: repo }), '')
  assert.equal(send(`${command('.env')}; echo done`), '')
  assert.equal(send(`${command('package-lock.json')} | head`), '')
  assert.equal(send('rg -g "!node_modules/**" pattern .'), '')
  assert.equal(send('cat "pack"age-lock.json'), '')
  assert.equal(send('git status'), '')
  assert.equal(send(windows ? 'Get-Content -LiteralPath "large log.txt" -Tail 2' : 'tail -n 2 "large log.txt"'), '')
  assert.equal(invoke(hook, [], '{broken').stdout, '')
})

test('usage reports coverage without double-counting or printing event content', t => {
  const { run } = fixture(t)
  const completion = { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 40, output_tokens: 10 } }
  const stream = [
    { type: 'thread.started' }, { type: 'turn.started' }, completion, completion,
    { type: 'turn.started' }, { type: 'turn.completed', usage: { output_tokens: 5, reasoning_output_tokens: 2 } },
    { type: 'turn.started' }, { type: 'turn.failed', error: 'SYNTHETIC_PRIVATE_DATA_DO_NOT_PRINT' },
    { type: 'item.completed', item: { text: 'SYNTHETIC_PRIVATE_DATA_DO_NOT_PRINT' } },
    { type: 'turn.started' },
  ].map(event => JSON.stringify(event)).join('\n')
  const result = run(['usage', '-'], `${stream}\n{"type":`)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Completed turns: 2/)
  assert.match(result.stdout, /Failed or incomplete turns: 2/)
  assert.match(result.stdout, /Input tokens: 50 \(1\/2 completed turns\)/)
  assert.match(result.stdout, /Cached input tokens \(included in input\): 40/)
  assert.match(result.stdout, /Output tokens: 15/)
  assert.match(result.stdout, /Reasoning output tokens \(included in output\): 2/)
  assert.match(result.stdout, /Malformed or oversized lines: 1/)
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_PRIVATE_DATA_DO_NOT_PRINT/)
  const combined = run(['usage', '-'], `${stream}\n${stream}\n`)
  assert.match(combined.stdout, /Stopped at a second stream header/)
  assert.match(combined.stdout, /Input tokens: 50/)
  assert.match(run(['usage', '-'], '').stdout, /Input tokens: unavailable/)
})

test('handoff explicitly saves, replaces, reads and deletes a worktree-scoped note', t => {
  const { root, repo, cwd, run } = fixture(t)
  const other = join(root, 'other worktree')
  mkdirSync(other)
  writeFileSync(join(other, '.git'), 'gitdir: example')
  const handoff = (action, directory = cwd, input) => run(['handoff', action, '--cwd', directory], input)
  assert.equal(handoff('path', cwd).stdout, handoff('path', repo).stdout)
  assert.notEqual(handoff('path', cwd).stdout, handoff('path', other).stdout)
  assert.equal(handoff('read').status, 1)
  assert.equal(handoff('save', cwd, '# Approved note\n').status, 0)
  assert.equal(handoff('read', repo).stdout, '# Approved note\n')
  assert.equal(handoff('save', cwd, 'x'.repeat(16 * 1024 + 1)).status, 1)
  assert.equal(handoff('read', other).status, 1)
  assert.equal(handoff('save', cwd, '# New note\n').status, 0)
  assert.equal(handoff('read').stdout, '# New note\n')
  assert.equal(handoff('delete').status, 0)
  assert.equal(handoff('read').status, 1)
})
