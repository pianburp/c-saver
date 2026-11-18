import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../../', import.meta.url))
const windows = process.platform === 'win32'
const wrapper = process.env.C_SAVER_CODEX_BIN ?? (windows
  ? process.env.PATH.split(delimiter).map(dir => join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')).find(existsSync)
  : 'codex')
if (!wrapper) throw new Error('Set C_SAVER_CODEX_BIN to the Codex binary or its npm codex.js launcher.')
const binary = wrapper.endsWith('.js') ? process.execPath : wrapper
const prefix = wrapper.endsWith('.js') ? [wrapper] : []

const root = mkdtempSync(join(windows ? homedir() : tmpdir(), 'c-saver smoke '))
const home = join(root, 'home with spaces')
const marketplace = join(root, 'source marketplace')
const repo = join(root, 'test repository')
const nested = join(repo, 'nested directory')
const otherCwd = join(repo, 'other tool directory')
mkdirSync(home)
mkdirSync(marketplace)
mkdirSync(nested, { recursive: true })
mkdirSync(otherCwd, { recursive: true })
for (const path of ['.agents', '.codex-plugin', 'assets', 'codex']) {
  cpSync(join(source, path), join(marketplace, path), { recursive: true })
}
assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
writeFileSync(join(repo, 'AGENTS.md'), 'SMOKE_ROOT_INSTRUCTIONS\n')
writeFileSync(join(nested, 'AGENTS.override.md'), 'SMOKE_NESTED_INSTRUCTIONS\n')
writeFileSync(join(nested, 'AGENTS.md'), 'SMOKE_SHADOWED_INSTRUCTIONS\n')
writeFileSync(join(nested, '.env'), 'SMOKE_PRIVATE_SENTINEL\n')
writeFileSync(join(nested, '.env.example'), 'SMOKE_PUBLIC_SENTINEL\n')
const buildLog = lines => Array.from({ length: lines }, (_, index) =>
  `[build] Processed src/components/Widget${index}.tsx in ${12 + index % 19} ms\n`).join('')
writeFileSync(join(otherCwd, 'alternate.log'), buildLog(900))
mkdirSync(join(nested, 'dist'))
writeFileSync(join(nested, 'dist', 'build.log'), buildLog(80))
writeFileSync(join(home, 'AGENTS.md'), 'SMOKE_GLOBAL_INSTRUCTIONS\n')
const env = { ...process.env, CODEX_HOME: home, C_SAVER_CODEX_GUARDS: '1' }
// Never inherit credentials for the fixture provider.
for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_PERMISSION_PROFILE',
  'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID']) delete env[name]

