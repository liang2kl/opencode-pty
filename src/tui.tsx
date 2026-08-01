/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui'
import type { ScrollBoxRenderable } from '@opentui/core'
import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js'
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
  formatRunningTime,
  getPtyWebSocketUrl,
  removeSession,
  truncateTaskTitle,
  upsertSession,
} from './tui/core.ts'

const TASK_ROW_TEXT_WIDTH = 35

function plainOutput(data: string): string {
  return Bun.stripANSI(data).replaceAll('\r', '')
}

const tui: TuiPlugin = async (api) => {
  const webSocketUrl = getPtyWebSocketUrl(process.env)
  const [connected, setConnected] = createSignal(false)
  const [sessions, setSessions] = createSignal<PTYSessionInfo[]>([])
  const [logs, setLogs] = createSignal<Record<string, string>>({})
  const [tasksOpen, setTasksOpen] = createSignal(true)
  const loadingLogs = new Set<string>()
  let socket: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let activeLogSessionId: string | undefined

  const TaskRow = (props: { session: PTYSessionInfo }) => {
    const [now, setNow] = createSignal(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
    const duration = createMemo(() => formatRunningTime(props.session.createdAt, now()))
    const title = createMemo(() =>
      truncateTaskTitle(props.session.title, duration(), TASK_ROW_TEXT_WIDTH)
    )

    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes are not DOM elements.
      <box flexDirection="row" gap={1} onMouseUp={() => openLogs(props.session)}>
        <text flexShrink={0} fg={api.theme.current.success}>
          •
        </text>
        <box flexDirection="row" flexGrow={1} justifyContent="space-between">
          <text wrapMode="none" fg={api.theme.current.text}>
            {title()}
          </text>
          <text flexShrink={0} fg={api.theme.current.textMuted}>
            {duration()}
          </text>
        </box>
      </box>
    )
  }

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
        const dialogWidth = () => Math.max(1, Math.floor(api.renderer.width / 2))
        const dialogHeight = () => Math.max(1, Math.floor(api.renderer.height / 2))
        const logHeight = () => Math.max(1, dialogHeight() - 6)
        let logViewport: ScrollBoxRenderable | undefined
        return (
          <box
            width={dialogWidth()}
            height={dialogHeight()}
            paddingLeft={2}
            paddingRight={2}
            paddingBottom={1}
            gap={1}
            flexDirection="column"
          >
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
                if (logViewport === value) return
                logViewport = value
                setTimeout(() => value.scrollTo(value.scrollHeight), 0)
              }}
              width="100%"
              height={logHeight()}
            >
              <text width="100%" fg={api.theme.current.text} wrapMode="word">
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
        if (response.protocol !== 1) {
          socket?.close()
          break
        }
        setConnected(true)
        send({ type: 'session_list' })
        break
      }
    }
  }

  const connect = async () => {
    if (!webSocketUrl || api.lifecycle.signal.aborted) return
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
          <Show when={webSocketUrl && active().length > 0}>
            <box>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes are not DOM elements. */}
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => active().length > 2 && setTasksOpen((open) => !open)}
              >
                <Show when={active().length > 2}>
                  <text fg={ctx.theme.current.text}>{tasksOpen() ? '▼' : '▶'}</text>
                </Show>
                <text fg={ctx.theme.current.text}>
                  <b>Tasks</b>
                </text>
              </box>
              <Show when={active().length <= 2 || tasksOpen()}>
                <For each={active()}>{(session) => <TaskRow session={session} />}</For>
              </Show>
            </box>
          </Show>
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
