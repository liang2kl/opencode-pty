import { describe, expect, it } from 'bun:test'
import type { PTYSessionInfo } from '../src/plugin/pty/types.ts'
import {
  PTY_LOG_LIMIT,
  activeSessionsForParent,
  appendLog,
  formatRunningTime,
  getPtyWebSocketUrl,
  removeSession,
  sameServerEndpoint,
  upsertSession,
} from '../src/tui/core.ts'

function session(overrides: Partial<PTYSessionInfo> = {}): PTYSessionInfo {
  return {
    id: 'pty_1',
    parentSessionId: 'session-a',
    title: 'Dev server',
    command: 'npm',
    args: ['run', 'dev'],
    workdir: '/tmp',
    status: 'running',
    notifyOnExit: false,
    timedOut: false,
    pid: 1234,
    createdAt: new Date().toISOString(),
    lineCount: 2,
    ...overrides,
  }
}

describe('PTY TUI core', () => {
  it('builds WebSocket URLs for IPv4 and IPv6 hosts', () => {
    expect(getPtyWebSocketUrl({ PTY_WEB_HOSTNAME: '100.72.194.42', PTY_WEB_PORT: '4097' })).toBe(
      'ws://100.72.194.42:4097/ws'
    )
    expect(getPtyWebSocketUrl({ PTY_WEB_HOSTNAME: '::1', PTY_WEB_PORT: '4097' })).toBe(
      'ws://[::1]:4097/ws'
    )
  })

  it('uses the shared broker default and rejects invalid ports', () => {
    expect(getPtyWebSocketUrl({ PTY_WEB_PORT: '0' })).toBeUndefined()
    expect(getPtyWebSocketUrl({})).toBe('ws://127.0.0.1:4097/ws')
  })

  it('matches OpenCode endpoints across hostname aliases but not ports', () => {
    expect(sameServerEndpoint('http://0.0.0.0:4096', 'http://100.72.194.42:4096')).toBe(true)
    expect(sameServerEndpoint('http://100.72.194.42:4096', 'http://100.72.194.42:4098')).toBe(false)
  })

  it('filters active PTYs to the current OpenCode session', () => {
    const sessions = [
      session(),
      session({ id: 'pty_2', parentSessionId: 'session-b' }),
      session({ id: 'pty_3', status: 'exited' }),
      session({ id: 'pty_4', status: 'killing' }),
    ]

    expect(activeSessionsForParent(sessions, 'session-a').map((item) => item.id)).toEqual([
      'pty_1',
      'pty_4',
    ])
  })

  it('updates an existing PTY snapshot without reordering it', () => {
    const current = [session(), session({ id: 'pty_2' })]
    const updated = upsertSession(current, session({ status: 'exited', lineCount: 10 }))

    expect(updated.map((item) => item.id)).toEqual(['pty_1', 'pty_2'])
    expect(updated[0]?.status).toBe('exited')
    expect(updated[0]?.lineCount).toBe(10)
  })

  it('removes cleaned-up PTYs from snapshots', () => {
    const current = [session(), session({ id: 'pty_2' })]

    expect(removeSession(current, 'pty_1').map((item) => item.id)).toEqual(['pty_2'])
  })

  it('formats running time from the task start', () => {
    const started = '2026-08-01T00:00:00.000Z'
    expect(formatRunningTime(started, Date.parse('2026-08-01T00:00:42.000Z'))).toBe(
      'Running for 42s'
    )
    expect(formatRunningTime(started, Date.parse('2026-08-01T00:02:05.000Z'))).toBe(
      'Running for 2m 5s'
    )
    expect(formatRunningTime(started, Date.parse('2026-08-01T03:04:00.000Z'))).toBe(
      'Running for 3h 4m'
    )
  })

  it('bounds retained popup output', () => {
    const output = appendLog('a'.repeat(PTY_LOG_LIMIT), 'tail')

    expect(output).toHaveLength(PTY_LOG_LIMIT)
    expect(output.endsWith('tail')).toBe(true)
  })
})