function adminFrom(cwd, ...args) {
  const result = spawnSync(binary, [...prefix, ...args], { cwd, env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return result.stdout
}

function admin(...args) {
  return adminFrom(repo, ...args)
}

function reportGuardSavings(cases) {
  const python = process.env.C_SAVER_TIKTOKEN_PYTHON
  const pairs = cases.map(({ baseline, guarded }) => [baseline, guarded])
  const counts = python && spawnSync(python, ['-X', 'utf8', '-c', `
import json
import sys
import tiktoken

encoder = tiktoken.get_encoding("o200k_base")
pairs = json.load(sys.stdin)
print(json.dumps([[len(encoder.encode_ordinary(text)) for text in pair] for pair in pairs]))
`], { input: JSON.stringify(pairs), encoding: 'utf8', timeout: 45_000 })
  if (counts) assert.equal(counts.status, 0, counts.stderr || counts.error?.message)
  const tokens = counts && JSON.parse(counts.stdout)
  console.log('c-saver guard impact on next-request tool-result text (off -> on):')
  for (const [index, { label, baseline, guarded }] of cases.entries()) {
    const bytesOff = Buffer.byteLength(baseline)
    const bytesOn = Buffer.byteLength(guarded)
    assert.ok(bytesOn < bytesOff, `${label} should send less tool-result text with the guard`)
    const tokenSummary = tokens ? `, ${tokens[index][0]} -> ${tokens[index][1]} o200k_base tokens` : ''
    console.log(`  ${label}: ${bytesOff} -> ${bytesOn} UTF-8 bytes${tokenSummary}`)
  }
}

let scenario
const server = createServer(async (req, res) => {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    scenario.requests.push(body)
    const step = scenario.requests.length
    const id = `response_${step}`
    let item
    if (step === 1) {
      const tool = body.tools?.find(tool => tool.name === 'exec_command') ??
        body.tools?.find(tool => tool.name === 'shell_command')
      assert.ok(tool, 'Codex advertised a shell command')
      const commandField = tool.parameters?.properties?.cmd ? 'cmd' : 'command'
      const args = { [commandField]: scenario.command, workdir: scenario.toolDir }
      if (scenario.poll) args.yield_time_ms = 1000
      item = {
        type: 'function_call', call_id: 'fixture_shell', name: tool.name,
        arguments: JSON.stringify(args),
      }
    } else if (step === 2 && scenario.poll) {
      const original = body.input.find(input => input.type === 'function_call_output' && input.call_id === 'fixture_shell')
      const result = typeof original?.output === 'string' ? original.output : JSON.stringify(original?.output)
      const session = /session ID:?\s*(\d+)|"session_id"\s*:\s*"?(\d+)/i.exec(result)
      if (session && body.tools?.some(tool => tool.name === 'write_stdin')) {
        item = { type: 'function_call', call_id: 'fixture_poll', name: 'write_stdin',
          arguments: JSON.stringify({ session_id: Number(session[1] ?? session[2]), chars: '', yield_time_ms: 10_000 }) }
      } else {
        scenario.pollUnavailable = result?.slice(0, 300) || 'No shell output'
      }
    }
    if (!item) {
      item = { type: 'message', role: 'assistant', id: 'fixture_message', content: [{ type: 'output_text', text: 'fixture complete' }] }
    }
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item },
      {
        type: 'response.completed',
        response: { id, usage: { input_tokens: 25, input_tokens_details: { cached_tokens: 10 },
          output_tokens: 7, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 32 } },
      },
    ]
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  } catch (error) {
    scenario.error = error
    res.writeHead(400).end()
  }
})

