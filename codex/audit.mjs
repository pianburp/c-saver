import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export const DEFAULT_BUDGET = 32 * 1024
const GLOBAL_SCAN_LIMIT = 16 * 1024 * 1024
const pathKey = path => process.platform === 'win32' ? path.toLowerCase() : path

export function projectRoot(cwd) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    try {
      statSync(join(dir, '.git'))
      return dir
    } catch {
      if (dir === dirname(dir)) return cwd
    }
  }
}

function select(dir, names, limit, warnings, fallThroughEmpty = false) {
  for (const name of names) {
    const path = join(dir, name)
    let size
    try {
      const info = statSync(path)
      if (!info.isFile()) continue
      size = info.size
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue
      warnings.add('Some candidate files could not be read.')
      return
    }
    let file
    try {
      file = openSync(path, 'r')
      const bytes = Buffer.alloc(Math.min(limit, size) + 1)
      let length = 0
      while (length < bytes.length) {
        const read = readSync(file, bytes, length, bytes.length - length, null)
        if (!read) break
        length += read
      }
      const truncated = length > limit
      const content = new TextDecoder().decode(bytes.subarray(0, Math.min(length, limit)))
      if (content.trim()) return { path, content, consumed: Math.min(length, limit), truncated }
      if (!fallThroughEmpty) {
        warnings.add('An empty or whitespace-only project file shadowed lower-priority candidates in its directory.')
        return
      }
    } catch {
      warnings.add('Some candidate files could not be read.')
      return
    } finally {
      if (file !== undefined) closeSync(file)
    }
  }
}

export function audit(cwd, { home, root = projectRoot(cwd), budget = DEFAULT_BUDGET, fallbacks = [] }) {
  if (!statSync(cwd).isDirectory()) throw new Error('The audit working directory must be a directory.')
  if (fallbacks.some(name => name !== basename(name) || /[\\/:]/.test(name) || ['.', '..', ''].includes(name))) {
    throw new Error('Fallback instruction names must be filenames.')
  }
  const dirs = [cwd]
  while (pathKey(dirs[0]) !== pathKey(root)) {
    const parent = dirname(dirs[0])
    if (parent === dirs[0]) throw new Error('The project root must contain the working directory.')
    dirs.unshift(parent)
  }

  const warnings = new Set()
  const global = select(home, ['AGENTS.override.md', 'AGENTS.md'], GLOBAL_SCAN_LIMIT, warnings, true)
  const selected = global ? [{ ...global, scope: 'global' }] : []
  const names = ['AGENTS.override.md', 'AGENTS.md', ...fallbacks]
  let remaining = budget
  for (const dir of dirs) {
    if (!remaining) break
    const file = select(dir, names, remaining, warnings)
    if (!file) continue
    selected.push({ ...file, scope: 'project' })
    remaining -= file.consumed
  }
  if (!remaining) warnings.add(budget
    ? 'The project byte budget was exhausted. Later files may be omitted.'
    : 'The project byte budget is zero. Project files were skipped.')

  const seen = new Map()
  const files = selected.map(({ content, path, scope, consumed, truncated }) => {
    const duplicateOf = content && !truncated ? seen.get(content) : undefined
    if (content && !truncated && !duplicateOf) seen.set(content, path)
    return {
      path, scope, bytes: consumed, tokens: Math.ceil([...content].length / 4), truncated, duplicateOf,
    }
  })
  return { root: resolve(root), home, budget, fallbacks, files, warnings: [...warnings] }
}
