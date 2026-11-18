import { lstatSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'

const windows = process.platform === 'win32'
const generated = new Set([
  'node_modules', '__pycache__', '.venv', 'venv', '.next', 'coverage', 'dist',
  'build', 'target', '.gradle', 'obj', '.dart_tool', windows ? 'pods' : 'Pods', 'vendor',
])
const lockfiles = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'cargo.lock',
  'composer.lock', 'gemfile.lock', 'uv.lock', 'bun.lock',
])
const wholeRead = new Set(['cat', 'get-content', 'gc', 'type'])
const boundedRead = new Set(['head', 'tail'])
const pathOption = /^-(?:literalpath|path)$/i
const countOption = /^-(?:tail|totalcount|head|first|last)$/i

// Classify single literal-path commands. Shell syntax outside this subset passes through.
function literalRead(command) {
  if (/[\r\n\0]/u.test(command)) return
  const text = command.trim()
  const token = /("[^"]*"|'[^']*'|[^ "'\t]+)(?:[ \t]+|$)/gy
  const tokens = []
  while (token.lastIndex < text.length) {
    const match = token.exec(text)
    if (!match) return
    tokens.push(match[1])
  }
  if (!tokens.length) return
  let [verb, ...args] = tokens
  if (windows) verb = verb.toLowerCase()
  if (!wholeRead.has(verb) && !boundedRead.has(verb)) return
  if (!windows && ['type', 'gc', 'get-content'].includes(verb)) return
  let bounded = boundedRead.has(verb)
  if (bounded && /^-n$/.test(args[0]) && /^\d+$/.test(args[1])) args = args.slice(2)
  if (windows && wholeRead.has(verb)) {
    if (countOption.test(args[0]) && /^\d+$/.test(args[1])) {
      bounded = true
      args = args.slice(2)
    }
    if (pathOption.test(args[0])) args = args.slice(1)
    if (args.length === 3 && countOption.test(args[1]) && /^\d+$/.test(args[2])) {
      bounded = true
      args = args.slice(0, 1)
    }
  }
  if (args[0] === '--') args = args.slice(1)
  if (args.length !== 1) return
  const path = args[0].replace(/^(["'])(.*)\1$/, '$2')
  if (!/^[\w. /:\\-]+$/u.test(path) || /^[-~]/.test(path)) return
  if (windows && (/^[/\\]{2}/.test(path) || /:/.test(path.replace(/^[a-z]:[/\\]/i, '')))) return
  if (!windows && path.includes('\\')) return
  return { path, bounded }
}

export function denyRead(command, cwd, workdir) {
  if (typeof command !== 'string' || typeof cwd !== 'string' || !isAbsolute(cwd)) return
  const read = literalRead(command)
  if (!read) return

  const name = basename(read.path)
  const envName = windows ? name.toLowerCase() : name
  if (/^\.env(?:\.[\w-]+)*$/.test(envName) && !/\.(?:example|sample|template|dist)$/i.test(envName)) {
    return 'c-saver skipped a direct .env read. Use a placeholder file or report only whether a variable is set.'
  }

  const directory = workdir === undefined ? cwd : workdir
  if (typeof directory !== 'string' || !isAbsolute(directory)) return
  const fullPath = resolve(directory, read.path)
  if (windows && fullPath.startsWith('\\\\')) return
  let file
  try {
    file = lstatSync(fullPath)
  } catch {
    return
  }
  if (!file.isFile()) return
  if (fullPath.split(windows ? /[/\\]/ : '/').some(part => generated.has(windows ? part.toLowerCase() : part))) {
    return 'c-saver skipped a read in a generated directory. Read the source or the package documentation.'
  }
  if (read.bounded) return
  const lower = name.toLowerCase()
  const media = /\.(?:png|jpe?g|gif|webp|bmp|pdf|ipynb)$/.test(lower)
  if (lockfiles.has(lower) || /(?:\.min\.(?:js|css)|\.map)$/.test(lower) || (file.size > 40_000 && !media)) {
    return 'c-saver skipped a whole-file read. Search for the relevant text or request a bounded range.'
  }
}
