import { createHash, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { projectRoot } from './audit.mjs'

const MAX_NOTE = 16 * 1024

export function handoffPath(home, cwd) {
  if (!statSync(cwd).isDirectory()) throw new Error('The handoff working directory must be a directory.')
  const root = projectRoot(realpathSync.native(cwd))
  const key = process.platform === 'win32' ? root.toLowerCase() : root
  const hash = createHash('sha256').update(key).digest('hex')
  return join(home, 'c-saver', 'handoffs', `${hash}.md`)
}

export async function saveHandoff(path) {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > MAX_NOTE) throw new Error('The handoff exceeds the 16 KiB limit.')
    chunks.push(chunk)
  }
  const note = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  if (!note.trim()) throw new Error('Provide a nonempty handoff on stdin.')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = openSync(temporary, 'wx', 0o600)
  try {
    try {
      writeFileSync(file, note)
    } finally {
      closeSync(file)
    }
    renameSync(temporary, path)
  } finally {
    try {
      unlinkSync(temporary)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

export function readHandoff(path) {
  const file = openSync(path, 'r')
  try {
    const bytes = Buffer.alloc(MAX_NOTE + 1)
    let length = 0
    while (length < bytes.length) {
      const size = readSync(file, bytes, length, bytes.length - length)
      if (!size) break
      length += size
    }
    if (length > MAX_NOTE) throw new Error('The saved handoff exceeds the 16 KiB limit.')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
  } finally {
    closeSync(file)
  }
}
