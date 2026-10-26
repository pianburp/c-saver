// Replays session transcripts through c-saver's own guards and counts what they would have cut. No model calls:
// the same transcripts always give the same numbers. Prints and writes counts only, never transcript content.
// Usage: node bench/replay.ts [--dir <folder of .jsonl>] [--out <results.json>]
import { readdirSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Seen } from '../hooks/guards.ts'
import { readTranscript } from './transcript.ts'
import type { ToolCall, Transcript } from './transcript.ts'

// The mod imports './saver' with no extension (the engine resolves it); plain Node needs the .ts.
registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx) } catch (e) {
      if ((e as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND' || !/^\.\.?\//.test(spec) || /\.\w+$/.test(spec)) throw e
      return next(`${spec}.ts`, ctx)
    }
  },
})
const { bigRead, heavy, reread, secrets, shellDumps, trim } = await import('../hooks/guards.ts')
const { fmt, fmtUsd, savedUsd } = await import('../hooks/saver.ts')

const CACHE_READ = 0.1 // cache reads bill at 10% of input, as CACHE_READ_PRICE in hooks/saver.ts
// Cache writes bill at 1.25x input for the 5-minute cache, 2x for 1 hour (Anthropic's prompt caching prices).
const WRITE_5M = 1.25
const WRITE_1H = 2
// The mod's own notes in a tool result: c-saver was on. Anchored where the mod puts them (a deny is the whole result,
// in core's <tool_use_error> wrapper), so reading c-saver's own source or tests is not taken for one.
const DENY = '^(?:<tool_use_error>)?'
const TRIM_NOTE = /^\[(?:claude|c)-saver: trimmed ~([\d.]+)([kM]?) tokens/m
const SKIP_NOTE = new RegExp(`${DENY}(?:claude|c)-saver: skipped (?:[^~\\n]*~([\\d.]+)([kM]?) tokens|[\\w.-]+/, a generated folder)`)
const SECRET_NOTE = new RegExp(`${DENY}Blocked: (?:"[^"]*" holds live secrets|this write hardcodes)`)
const FOCUS_NOTE = new RegExp(`${DENY}Focus mode: write your steps first`) // no saving, but the mod was on
const SIZE: Record<string, number> = { '': 1, k: 1e3, M: 1e6 }
const SAVERS = { trim: 'output trim', folder: 'folder guard', whole: 'whole-file read', reread: 're-read' }
type Saver = keyof typeof SAVERS
type Hit = { saver: Saver | 'env' | 'keys'; tokens: number }

const tok = (s: string) => Math.floor(s.length / 4)
const unnumber = (s: string) => s.replace(/^ *\d+[\t→]/gm, '') // the Read tool's line numbers, not the file's size
const pathKey = (p: string) => p.replace(/\\/g, '/').toLowerCase()

/** What c-saver would have done with one call, in the mod's hook order: secret guard, read guards, then trim. */
function judge(c: ToolCall, seen: Seen, edits: Map<string, number>): Hit | undefined {
  const ti = c.input
  const secret = secrets(c.name, ti)
  if (secret) return { saver: secret.includes('hardcodes') ? 'keys' : 'env', tokens: 0 }
  if (['Write', 'Edit', 'MultiEdit'].includes(c.name)) {
    const key = pathKey(String(ti.file_path ?? ''))
    edits.set(key, (edits.get(key) ?? 0) + 1)
    return
  }
  const shell = c.name === 'Bash' || c.name === 'PowerShell'
  if (!shell && !['Read', 'Grep', 'Glob'].includes(c.name)) return
  const body = c.name === 'Read' ? unnumber(c.text) : c.text
  const cut = (note: string) => Math.max(0, tok(body) - tok(note)) // Claude reads the block message instead
  const folder = heavy(c.name, ti)
  if (folder) return { saver: 'folder', tokens: cut(folder) }
  if (shell) {
    // shortcut: the whole output stands in for the dumped file's size, so `cat a b` sums both; per-file needs the disk
    const big = c.isError ? undefined : shellDumps(String(ti.command ?? '')).map(f => bigRead(f, body.length, {})).find(Boolean)
    if (big) return { saver: 'whole', tokens: cut(big) }
    const t = trim(body, '')
    return t && { saver: 'trim', tokens: t.cut }
  }
  if (c.name !== 'Read' || c.isError) return
  const path = String(ti.file_path ?? '')
  const big = bigRead(path, body.length, ti)
  if (big) return { saver: 'whole', tokens: cut(big) }
  // Unchanged: no Edit, Write or MultiEdit on the file since, and the same text back.
  // shortcut: the short "file unchanged" stub core sends instead is not subtracted
  if (reread(seen, path, ti, `${edits.get(pathKey(path)) ?? 0}:${body}`)) return { saver: 'reread', tokens: tok(body) }
}

/** The events the mod left in a transcript recorded with it on; tokens only where its note states them. */
function recorded(c: ToolCall): (Hit & { sized: boolean }) | undefined {
  const trimmed = TRIM_NOTE.exec(c.text)
  if (trimmed) return { saver: 'trim', tokens: Number(trimmed[1]) * SIZE[trimmed[2] ?? '']!, sized: true }
  const skipped = SKIP_NOTE.exec(c.text)
  if (skipped) return skipped[1] ? { saver: 'whole', tokens: Number(skipped[1]) * SIZE[skipped[2] ?? '']!, sized: true }
    : { saver: 'folder', tokens: 0, sized: false }
  if (SECRET_NOTE.test(c.text)) return { saver: c.text.includes('hardcodes') ? 'keys' : 'env', tokens: 0, sized: false }
}

/** List price of a session's calls; calls on a model missing from the price table are counted, not priced. */
function spend(t: Transcript) {
  let usd = 0
  let unpriced = 0
  for (const { model, usage: u } of t.calls) {
    const input = u.input + (u.cache_write - u.cache_write_1h) * WRITE_5M + u.cache_write_1h * WRITE_1H + u.cache_read * CACHE_READ
    const price = savedUsd([['', input, 'input', ''], ['', u.output, 'output', '']], model)
    if (price === undefined) unpriced += 1
    else usd += price
  }
  return { usd, unpriced }
}

function jsonlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? jsonlFiles(join(dir, e.name))
    : e.name.endsWith('.jsonl') ? [join(dir, e.name)] : []).sort()
}

