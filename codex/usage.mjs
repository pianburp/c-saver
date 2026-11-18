import { createReadStream } from 'node:fs'

const MAX_LINE = 1024 * 1024
const fields = {
  input_tokens: 'Input tokens',
  cached_input_tokens: 'Cached input tokens (included in input)',
  output_tokens: 'Output tokens',
  reasoning_output_tokens: 'Reasoning output tokens (included in output)',
}

async function* eventLines(stream) {
  let line = ''
  let overflow = false
  stream.setEncoding('utf8')
  for await (const chunk of stream) {
    const parts = chunk.split('\n')
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        yield overflow ? null : line
        line = ''
        overflow = false
      }
      if (overflow) continue
      if (line.length + part.length <= MAX_LINE) line += part
      else {
        line = ''
        overflow = true
      }
    }
  }
  if (line || overflow) yield overflow ? null : line
}

export async function reportUsage(file) {
  const totals = Object.fromEntries(Object.keys(fields).map(field => [field, { total: 0n, observed: 0 }]))
  let threadStarted = false
  let open = false
  let completed = 0
  let incomplete = 0
  let ignored = 0
  let malformed = 0
  let additionalStream = false
  const stream = file === '-' ? process.stdin : createReadStream(file)
  for await (const line of eventLines(stream)) {
    if (line === null) {
      malformed++
      continue
    }
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      malformed++
      continue
    }
    switch (event?.type) {
      case 'thread.started':
        if (threadStarted || completed || open || incomplete) additionalStream = true
        threadStarted = true
        break
      case 'turn.started':
        if (open) incomplete++
        open = true
        break
      case 'turn.failed':
        if (open) incomplete++
        else ignored++
        open = false
        break
      case 'turn.completed':
        if (!open) {
          ignored++
          break
        }
        open = false
        completed++
        for (const [field, result] of Object.entries(totals)) {
          const value = event.usage?.[field]
          if (!Number.isSafeInteger(value) || value < 0) continue
          result.total += BigInt(value)
          result.observed++
        }
        break
      default:
        ignored++
    }
    if (additionalStream) break
  }
  if (open) incomplete++
  const lines = ['Observed Codex usage', `Completed turns: ${completed}`, `Failed or incomplete turns: ${incomplete}`]
  for (const [field, label] of Object.entries(fields)) {
    const { total, observed } = totals[field]
    lines.push(`${label}: ${observed ? total : 'unavailable'} (${observed}/${completed} completed turns)`)
  }
  lines.push(`Other events skipped: ${ignored}. Malformed or oversized lines: ${malformed}.`)
  if (additionalStream) lines.push('Stopped at a second stream header. Supply one codex exec --json stream at a time.')
  return lines.join('\n')
}
