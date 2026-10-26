// The replay through its CLI on the made-up fixtures: node --test bench/
// .mjs, not .test.ts: `claude plugin test .` runs the mod's tests, these run in plain Node.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const BENCH = import.meta.dirname
const FIXTURES = join(BENCH, 'fixtures')

/** Runs the CLI on the named fixtures alone; returns its stdout and results.json. */
const run = (...names) => runWith([], ...names)

/** run, with the mod's status line file present for the `lines` session ids. Never reads the real ~/.claude. */
function runWith(lines, ...names) {
  const dir = mkdtempSync(join(tmpdir(), 'c-saver-replay-'))
  const src = join(dir, 'sessions')
  const ctx = join(dir, 'ctx')
  const out = join(dir, 'results.json')
  mkdirSync(src)
  mkdirSync(join(ctx, 'line'), { recursive: true })
  for (const id of lines) writeFileSync(join(ctx, 'line', `${id}.txt`), '')
  for (const n of names) copyFileSync(join(FIXTURES, `${n}.jsonl`), join(src, `${n}.jsonl`))
  const p = spawnSync(process.execPath, ['--no-warnings', join(BENCH, 'replay.ts'), '--dir', src, '--ctx', ctx, '--out', out],
    { encoding: 'utf8' })
  assert.equal(p.status, 0, p.stderr)
  return { stdout: p.stdout, json: readFileSync(out, 'utf8'), r: JSON.parse(readFileSync(out, 'utf8')) }
}

const ALL = readdirSync(FIXTURES).filter(f => f.endsWith('.jsonl')).map(f => f.replace(/\.jsonl$/, ''))
const events = r => Object.fromEntries(Object.entries(r.group_a.savers).map(([k, x]) => [k, x.events]))
const none = { trim: 0, folder: 0, whole: 0, reread: 0 }

test('each fixture fires its own saver, with known numbers', () => {
  const trim = run('a-trim').r.group_a.savers.trim
  assert.deepEqual(events(run('a-trim').r), { ...none, trim: 1 })
  assert.equal(trim.tokens, 2058)
  // 2 later calls before the auto-compact, at 10% of $2 per 1M input tokens
  assert.ok(Math.abs(trim.carried_usd - 2058 * 2e-6 * 0.1 * 2) < 1e-12)
  assert.deepEqual(events(run('a-folder').r), { ...none, folder: 1 })
  assert.equal(run('a-folder').r.group_a.savers.folder.tokens, 514)
  assert.deepEqual(events(run('a-lockfile').r), { ...none, whole: 1 })
  assert.equal(run('a-lockfile').r.group_a.savers.whole.tokens, 2845)
  // Read twice unchanged fires once; the read after the Edit does not
  assert.deepEqual(events(run('a-reread').r), { ...none, reread: 1 })
  assert.equal(run('a-reread').r.group_a.savers.reread.tokens, 19)
  const s = run('a-secrets').r.group_a
  assert.deepEqual(events({ group_a: s }), none)
  assert.deepEqual(s.secrets, { env_reads: 1, key_writes: 1 })
})

test('the clean session gives zero', () => {
  const { r } = run('clean')
  assert.deepEqual(events(r), none)
  assert.deepEqual(r.group_a.secrets, { env_reads: 0, key_writes: 0 })
  assert.equal(r.group_a.sessions, 1)
  assert.equal(r.group_b.sessions, 0)
  assert.equal(r.skipped_lines, 1)
  assert.deepEqual(r.unknown_entries, { 'file-history-snapshot': 1 })
})

test('a session counts as on only with a sign: a note, its status line file, or its tool', () => {
  assert.deepEqual(run('b-focus').r.group_b.signs, { note: 1, line: 0, tool: 0 })
  assert.deepEqual(run('b-tool').r.group_b.signs, { note: 0, line: 0, tool: 1 })
  // No events is not "off": the same clean session is on once the mod's status line file shows it loaded
  assert.equal(run('clean').r.group_b.sessions, 0)
  const { r, stdout } = runWith(['clean'], 'clean')
  assert.deepEqual(r.group_b.signs, { note: 0, line: 1, tool: 0 })
  assert.equal(r.group_a.sessions, 0)
  assert.doesNotMatch(stdout, /c-saver off/)
})

test('sessions recorded with c-saver on are reported apart', () => {
  const { r, stdout } = run(...ALL)
  assert.equal(r.sessions, 9)
  assert.equal(r.group_a.sessions, 6)
  assert.equal(r.group_b.sessions, 3)
  assert.deepEqual(r.group_b.savers, { trim: { events: 1, tokens: 3100 }, folder: { events: 1, tokens: 0, unsized: 1 },
    whole: { events: 1, tokens: 12500 } })
  assert.deepEqual(r.group_b.secrets, { env_reads: 1, key_writes: 0 })
  // Group B's own tokens never reach Group A's totals
  assert.equal(Object.values(r.group_a.savers).reduce((t, x) => t + x.tokens, 0), 2058 + 514 + 2845 + 19)
  assert.match(stdout, /Group A \(no sign of c-saver, so on or off is unknown\): 6 sessions/)
  assert.match(stdout, /Group B \(c-saver on\): 3 sessions/)
})

test('privacy: no fixture content reaches stdout or results.json', () => {
  const { stdout, json } = run(...ALL)
  const strings = new Set()
  const collect = v => {
    if (typeof v === 'string') for (const line of v.split('\n')) { if (line.trim().length >= 6) strings.add(line.trim()) }
    else if (v && typeof v === 'object') Object.values(v).forEach(collect)
  }
  for (const n of ALL) {
    for (const line of readFileSync(join(FIXTURES, `${n}.jsonl`), 'utf8').split('\n')) {
      let e
      try { e = JSON.parse(line) } catch { continue }
      for (const b of Array.isArray(e?.message?.content) ? e.message.content : []) {
        if (b.type === 'tool_use') collect(b.input)
        if (b.type === 'tool_result') collect(b.content)
      }
    }
  }
  assert.ok(strings.size > 50)
  for (const s of strings) {
    assert.ok(!stdout.includes(s), `stdout holds fixture text: ${s.slice(0, 40)}`)
    assert.ok(!json.includes(s), `results.json holds fixture text: ${s.slice(0, 40)}`)
  }
  for (const word of ['/fake/', 'fake-app', 'left-pad', 'widget-', 'API_URL', 'AKIA']) {
    assert.ok(!stdout.includes(word) && !json.includes(word), word)
  }
})
