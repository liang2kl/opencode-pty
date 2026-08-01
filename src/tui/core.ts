import type { PTYSessionInfo } from '../plugin/pty/types.ts'

export const PTY_RECONNECT_DELAY_MS = 1000

export function getPtyWebSocketUrl(env: Record<string, string | undefined>): string | undefined {
  const port = Number(env.PTY_WEB_PORT ?? '4097')
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return

  const rawHostname = env.PTY_WEB_HOSTNAME ?? '127.0.0.1'
  const hostname =
    rawHostname.includes(':') && !rawHostname.startsWith('[') ? `[${rawHostname}]` : rawHostname
  return `ws://${hostname}:${port}/ws`
}

export function sameServerEndpoint(expected: string, actual: string): boolean {
  try {
    const expectedUrl = new URL(expected)
    const actualUrl = new URL(actual)
    return expectedUrl.protocol === actualUrl.protocol && expectedUrl.port === actualUrl.port
  } catch {
    return false
  }
}

export function upsertSession(
  sessions: PTYSessionInfo[],
  session: PTYSessionInfo
): PTYSessionInfo[] {
  const index = sessions.findIndex((item) => item.id === session.id)
  if (index === -1) return [...sessions, session]
  return sessions.with(index, session)
}

export function removeSession(sessions: PTYSessionInfo[], sessionId: string): PTYSessionInfo[] {
  return sessions.filter((session) => session.id !== sessionId)
}

export function formatRunningTime(createdAt: string, now: number = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 1000))
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`

  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`

  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function activeSessionsForParent(
  sessions: PTYSessionInfo[],
  parentSessionId: string
): PTYSessionInfo[] {
  return sessions.filter(
    (session) =>
      session.parentSessionId === parentSessionId &&
      (session.status === 'running' || session.status === 'killing')
  )
}
