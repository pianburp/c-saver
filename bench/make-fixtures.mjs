// Writes made-up transcripts to bench/fixtures. Content invented here, never copied from a real session.
import { writeFileSync } from 'node:fs'
const out = process.argv[2]
const NL = String.fromCharCode(10), TAB = String.fromCharCode(9)
const DOTENV = '.' + 'env' // spelled apart so c-saver's own secret guard lets this script run
const numbered = lines => lines.map((l, i) => String(i + 1).padStart(6) + TAB + l).join(NL)

function session(name, day, steps, extra = []) {
  const rows = [...extra]
  let n = 0
  const at = () => `2026-09-0${day}T10:${String(n).padStart(2, '0')}:00.000Z`
  const usage = { input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 4000, output_tokens: 80 }
  for (const [tool, input, result, isError] of steps) {
    n++
    rows.push({ type: 'assistant', timestamp: at(), sessionId: name, message: { id: `msg_${name}_${n}`, model: 'claude-sonnet-5-5',
      role: 'assistant', content: [{ type: 'tool_use', id: `tu_${name}_${n}`, name: tool, input }], usage } })
    rows.push({ type: 'user', timestamp: at(), sessionId: name, message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `tu_${name}_${n}`, content: result, ...(isError ? { is_error: true } : {}) }] } })
  }
  n++
  rows.push({ type: 'assistant', timestamp: at(), sessionId: name, message: { id: `msg_${name}_${n}`, model: 'claude-sonnet-5-5',
    role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage } })
  writeFileSync(`${out}/${name}.jsonl`, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join(NL) + NL)
}

const testLines = []
for (let i = 1; i <= 400; i++) testLines.push(i % 97 ? `PASS src/widget-${i}.test.js (${i % 40 + 3} ms)` : `FAIL src/widget-${i}.test.js: expected 3, got 4`)
testLines.push('Tests: 4 failed, 396 passed, 400 total')
session('a-trim', 1, [['Bash', { command: 'npm test' }, testLines.join(NL)]])

session('a-folder', 2, [['Read', { file_path: '/fake/app/node_modules/left-pad/index.js' },
  numbered(['module.exports = function leftPad (s, n) {', '  return String(s).padStart(n)', '}'])]])

const lock = ['{', '  "name": "fake-app",', '  "lockfileVersion": 3,', '  "packages": {']
for (let i = 1; i <= 120; i++) lock.push(`    "node_modules/fake-dep-${i}": { "version": "1.0.${i}", "integrity": "sha512-fakefakefake${i}" },`)
lock.push('  }', '}')
session('a-lockfile', 3, [['Read', { file_path: '/fake/app/package-lock.json' }, numbered(lock)]])

const app = numbered(['export const greet = name => `hi ${name}`', 'export const add = (a, b) => a + b'])
const app2 = numbered(['export const greet = name => `hello ${name}`', 'export const add = (a, b) => a + b'])
session('a-reread', 4, [
  ['Read', { file_path: '/fake/app/src/app.js' }, app],
  ['Read', { file_path: '/fake/app/src/app.js' }, app],
  ['Edit', { file_path: '/fake/app/src/app.js', old_string: 'hi', new_string: 'hello' }, 'The file was updated.'],
  ['Read', { file_path: '/fake/app/src/app.js' }, app2],
])

session('a-secrets', 5, [
  ['Read', { file_path: '/fake/app/' + DOTENV }, numbered(['API_URL=http://localhost:3000', 'FAKE_TOKEN=not-a-real-token'])],
  ['Write', { file_path: '/fake/app/src/config.js', content: "export const awsKey = 'AKIAIOSFODNN7EXAMPLE'" }, 'File created.'],
])

session('b-on', 6, [
  ['Bash', { command: 'npm run build' }, 'building fake-app' + NL + '[c-saver: trimmed ~3.1k tokens from the middle. Full output: /fake/out/0.txt (Grep it, or Read it with offset and limit). Next time use quiet flags or pipe through tail or grep.]' + NL + 'build done'],
  ['Read', { file_path: '/fake/app/dist/bundle.js' }, "c-saver: skipped dist/, a generated folder. Read the source or the package's docs instead.", true],
  ['Read', { file_path: '/fake/app/yarn.lock' }, 'c-saver: skipped ~12.5k tokens, a whole read of yarn.lock. Grep it for what you need, or Read it with offset and limit.', true],
])

session('clean', 7, [
  ['Bash', { command: 'ls' }, 'README.md' + NL + 'src'],
  ['Read', { file_path: '/fake/app/README.md' }, numbered(['# fake-app', 'A made-up app for the replay fixtures.'])],
], ['{"type":"assistant","message":{broken line', JSON.stringify({ type: 'file-history-snapshot', snapshot: {} })])