async function run(command, config = [], options = [], { toolDir = nested, poll = false, ...extraEnv } = {}) {
  scenario = { command, toolDir, poll, requests: [] }
  const args = ['-a', 'never', 'exec', '--cd', nested, '--sandbox', 'read-only', '--trust',
    '--json', '--ephemeral', '-c', 'model_provider="fixture"', '-c', 'model_providers.fixture.name="fixture"',
    '-c', `model_providers.fixture.base_url="http://127.0.0.1:${server.address().port}/v1"`,
    '-c', 'model_providers.fixture.wire_api="responses"', '-m', 'gpt-5.5', ...options]
  for (const field of config) args.push('-c', field)
  if (windows) args.push('-c', `windows.sandbox=${JSON.stringify(process.env.C_SAVER_TEST_WINDOWS_SANDBOX || 'unelevated')}`)
  args.push('Run this synthetic c-saver fixture.')
  const result = await new Promise((resolve, reject) => {
    const child = spawn(binary, [...prefix, ...args], { cwd: repo, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), 45_000)
    child.once('error', reject)
    child.once('close', status => {
      clearTimeout(timer)
      resolve({ stdout, stderr, status })
    })
  })
  if (scenario.error) throw scenario.error
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const polled = poll && !scenario.pollUnavailable
  assert.equal(scenario.requests.length, polled ? 3 : 2, 'fixture must exercise model requests across tools')
  const output = scenario.requests[1].input.find(item => item.call_id === 'fixture_shell' && item.type === 'function_call_output')
  assert.ok(output, 'Codex submitted a tool result to the fixture endpoint')
  const pollOutput = polled ? scenario.requests[2].input.find(item => item.call_id === 'fixture_poll' && item.type === 'function_call_output') : undefined
  if (polled) assert.ok(pollOutput, 'Codex submitted a poll result to the fixture endpoint')
  const toolText = typeof output.output === 'string' ? output.output : output.output.map(block => {
    assert.equal(block.type, 'input_text', 'fixture expects text tool output')
    return block.text
  }).join('\n')
  return { ...result, firstRequest: JSON.stringify(scenario.requests[0]), toolOutput: JSON.stringify(output.output), toolText,
    pollOutput: JSON.stringify(pollOutput?.output), pollUnavailable: scenario.pollUnavailable }
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  console.log(admin('--version').trim())
  adminFrom(marketplace, 'plugin', 'marketplace', 'add', '.', '--json')
  const plugin = JSON.parse(admin('plugin', 'add', 'c-saver@c-saver-local', '--json'))
  const manifest = JSON.parse(readFileSync(join(source, '.codex-plugin', 'plugin.json'), 'utf8'))
  assert.equal(plugin.version, manifest.version)
  const { installed } = JSON.parse(admin('plugin', 'list', '--marketplace', 'c-saver-local', '--json'))
  assert.ok(installed.some(entry => entry.pluginId === 'c-saver@c-saver-local' && entry.enabled))
  assert.equal(JSON.parse(admin('plugin', 'add', 'c-saver@c-saver-local', '--json')).installedPath, plugin.installedPath)
  renameSync(marketplace, `${marketplace} offline`)
  for (const iconPath of new Set([manifest.interface.logo, manifest.interface.composerIcon])) {
    assert.ok(existsSync(join(plugin.installedPath, iconPath)), `Installed icon is missing: ${iconPath}`)
  }

  const read = path => windows ? `Get-Content -LiteralPath "${path}"` : `cat "${path}"`
  const pending = await run(read('.env'))
  assert.match(pending.toolOutput, /SMOKE_PRIVATE_SENTINEL/)
  assert.match(pending.firstRequest, /c-saver-audit/)
  assert.match(pending.firstRequest, /c-saver-handoff/)
  assert.match(pending.firstRequest, /SMOKE_GLOBAL_INSTRUCTIONS/)
  assert.match(pending.firstRequest, /SMOKE_ROOT_INSTRUCTIONS/)
  assert.match(pending.firstRequest, /SMOKE_NESTED_INSTRUCTIONS/)
  assert.doesNotMatch(pending.firstRequest, /SMOKE_SHADOWED_INSTRUCTIONS/)

  // Only the checked-in fixture bundle is loaded. This switch is restricted to
  // this disposable run so the unattended harness does not need a reviewer.
  const fixtureTrust = ['--dangerously-bypass-hook-trust']
  const denied = await run(read('.env'), [], fixtureTrust)
  assert.match(denied.toolOutput, /c-saver skipped a direct \.env read/, denied.stderr + denied.stdout)
  assert.doesNotMatch(denied.toolOutput, /SMOKE_PRIVATE_SENTINEL/)
  assert.doesNotMatch(denied.stdout, /"type":"command_execution"/)
  const allowed = await run(read('.env.example'), [], fixtureTrust)
  assert.match(allowed.toolOutput, /SMOKE_PUBLIC_SENTINEL/)
  const switchedOff = await run(read('.env'), [], fixtureTrust, { C_SAVER_CODEX_GUARDS: '0' })
  assert.match(switchedOff.toolOutput, /SMOKE_PRIVATE_SENTINEL/)

  const guardOff = { C_SAVER_CODEX_GUARDS: '0' }
  const generated = read('dist/build.log')
  const generatedBaseline = await run(generated, [], fixtureTrust, guardOff)
  const generatedGuarded = await run(generated, [], fixtureTrust)
  assert.match(generatedBaseline.toolText, /Widget0\.tsx/)
  assert.match(generatedGuarded.toolText, /skipped a read in a generated directory/)
  assert.doesNotMatch(generatedGuarded.stdout, /"type":"command_execution"/)

  const whole = read('alternate.log')
  const wholeBaseline = await run(whole, [], fixtureTrust, { ...guardOff, toolDir: otherCwd })
  const wholeGuarded = await run(whole, [], fixtureTrust, { toolDir: otherCwd })
  assert.match(wholeBaseline.toolText, /Widget0\.tsx/)
  assert.match(wholeGuarded.toolText, /skipped a whole-file read/)
  assert.doesNotMatch(wholeGuarded.stdout, /"type":"command_execution"/)
  const bounded = await run(windows ? `${whole} -TotalCount 5` : 'head -n 5 "alternate.log"',
    [], fixtureTrust, { toolDir: otherCwd })
  assert.match(bounded.toolText, /Widget4\.tsx/)
  assert.doesNotMatch(bounded.toolText, /Widget5\.tsx/)

  reportGuardSavings([
    { label: 'Generated build log', baseline: generatedBaseline.toolText, guarded: generatedGuarded.toolText },
    { label: 'Whole read of large log', baseline: wholeBaseline.toolText, guarded: wholeGuarded.toolText },
  ])

  const cli = join(plugin.installedPath, 'codex', 'cli.mjs')
  const audit = await run(`node "${cli}" audit --cwd "${nested}"`, [], fixtureTrust)
  assert.match(audit.toolOutput, /Codex instruction candidates from disk/)
  assert.doesNotMatch(audit.toolOutput, /SMOKE_ROOT_INSTRUCTIONS|SMOKE_NESTED_INSTRUCTIONS/)
  const usage = spawnSync(process.execPath, [cli, 'usage', '-'], { input: audit.stdout, encoding: 'utf8' })
  assert.equal(usage.status, 0, usage.stderr)
  assert.match(usage.stdout, /Input tokens: 50/)
  assert.match(usage.stdout, /Reasoning output tokens \(included in output\): 4/)
  const saved = spawnSync(process.execPath, [cli, 'handoff', 'save', '--cwd', nested], {
    env, input: '# SMOKE_APPROVED_HANDOFF\n', encoding: 'utf8',
  })
  assert.equal(saved.status, 0, saved.stderr)
  const note = await run(`node "${cli}" handoff read --cwd "${nested}"`)
  assert.doesNotMatch(note.firstRequest, /SMOKE_APPROVED_HANDOFF/)
  assert.match(note.toolOutput, /SMOKE_APPROVED_HANDOFF/)

  const noisy = windows
    ? `Write-Output ('a' * 9000); Write-Output 'SMOKE_MIDDLE_ERROR'; Write-Output ('z' * 9000); exit 9`
    : `printf '%09000d\\nSMOKE_MIDDLE_ERROR\\n%09000d\\n' 0 0; exit 9`
  const full = await run(noisy)
  const capped = await run(noisy, ['tool_output_token_limit=512'])
  assert.ok(capped.toolOutput.length < full.toolOutput.length, 'native cap changes model-facing output')
  assert.match(full.toolOutput, /SMOKE_MIDDLE_ERROR/)
  assert.match(capped.stdout, /"exit_code":9/)
  console.log(`Model-facing JSON chars for the failed command: ${full.toolOutput.length} default, ${capped.toolOutput.length} capped. Middle error present with cap in model result: ${capped.toolOutput.includes('SMOKE_MIDDLE_ERROR')}. In exec JSONL: ${capped.stdout.includes('SMOKE_MIDDLE_ERROR')}.`)

  const probeScript = join(home, 'probe.mjs')
  const probeOutput = join(home, 'probe.json')
  const command = `node "${probeScript}"`
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: Object.fromEntries(
    ['PreToolUse', 'PostToolUse'].map(event => [event, [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }]]),
  ) }))
  writeFileSync(probeScript, `
    import { appendFileSync } from 'node:fs'
    let data = ''
    for await (const chunk of process.stdin) data += chunk
    const event = JSON.parse(data)
    const response = JSON.stringify(event.tool_response)
    const hasMiddle = response?.includes('SMOKE_MIDDLE_ERROR')
    appendFileSync(${JSON.stringify(probeOutput)}, JSON.stringify({
      event: event.hook_event_name,
      tool: event.tool_name,
      keys: Object.keys(event.tool_input || {}).sort(),
      cwdIsLaunchDirectory: event.cwd === ${JSON.stringify(nested)},
      cwdIsToolDirectory: event.cwd === ${JSON.stringify(otherCwd)},
      hasTranscript: Boolean(event.transcript_path),
      hasMiddle,
      hasExitCode: /exit.*9/i.test(response)
    }) + '\\n')
    if (event.hook_event_name === 'PostToolUse' && hasMiddle) {
      console.log(JSON.stringify({ continue: false, stopReason: 'SMOKE_REPLACEMENT: SMOKE_MIDDLE_ERROR' }))
    }
  `)
  const alternate = await run(read('alternate.log'), [], fixtureTrust, { toolDir: otherCwd })
  const toolProbes = readFileSync(probeOutput, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(toolProbes[0].cwdIsToolDirectory, true)
  assert.match(alternate.toolOutput, /skipped a whole-file read/)
  console.log('Alternate workdir hook metadata:', JSON.stringify(toolProbes[0]))
  console.log('Alternate workdir whole-read denied:', /skipped a whole-file read/.test(alternate.toolOutput))
  writeFileSync(probeOutput, '')
  const replacement = await run(noisy, ['tool_output_token_limit=512'], fixtureTrust)
  const postProbe = readFileSync(probeOutput, 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1)
  console.log('Failed command PostToolUse metadata:', JSON.stringify(postProbe))
  console.log('Failed command replacement reached model:', /SMOKE_REPLACEMENT/.test(replacement.toolOutput),
    'model-facing exit marker preserved:', /(?:exited with code|exit status)\s+9/i.test(replacement.toolOutput))
  const uncappedReplacement = await run(noisy, [], fixtureTrust)
  console.log('Default-budget failed command replacement reached model:', /SMOKE_REPLACEMENT/.test(uncappedReplacement.toolOutput),
    'model-facing exit marker preserved:', /(?:exited with code|exit status)\s+9/i.test(uncappedReplacement.toolOutput))
  const noisySuccess = noisy.replace(/exit 9$/, 'exit 0')
  const successfulReplacement = await run(noisySuccess, [], fixtureTrust)
  console.log('Default-budget successful command replacement reached model:', /SMOKE_REPLACEMENT/.test(successfulReplacement.toolOutput))
  const delayed = windows
    ? "Write-Output 'SMOKE_EARLY'; Start-Sleep -Seconds 3; Write-Output 'SMOKE_MIDDLE_ERROR'"
    : "printf 'SMOKE_EARLY\\n'; sleep 3; printf 'SMOKE_MIDDLE_ERROR\\n'"
  const polled = await run(delayed, [], fixtureTrust, { poll: true })
  if (polled.pollUnavailable) console.log('Poll probe unavailable:', polled.pollUnavailable)
  else console.log('Early output reached model before poll:', /SMOKE_EARLY/.test(polled.toolOutput),
    'replacement after poll:', /SMOKE_REPLACEMENT/.test(polled.pollOutput))

  const configFile = join(home, 'config.toml')
  const installedConfig = readFileSync(configFile, 'utf8')
  const disabledConfig = installedConfig.replace(/(\[plugins\."c-saver@c-saver-local"\]\r?\nenabled = )true/, '$1false')
  assert.notEqual(disabledConfig, installedConfig)
  writeFileSync(configFile, disabledConfig)
  const disabled = await run(read('.env'), [], fixtureTrust)
  assert.match(disabled.toolOutput, /SMOKE_PRIVATE_SENTINEL/)
  assert.doesNotMatch(disabled.firstRequest, /c-saver-audit/)
  writeFileSync(configFile, installedConfig)
  admin('plugin', 'remove', 'c-saver@c-saver-local', '--json')
  assert.ok(!existsSync(plugin.installedPath))
  admin('plugin', 'marketplace', 'remove', 'c-saver-local', '--json')
  console.log('Verified install, cache-only skill and hook loading, unreviewed hook skip, opt-in deny/pass, audit, usage, fresh handoff retrieval, native cap, disable, and removal.')
} finally {
  server.closeAllConnections()
  server.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}
