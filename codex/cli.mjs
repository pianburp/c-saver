import { unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { audit, DEFAULT_BUDGET } from './audit.mjs'
import { handoffPath, readHandoff, saveHandoff } from './handoff.mjs'
import { reportUsage } from './usage.mjs'

const help = `c-saver for Codex (Node 24+)

  node codex/cli.mjs audit [--cwd <directory>] [--root <directory>]
                           [--max-bytes <n>] [--fallback <filename>]...
  node codex/cli.mjs usage <events.jsonl|->
  node codex/cli.mjs handoff <path|save|read|delete> [--cwd <directory>]

The audit lists instruction candidates on disk. Supply the effective project's
root, project_doc_max_bytes and project_doc_fallback_filenames when they differ
from the defaults. CODEX_HOME selects the Codex home.
Usage accepts one codex exec --json stream. A dash reads stdin.
Handoff save reads the approved note from stdin and replaces the previous note.`

async function main([command, ...args]) {
  if (!command || command === '--help' || args.includes('--help')) {
    console.log(help)
    return
  }
  if (command === 'usage') {
    if (args.length !== 1) throw new Error('Provide one JSONL file or - for stdin.')
    console.log(await reportUsage(args[0]))
    return
  }

  const home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))
  if (command === 'handoff') {
    const [action, ...options] = args
    if (!['path', 'save', 'read', 'delete'].includes(action)) throw new Error('Choose handoff path, save, read, or delete.')
    const { values } = parseArgs({ args: options, options: { cwd: { type: 'string' } } })
    const path = handoffPath(home, resolve(values.cwd || process.cwd()))
    if (action === 'save') await saveHandoff(path)
    if (action === 'read') {
      process.stdout.write(readHandoff(path))
      return
    }
    if (action === 'delete') unlinkSync(path)
    console.log(JSON.stringify(path))
    return
  }

  if (command !== 'audit') throw new Error('Unknown command. Run with --help.')
  const { values } = parseArgs({
    args,
    options: {
      cwd: { type: 'string' },
      root: { type: 'string' },
      'max-bytes': { type: 'string', default: String(DEFAULT_BUDGET) },
      fallback: { type: 'string', multiple: true, default: [] },
    },
  })
  const budget = Number(values['max-bytes'])
  if (!/^\d+$/.test(values['max-bytes']) || !Number.isSafeInteger(budget) || budget > 16 * 1024 * 1024) {
    throw new Error('Use a byte budget from 0 through 16777216.')
  }
  const result = audit(resolve(values.cwd || process.cwd()), {
    home,
    root: values.root === undefined ? undefined : resolve(values.root),
    budget,
    fallbacks: values.fallback,
  })
  console.log('Codex instruction candidates from disk (effective session settings and trust are not read)')
  console.log(`Codex home: ${JSON.stringify(result.home)}`)
  console.log(`Project root: ${JSON.stringify(result.root)}`)
  console.log(`Project byte budget: ${result.budget}. Fallback filenames: ${JSON.stringify(result.fallbacks)}.`)
  if (!result.files.length) console.log('No instruction candidates in scope.')
  let bytes = 0
  let tokens = 0
  for (const file of result.files) {
    bytes += file.bytes
    tokens += file.tokens
    const findings = []
    if (file.truncated) findings.push('truncated')
    if (file.bytes >= 8192) findings.push('large instruction file')
    if (file.duplicateOf) findings.push(`duplicates ${JSON.stringify(file.duplicateOf)}`)
    console.log(`- ${file.scope} ${JSON.stringify(file.path)} • ${file.bytes} bytes, ~${file.tokens} tokens${findings.length ? ` • ${findings.join(', ')}` : ''}`)
  }
  console.log(`Total: ${bytes} selected bytes, ~${tokens} tokens (one token per four characters, excluding prompt framing).`)
  for (const warning of result.warnings) console.log(warning)
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  // System and argument errors can contain raw paths or arguments.
  const coded = {
    ENOENT: 'A required file or directory was not found.',
    EACCES: 'Access to a required file or directory was denied.',
    EPERM: 'The requested file operation was denied.',
  }
  const message = error.code ? coded[error.code] || 'The input or operation is invalid. Run with --help.' : error.message
  console.error(`c-saver: ${message}`)
  process.exitCode = 1
}
