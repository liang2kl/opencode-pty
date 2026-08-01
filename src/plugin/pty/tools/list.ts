import { tool } from '@opencode-ai/plugin'
import type { BrokerTransport } from '../../../broker/protocol.ts'
import { formatSessionInfo } from '../formatters.ts'
import type { PTYSessionInfo } from '../types.ts'
import DESCRIPTION from './list.txt'

export const createPtyList = (broker: BrokerTransport) =>
  tool({
    description: DESCRIPTION,
    args: {},
    async execute() {
      const sessions = await broker.request<PTYSessionInfo[]>({ type: 'list' })

      if (sessions.length === 0) {
        return '<pty_list>\nNo active PTY sessions.\n</pty_list>'
      }

      const lines = ['<pty_list>']
      for (const session of sessions) {
        lines.push(...formatSessionInfo(session))
      }
      lines.push(`Total: ${sessions.length} session(s)`)
      lines.push('</pty_list>')

      return lines.join('\n')
    },
  })
