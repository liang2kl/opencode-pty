import type { PTYSession, PTYSessionInfo } from './types.ts'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { NOTIFICATION_LINE_TRUNCATE, NOTIFICATION_TITLE_TRUNCATE } from '../constants.ts'

export class NotificationManager {
  private client: OpencodeClient | null = null

  init(client: OpencodeClient): void {
    this.client = client
  }

  async sendExitNotification(
    session: PTYSession | PTYSessionInfo,
    exitCode: number,
    brokerLastLine?: string
  ): Promise<void> {
    if (!this.client) {
      return
    }

    try {
      const message = this.buildExitNotification(session, exitCode, brokerLastLine)
      let modelContext: {
        model?: { providerID: string; modelID: string }
        variant?: string
      } = {}
      try {
        const parent = await this.client.session.get({
          path: { id: session.parentSessionId },
        })
        const model = (
          parent.data as
            | (typeof parent.data & {
                model?: { id: string; providerID: string; variant?: string }
              })
            | undefined
        )?.model
        if (model) {
          modelContext = {
            model: { providerID: model.providerID, modelID: model.id },
            ...(model.variant ? { variant: model.variant } : {}),
          }
        }
      } catch {
        // Older OpenCode versions may not expose the session model.
      }
      await this.client.session.promptAsync({
        path: { id: session.parentSessionId },
        body: {
          parts: [{ type: 'text', text: message }],
          ...(session.parentAgent ? { agent: session.parentAgent } : {}),
          ...modelContext,
        },
      })
    } catch {
      // Ignore notification errors
    }
  }

  private buildExitNotification(
    session: PTYSession | PTYSessionInfo,
    exitCode: number,
    brokerLastLine?: string
  ): string {
    const lineCount = 'buffer' in session ? session.buffer.length : session.lineCount
    let lastLine = brokerLastLine ?? ''
    if (brokerLastLine === undefined && 'buffer' in session && lineCount > 0) {
      for (let i = lineCount - 1; i >= 0; i--) {
        const line = session.buffer.read(i, 1)[0]
        if (line?.trim()) {
          lastLine = line
          break
        }
      }
    }
    if (lastLine.length > NOTIFICATION_LINE_TRUNCATE) {
      lastLine = `${lastLine.slice(0, NOTIFICATION_LINE_TRUNCATE)}...`
    }

    const displayTitle = session.description ?? session.title
    const truncatedTitle =
      displayTitle.length > NOTIFICATION_TITLE_TRUNCATE
        ? `${displayTitle.slice(0, NOTIFICATION_TITLE_TRUNCATE)}...`
        : displayTitle

    const lines = [
      '<pty_exited>',
      `ID: ${session.id}`,
      `Description: ${truncatedTitle}`,
      `Exit Code: ${exitCode}`,
      `TimeoutSeconds: ${session.timeoutSeconds ?? 'none'}`,
      `Timed Out: ${session.timedOut ? 'yes' : 'no'}`,
      `Output Lines: ${lineCount}`,
      `Last Line: ${lastLine}`,
      '</pty_exited>',
      '',
    ]

    if (session.timedOut) {
      lines.push(
        'Process reached its PTY timeout and was stopped automatically. Use pty_read to inspect the final output.'
      )
    } else if (exitCode === 0) {
      lines.push('Use pty_read to check the full output.')
    } else {
      lines.push(
        'Process failed. Use pty_read with the pattern parameter to search for errors in the output.'
      )
    }

    return lines.join('\n')
  }
}