const row = () => ({ events: 0, tokens: 0, usd: 0, carried_usd: 0 })

export function replay(dir: string) {
  const a = { sessions: 0, tool_result_tokens: 0, spent_usd: 0, unpriced_calls: 0,
    savers: { trim: row(), folder: row(), whole: row(), reread: row() } as Record<Saver, ReturnType<typeof row>>,
    secrets: { env_reads: 0, key_writes: 0 } }
  const b = { sessions: 0, savers: { trim: { events: 0, tokens: 0 }, folder: { events: 0, tokens: 0, unsized: 0 },
    whole: { events: 0, tokens: 0 } } as Record<string, { events: number; tokens: number; unsized?: number }>,
    reread: 'not measured', secrets: { env_reads: 0, key_writes: 0 } }
  const projects = new Set<string>()
  const days: string[] = []
  let sessions = 0
  let skipped = 0
  const unknown: Record<string, number> = {} // entry type names only, never their content
  for (const file of jsonlFiles(dir)) {
    const t = readTranscript(file)
    skipped += t.skipped
    for (const [type, n] of Object.entries(t.unknown)) unknown[type] = (unknown[type] ?? 0) + n
    // shortcut: a subagent's transcript is replayed on its own; in the mod it shares the session's re-read memory
    const sub = pathKey(file).split('/').includes('subagents')
    if (!sub) { sessions += 1; projects.add(dirname(file)) }
    days.push(...t.calls.flatMap(c => (c.at ? [c.at.slice(0, 10)] : [])))
    const marks = t.tools.map(recorded)
    if (marks.some(Boolean) || t.tools.some(c => FOCUS_NOTE.test(c.text))) {
      if (!sub) b.sessions += 1
      for (const m of marks) {
        if (!m) continue
        if (m.saver === 'env' || m.saver === 'keys') { b.secrets[m.saver === 'env' ? 'env_reads' : 'key_writes'] += 1; continue }
        const r = b.savers[m.saver]!
        r.events += 1
        r.tokens += m.tokens
        if (!m.sized && r.unsized !== undefined) r.unsized += 1
      }
      continue
    }
    if (!sub) a.sessions += 1
    const cost = spend(t)
    a.spent_usd += cost.usd
    a.unpriced_calls += cost.unpriced
    const model = t.calls.findLast(c => c.model)?.model
    const seen: Seen = new Map()
    const edits = new Map<string, number>()
    for (const c of t.tools) {
      a.tool_result_tokens += tok(c.text)
      const hit = judge(c, seen, edits)
      if (!hit) continue
      if (hit.saver === 'env' || hit.saver === 'keys') { a.secrets[hit.saver === 'env' ? 'env_reads' : 'key_writes'] += 1; continue }
      const r = a.savers[hit.saver]
      const usd = savedUsd([['', hit.tokens, 'input', '']], model) ?? 0
      // Carried: the cut tokens also leave every later call's cache read, until the next compaction drops them anyway.
      const until = t.compacts.find(n => n > c.after) ?? t.calls.length
      r.events += 1
      r.tokens += hit.tokens
      r.usd += usd
      r.carried_usd += usd * CACHE_READ * Math.max(0, until - c.after)
    }
  }
  days.sort()
  return { sessions, projects: projects.size, from: days[0] ?? null, to: days.at(-1) ?? null, skipped_lines: skipped,
    unknown_entries: unknown, token_rule: 'chars / 4', group_a: a, group_b: b }
}

