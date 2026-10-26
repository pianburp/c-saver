// Reads one Claude Code transcript (.jsonl) into its API calls and tool calls, for bench/replay.ts.
// Dev tooling, not loaded by the mod. Result text stays in memory: nothing here prints or writes it.
import { readFileSync } from 'node:fs'

type Json = Record<string, any>

/** cache_write_1h: the part of cache_write written to the 1-hour cache, which bills higher. */
export type Usage = { input: number; cache_write: number; cache_write_1h: number; cache_read: number; output: number }
export type ApiCall = { model: string; usage: Usage; at?: string }
/** `after`: API calls made before its result came back, so `calls.length - after` later calls carried it. */
export type ToolCall = { id: string; name: string; input: Json; text: string; isError: boolean; after: number }
export type Transcript = {
  calls: ApiCall[]; tools: ToolCall[]
  compacts: number[] // API calls made before each compaction
  skipped: number // lines that are not a JSON object
  unknown: number // entries of a type the reader does not read
}

const KNOWN = new Set(['user', 'assistant', 'system', 'summary'])

// Same as resultText in hooks/saver.ts: a result is a string or a list of text blocks.
const resultText = (content: unknown) =>
  Array.isArray(content) ? content.map(c => (c && typeof c === 'object' ? String((c as Json).text ?? '') : '')).join('')
    : typeof content === 'string' ? content : ''

export function readTranscript(path: string): Transcript {
  const t: Transcript = { calls: [], tools: [], compacts: [], skipped: 0, unknown: 0 }
  const seen = new Set<unknown>() // usage repeats on every content block of one message
  const byId = new Map<string, ToolCall>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let entry: Json
    try { entry = JSON.parse(line) } catch { t.skipped += 1; continue }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { t.skipped += 1; continue }
    if (!KNOWN.has(entry.type)) { t.unknown += 1; continue }
    if (entry.compactMetadata && typeof entry.compactMetadata === 'object') t.compacts.push(t.calls.length)
    const msg = entry.message
    if (!msg || typeof msg !== 'object') continue
    const u = msg.usage
    if (msg.role === 'assistant' && u && typeof u === 'object' && !seen.has(msg.id ?? null)) {
      seen.add(msg.id ?? null)
      t.calls.push({
        model: typeof msg.model === 'string' ? msg.model : '',
        usage: { input: u.input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0,
          cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens || 0,
          cache_read: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 },
        at: typeof entry.timestamp === 'string' ? entry.timestamp : undefined,
      })
    }
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool_use') {
        const call: ToolCall = { id: String(block.id ?? ''), name: String(block.name ?? ''),
          input: block.input && typeof block.input === 'object' ? block.input : {}, text: '', isError: false, after: t.calls.length }
        byId.set(call.id, call)
        t.tools.push(call)
      } else if (block.type === 'tool_result') {
        const call = byId.get(String(block.tool_use_id ?? ''))
        if (!call) continue
        call.text = resultText(block.content)
        call.isError = block.is_error === true
        call.after = t.calls.length
      }
    }
  }
  return t
}
