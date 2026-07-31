/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui'
import type { ScrollBoxRenderable } from '@opentui/core'
import { For, Show, createMemo, createSignal } from 'solid-js'
import type { PTYSessionInfo } from './plugin/pty/types.ts'
import type {
  WSMessageServer,
  WSMessageServerRawData,
  WSMessageServerReadRawResponse,
  WSMessageServerInfo,
  WSMessageServerSessionList,
  WSMessageServerSessionRemoved,
  WSMessageServerSessionUpdate,
} from './web/shared/types.ts'
import {
  PTY_RECONNECT_DELAY_MS,
  activeSessionsForParent,
  appendLog,
  getPtyWebSocketUrl,
  removeSession,
  sameServerEndpoint,
  upsertSession,
} from './tui/core.ts'

function plainOutput(data: string): string {
  return Bun.stripANSI(data).replaceAll('\r', '')
}

const tui: TuiPlugin = async (api) => {
  const webSocketUrl = getPtyWebSocketUrl(process.env)
  const [connected, setConnected] = createSignal(false)
  const [connectionError, setConnectionError] = createSignal<string>()
  const [sessions, setSessions] = createSignal<PTYSessionInfo[]>([])
  const [logs, setLogs] = createSignal<Record<string, string>>({})
  const loadingLogs = new Set<string>()
  let socket: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let activeLogSessionId: string | undefined
  let expectedOwner: string | undefined

  const send = (message: object) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  const openLogs = (initial: PTYSessionInfo) => {
    if (!connected()) {
      api.ui.toast({ variant: 'warning', message: 'PTY server is not connected' })
      return
    }

    activeLogSessionId = initial.id
    loadingLogs.add(initial.id)
    send({ type: 'subscribe', sessionId: initial.id })
    send({ type: 'readRaw', sessionId: initial.id })

    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(
      () => {
        const session = createMemo(
          () => sessions().find((item) => item.id === initial.id) ?? initial
        )
        return (
          <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1} flexDirection="column">
            <box flexDirection="row" justifyContent="space-between">
              <text fg={api.theme.current.text}>
                <b>{session().title}</b>
              </text>
              <text fg={api.theme.current.textMuted}>esc dismiss</text>
            </box>
            <text fg={api.theme.current.textMuted}>
              {session().status} | pid {session().pid} | {session().lineCount} lines
            </text>
            <scrollbox
              ref={(value: ScrollBoxRenderable) => {
                setTimeout(() => value.scrollTo(value.scrollHeight), 0)
              }}
              height={24}
              stickyScroll
              stickyStart="bottom"
            >
              <text fg={api.theme.current.text} wrapMode="word">
                {logs()[initial.id] || 'Waiting for output...'}
              </text>
            </scrollbox>
          </box>
        )
      },
      () => {
        loadingLogs.delete(initial.id)
        if (activeLogSessionId === initial.id) activeLogSessionId = undefined
        send({ type: 'unsubscribe', sessionId: initial.id })
      }
    )
  }

  const handleMessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return
    const message = JSON.parse(event.data) as WSMessageServer
    switch (message.type) {
      case 'session_list': {
        const listed = (message as WSMessageServerSessionList).sessions
        setSessions(listed)
        if (activeLogSessionId) {
          if (!listed.some((session) => session.id === activeLogSessionId)) {
            api.ui.dialog.clear()
            break
          }
          loadingLogs.add(activeLogSessionId)
          send({ type: 'subscribe', sessionId: activeLogSessionId })
          send({ type: 'readRaw', sessionId: activeLogSessionId })
        }
        break
      }
      case 'session_update':
        setSessions((current) =>
          upsertSession(current, (message as WSMessageServerSessionUpdate).session)
        )
        break
      case 'session_removed': {
        const response = message as WSMessageServerSessionRemoved
        setSessions((current) => removeSession(current, response.sessionId))
        setLogs((current) => {
          const next = { ...current }
          delete next[response.sessionId]
          return next
        })
        if (activeLogSessionId === response.sessionId) api.ui.dialog.clear()
        break
      }
      case 'readRawResponse': {
        const response = message as WSMessageServerReadRawResponse
        setLogs((current) => ({
          ...current,
          [response.sessionId]: appendLog('', plainOutput(response.rawData)),
        }))
        loadingLogs.delete(response.sessionId)
        break
      }
      case 'raw_data': {
        const response = message as WSMessageServerRawData
        setSessions((current) => upsertSession(current, response.session))
        if (loadingLogs.has(response.session.id)) break
        setLogs((current) => ({
          ...current,
          [response.session.id]: appendLog(
            current[response.session.id] ?? '',
            plainOutput(response.rawData)
          ),
        }))
        break
      }
      case 'server_info': {
        const response = message as WSMessageServerInfo
        if (expectedOwner && !sameServerEndpoint(expectedOwner, response.owner)) {
          setConnectionError('wrong backend')
          socket?.close()
          break
        }
        setConnectionError(undefined)
        setConnected(true)
        send({ type: 'session_list' })
        break
      }
    }
  }

  const connect = async () => {
    if (!webSocketUrl || api.lifecycle.signal.aborted) return
    if (!expectedOwner) {
      try {
        const result = await api.client.global.health()
        if (!result.response?.url) throw new Error('OpenCode health response has no URL')
        expectedOwner = new URL(result.response.url).origin
      } catch {
        setConnectionError('backend unavailable')
        reconnectTimer = setTimeout(() => void connect(), PTY_RECONNECT_DELAY_MS)
        return
      }
    }
    if (api.lifecycle.signal.aborted) return
    const next = new WebSocket(webSocketUrl)
    socket = next
    next.onmessage = handleMessage
    next.onerror = () => next.close()
    next.onclose = () => {
      if (socket !== next) return
      setConnected(false)
      setSessions([])
      loadingLogs.clear()
      if (api.lifecycle.signal.aborted) return
      reconnectTimer = setTimeout(() => void connect(), PTY_RECONNECT_DELAY_MS)
    }
  }

  void connect()
  api.lifecycle.onDispose(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    socket?.close()
  })

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(ctx, value) {
        const active = createMemo(() => activeSessionsForParent(sessions(), value.session_id))
        return (
          <box
            border
            borderColor={ctx.theme.current.border}
            backgroundColor={ctx.theme.current.backgroundPanel}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
            flexDirection="column"
            gap={1}
          >
            <box flexDirection="row" justifyContent="space-between">
              <text fg={ctx.theme.current.primary}>
                <b>PTY sessions</b>
              </text>
              <text fg={connected() ? ctx.theme.current.success : ctx.theme.current.warning}>
                {connected() ? 'live' : (connectionError() ?? 'offline')}
              </text>
            </box>
            <Show
              when={webSocketUrl}
              fallback={<text fg={ctx.theme.current.textMuted}>Set PTY_WEB_PORT to enable</text>}
            >
              <Show
                when={active().length > 0}
                fallback={<text fg={ctx.theme.current.textMuted}>No running sessions</text>}
              >
                <For each={active()}>
                  {(session) => (
                    // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes are not DOM elements.
                    <box
                      flexDirection="column"
                      onMouseUp={() => openLogs(session)}
                      backgroundColor={ctx.theme.current.backgroundElement}
                      paddingLeft={1}
                      paddingRight={1}
                    >
                      <text fg={ctx.theme.current.text}>{session.title}</text>
                      <text fg={ctx.theme.current.textMuted}>
                        {session.status} | pid {session.pid}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </Show>
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: 'opencode-pty',
  tui,
}

export default plugin