export function report(r: ReturnType<typeof replay>) {
  const a = r.group_a
  const pct = (n: number) => (a.tool_result_tokens ? `${(n / a.tool_result_tokens * 100).toFixed(1)}%` : '-')
  const usd = (n: number) => (n ? fmtUsd(n) : '$0.00')
  const rows = Object.entries(SAVERS).map(([k, name]) => [name, a.savers[k as Saver]] as const)
  const total = rows.reduce((t, [, x]) => ({ tokens: t.tokens + x.tokens, usd: t.usd + x.usd, carried: t.carried + x.carried_usd }),
    { tokens: 0, usd: 0, carried: 0 })
  const secretLine = (s: { env_reads: number; key_writes: number }) => `${s.env_reads} env-file reads, ${s.key_writes} key writes`
  const out = [
    `c-saver replay · ${r.sessions} sessions · ${r.projects} projects · ${r.from ?? '-'} to ${r.to ?? '-'}`,
    'Token counts: chars / 4. No model calls.',
    `Skipped: ${r.skipped_lines} broken lines, ${Object.values(r.unknown_entries).reduce((t, n) => t + n, 0)} entries of other types` +
      `${Object.keys(r.unknown_entries).length ? ` (${Object.entries(r.unknown_entries).sort((x, y) => y[1] - x[1])
        .map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}.`,
    '',
    `Group A (c-saver off): ${a.sessions} sessions`,
    `  ${'saver'.padEnd(16)} ${'events'.padStart(6)} ${'cut once'.padStart(10)}   share of tool output`,
    ...rows.map(([name, x]) => `  ${name.padEnd(16)} ${String(x.events).padStart(6)} ${fmt(x.tokens).padStart(10)}   ${pct(x.tokens)}`),
    `  ${'total'.padEnd(16)} ${''.padStart(6)} ${fmt(total.tokens).padStart(10)}   ${pct(total.tokens)} of ${fmt(a.tool_result_tokens)} tool-result tokens`,
    `  ${'dollars'.padEnd(16)} ${''.padStart(6)} ${usd(total.usd).padStart(10)}   of $${a.spent_usd.toFixed(2)} spent (cut once, low bound)`,
    `  ${'carried'.padEnd(16)} ${''.padStart(6)} ${usd(total.carried).padStart(10)}   estimate, at the cache-read price`,
    `  ${'secret guard'.padEnd(16)} ${secretLine(a.secrets)} (not counted as tokens)`,
    ...(a.unpriced_calls ? [`  ${a.unpriced_calls} calls on models missing from the price table are left out of the dollars.`] : []),
    '',
    `Group B (c-saver on): ${r.group_b.sessions} sessions, events the mod recorded`,
    `  ${'saver'.padEnd(16)} ${'events'.padStart(6)} ${'stated'.padStart(10)}`,
    ...Object.entries(r.group_b.savers).map(([k, x]) => `  ${SAVERS[k as Saver].padEnd(16)} ${String(x.events).padStart(6)} ` +
      `${(x.unsized === x.events && x.events ? '-' : fmt(x.tokens)).padStart(10)}${x.unsized ? `   ${x.unsized} with no size stated` : ''}`),
    `  ${'re-read'.padEnd(16)} not measured: the mod leaves no note`,
    `  ${'secret guard'.padEnd(16)} ${secretLine(r.group_b.secrets)}`,
  ]
  return out.join('\n')
}

if (import.meta.main) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
  const dir = arg('--dir') ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  const out = arg('--out') ?? join(import.meta.dirname, 'results.json')
  const r = replay(dir)
  writeFileSync(out, JSON.stringify(r, null, 2) + '\n')
  console.log(report(r))
}
