import { tool } from '@opencode-ai/plugin'
import { getBrokerClient } from '../broker-client.ts'
import type { PTYSessionInfo } from '../types.ts'
import { buildSessionNotFoundError } from '../utils.ts'
import DESCRIPTION from './kill.txt'

export const ptyKill = tool({
  description: DESCRIPTION,
  args: {
    id: tool.schema.string().describe('The PTY session ID (e.g., pty_a1b2c3d4)'),
    cleanup: tool.schema
      .boolean()
      .optional()
      .describe('If true, removes the session and frees the buffer (default: false)'),
  },
  async execute(args) {
    const broker = getBrokerClient()
    const session = await broker.request<PTYSessionInfo | null>({ type: 'get', id: args.id })
    if (!session) {
      throw buildSessionNotFoundError(args.id)
    }

    const wasRunning = session.status === 'running'
    const cleanup = args.cleanup ?? false
    const success = await broker.request<boolean>({
      type: 'kill',
      id: args.id,
      cleanup,
    })

    if (!success) {
      throw new Error(`Failed to kill PTY session '${args.id}'.`)
    }

    const action = wasRunning ? 'Killed' : 'Cleaned up'
    const cleanupNote = cleanup ? ' (session removed)' : ' (session retained for log access)'

    return [
      `<pty_killed>`,
      `${action}: ${args.id}${cleanupNote}`,
      `Title: ${session.title}`,
      `Command: ${session.command} ${session.args.join(' ')}`,
      `Final line count: ${session.lineCount}`,
      `</pty_killed>`,
    ].join('\n')
  },
})
