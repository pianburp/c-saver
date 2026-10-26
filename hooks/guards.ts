// The guards' decisions, as plain functions of a tool call: register.tsx calls them from its hooks with what $ knows
// (file sizes, stamps). No $ here, so they run outside the engine too.
import { HEAVY, NOISY, fmt } from './saver'

type Input = Record<string, unknown>

const KEEP_HEAD = 2000 // chars kept from the start of a trimmed output
const KEEP_TAIL = 4000 // chars kept from the end: errors and summaries land there
const KEEP_ERRORS = 3000 // chars of error lines kept from the cut middle
const ERROR_LINE = /error|fail|exception|traceback|panic|fatal|assert|[✗✘]/i // TypeError, FAILED, AssertionError
const BIG_READ = 40_000 // bytes (~10k tokens)
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'cargo.lock',
  'composer.lock', 'gemfile.lock', 'uv.lock', 'bun.lock'])
const MINIFIED = ['.min.js', '.min.css', '.map']
const MEDIA = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.pdf', '.ipynb']
// Shell commands that read or list files; rm, npm and the like are left alone.
export const SHELL_READ = /^(?:cat|head|tail|less|more|grep|egrep|rg|ag|find|ls|tree|du|wc|awk|sed|type|dir|gc|gci|sls|get-content|get-childitem|select-string)$/i
// The word after these names a folder to skip, not one to read: find -path, grep --exclude-dir, rg -g, tree -I.
const EXCLUDE_FLAG = /^-(?:path|ipath|wholename|name|iname|not|prune|g|-glob|-exclude|-exclude-dir|-ignore|-ignore-dir|i|exclude|e|pattern)$/i
// Their first plain word is a pattern or script, not a path.
const SHELL_SCRIPT = /^(?:grep|egrep|rg|ag|awk|sed|sls|select-string)$/i
// Whole-file dumpers: a huge log through one of these is blocked like a whole Read.
const SHELL_DUMP = /^(?:cat|type|more|less|gc|get-content)$/i
// .env, .env.local, .env.production.local at a path/word boundary; not .environment.
const ENV_FILE = /(?:^|[\s'"`=:/\\(,|])(\.env(?:\.[\w-]+)*)(?![\w-])/g
const PLACEHOLDER = /\.(example|sample|template|dist)$/i
// ponytail: well-known prefixes only, no entropy scan. Add a pattern when a new key type leaks.
const SECRETS: [string, RegExp][] = [
  ['Anthropic or OpenAI key', /\bsk-(?:ant-|proj-)?[\w-]{20,}/],
  ['Stripe live key', /\b[rs]k_live_[0-9A-Za-z]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[0-9A-Za-z]{36}|github_pat_\w{22,})/],
  ['Google API key', /\bAIza[\w-]{35}/],
  ['Slack token', /\bxox[abprs]-[0-9A-Za-z-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
]
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit']

const base = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? ''

/** Deny reason for touching .env files or writes that hardcode a credential. */
export function secrets(tool: string, ti: Input): string | undefined {
  if (WRITE_TOOLS.includes(tool)) {
    if (base(String(ti.file_path ?? '')).startsWith('.env')) return // a key in .env is where it belongs
    const edits = Array.isArray(ti.edits) ? ti.edits.map(e => (e as Input)?.new_string) : []
    const text = [ti.content, ti.new_string, ...edits].filter(Boolean).map(String).join('\n')
    const kind = SECRETS.find(([, p]) => p.test(text))?.[0]
    return kind && `Blocked: this write hardcodes a ${kind}. Anyone with the repo or its history can use it. ` +
      'Read it from an environment variable and keep the value in .env (gitignored).'
  }
  const hay = ['file_path', 'path', 'pattern', 'command', 'glob'].map(k => ti[k]).filter(v => typeof v === 'string').join('\n')
  const hit = [...hay.matchAll(ENV_FILE)].map(m => m[1] ?? '').find(f => !PLACEHOLDER.test(f))
  return hit && `Blocked: "${hit}" holds live secrets. Printing one into the transcript cannot be undone: ` +
    'the user has to rotate the credential. Read the code default, .env.example or README.md instead. ' +
    'To check a variable is set, print a boolean, never the value. Do not trust a redaction pattern.'
}

const unquote = (w: string) => w.replace(/^['"]+|['"]+$/g, '')
const heavyIn = (p: string) => HEAVY.find(d => p.replace(/\\/g, '/').split('/').includes(d))

/** Each `cmd | cmd && cmd` part of a shell command as words. */
export function shellParts(cmd: string): string[][] {
  return cmd.split(/&&|\|\||[|;&\n]/).map(s => s.trim().split(/\s+/).filter(Boolean)).filter(w => w.length)
}

/** Deny reason for a Read, Grep, Glob or shell read inside a generated folder. Other commands pass (rm -rf node_modules). */
export function heavy(tool: string, ti: Input): string | undefined {
  let dir: string | undefined
  if (tool === 'Bash' || tool === 'PowerShell') {
    // shortcut: a positive `find . -path '*/node_modules/*'` passes as an exclusion; add a check if the model uses it
    for (const [verb = '', ...args] of shellParts(String(ti.command ?? ''))) {
      if (!SHELL_READ.test(verb)) continue
      const paths = args.filter((w, i) => !/^['"]?[-!]/.test(w) && !EXCLUDE_FLAG.test(args[i - 1] ?? ''))
      if (SHELL_SCRIPT.test(verb)) paths.shift() // grep's pattern or awk's script, not a path
      dir = paths.map(w => heavyIn(unquote(w))).find(Boolean)
      if (dir) break
    }
  } else if (['Read', 'Grep', 'Glob'].includes(tool)) {
    const paths = ['file_path', 'path', 'pattern', 'glob'].map(k => ti[k]).filter(v => typeof v === 'string') as string[]
    dir = HEAVY.find(d => paths.some(p => heavyIn(p) === d))
  }
  return dir && `c-saver: skipped ${dir}/, a generated folder. Read the source or the package's docs instead.`
}

/** Files a shell command dumps whole (`cat big.log`, `Get-Content x.log`); none when it pipes or limits lines. */
export function shellDumps(cmd: string): string[] {
  if (cmd.includes('|')) return [] // filtered through grep, tail and the like
  return shellParts(cmd).flatMap(([verb, ...args]) =>
    // `cat a > b` writes a file, nothing reaches Claude
    SHELL_DUMP.test(verb ?? '') && !args.some(a => /^-(?:tail|totalcount|head|first|last)$/i.test(a) || /^1?>/.test(a))
      ? args.filter(a => !a.startsWith('-') && !/[<>]/.test(a)).map(unquote) : [])
}

/** Deny reason for a whole Read of a lockfile, minified file or file over BIG_READ. */
export function bigRead(path: string, size: number, ti: Input): string | undefined {
  if (ti.offset || ti.limit) return
  const name = base(path).toLowerCase()
  if (LOCKFILES.has(name) || MINIFIED.some(s => name.endsWith(s)) || (size > BIG_READ && !MEDIA.some(s => name.endsWith(s))))
    return `c-saver: skipped ~${fmt(size / 4)} tokens, a whole read of ${base(path)}. ` +
      'Grep it for what you need, or Read it with offset and limit.'
}

/** Path, offset and limit of every Read so far, with the file's stamp then and whether the mod answered it. */
export type Seen = Map<string, { stamp: string; answered: boolean }>

/** Whether a Read repeats one with the same stamp, so the mod answers it without reading. Records this read in `seen`. */
export function reread(seen: Seen, path: string, ti: Input, stamp: string): boolean {
  // Answered once already: let it through, the content likely left context (compaction).
  const key = JSON.stringify([path.replace(/\\/g, '/').toLowerCase(), ti.offset, ti.limit])
  const old = seen.get(key)
  const repeat = old?.stamp === stamp && !old.answered
  seen.set(key, { stamp, answered: repeat })
  return repeat
}

/** Head, error lines from the middle, and tail of a long output with a note, or undefined when it is short enough. */
export function trim(text: string, where: string): { text: string; cut: number } | undefined {
  if (text.length / 4 < NOISY) return
  const head = text.slice(0, text.lastIndexOf('\n', KEEP_HEAD) + 1 || KEEP_HEAD)
  const tailFrom = text.length - KEEP_TAIL
  const tail = text.slice(text.indexOf('\n', tailFrom) + 1 || tailFrom)
  let errors = ''
  for (const line of text.slice(head.length, text.length - tail.length).split('\n')) {
    const kept = line.slice(0, 300) + '\n'
    if (ERROR_LINE.test(line) && errors.length + kept.length <= KEEP_ERRORS) errors += kept
  }
  const cut = Math.floor((text.length - head.length - tail.length - errors.length) / 4)
  return {
    cut,
    text: `${head}\n[c-saver: trimmed ~${fmt(cut)} tokens from the middle. Full output: ${where} ` +
      '(Grep it, or Read it with offset and limit). Next time use quiet flags or pipe through tail or grep.]\n' +
      (errors && `[c-saver: error lines from the trimmed part]\n${errors}`) + '\n' + tail,
  }
}
