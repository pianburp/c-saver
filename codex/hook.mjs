import { denyRead } from './guards.mjs'

async function readInput() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > 64 * 1024) return
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

if (process.env.C_SAVER_CODEX_GUARDS === '1') {
  try {
    const event = await readInput()
    if (event?.hook_event_name === 'PreToolUse' && event.tool_name === 'Bash') {
      const reason = denyRead(event.tool_input?.command, event.cwd, event.tool_input?.workdir)
      if (reason) {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }))
      }
    }
  } catch {
    // Fail open and keep the command and payload out of diagnostics.
  }
}
