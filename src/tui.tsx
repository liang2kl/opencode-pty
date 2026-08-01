/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { For, Show, createMemo, createSignal, onCleanup } from 'solid-js'
import type { PTYSessionInfo } from './plugin/pty/types.ts'
import type {
  WSMessageServer,
  WSMessageServerInfo,
  WSMessageServerSessionList,
  WSMessageServerSessionRemoved,
  WSMessageServerSessionUpdate,
} from './web/shared/types.ts'
import {
  PTY_RECONNECT_DELAY_MS,
  activeSessionsForParent,
  formatRunningTime,
  getPtyWebSocketUrl,
  removeSession,
  upsertSession,
} from './tui/core.ts'

const tui: TuiPlugin = async (api) => {
  const webSocketUrl = getPtyWebSocketUrl(process.env)
  const [sessions, setSessions] = createSignal<PTYSessionInfo[]>([])
  const [tasksOpen, setTasksOpen] = createSignal(true)
  let socket: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  const TaskRow = (props: { session: PTYSessionInfo }) => {
    const [now, setNow] = createSignal(Date.now())
    const timer = setInterval(() => {
      setNow(Date.now())
      api.renderer.requestRender()
    }, 1000)
    onCleanup(() => clearInterval(timer))
    const duration = createMemo(() => formatRunningTime(props.session.createdAt, now()))

    return (
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} fg={api.theme.current.success}>
          •
        </text>
        <box flexDirection="row" flexGrow={1} gap={1}>
          <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={api.theme.current.text}>
            {props.session.title}
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

  const handleMessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return
    const message = JSON.parse(event.data) as WSMessageServer
    switch (message.type) {
      case 'session_list': {
        const listed = (message as WSMessageServerSessionList).sessions
        setSessions(listed)
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
        break
      }
      case 'server_info': {
        const response = message as WSMessageServerInfo
        if (response.protocol !== 1) {
          socket?.close()
          break
        }
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
      setSessions([])
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
