import { fileURLToPath } from 'node:url'
import type { OpencodeClient } from '@opencode-ai/sdk'
import type {
  BrokerExitMessage,
  BrokerOperation,
  BrokerReadyMessage,
  BrokerResult,
} from '../../broker/protocol.ts'
import { BROKER_PROTOCOL_VERSION } from '../../broker/protocol.ts'
import { NotificationManager } from './notification-manager.ts'

const START_TIMEOUT_MS = 30_000

function brokerOrigin(): string {
  const hostname = process.env.PTY_WEB_HOSTNAME ?? '127.0.0.1'
  const port = process.env.PTY_WEB_PORT ?? '4097'
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
  return `http://${host}:${port}`
}

async function health(origin: string): Promise<{ broker?: { protocol: number } } | undefined> {
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(300) })
    if (!response.ok) return
    return (await response.json()) as { broker?: { protocol: number } }
  } catch {
    return
  }
}

function brokerEntryPath(): string {
  const extension = import.meta.path.endsWith('.ts') ? 'ts' : 'js'
  return fileURLToPath(new URL(`../../broker/entry.${extension}`, import.meta.url))
}

async function ensureBroker(origin: string): Promise<void> {
  const existing = await health(origin)
  if (existing) {
    if (existing.broker?.protocol === BROKER_PROTOCOL_VERSION) return
    throw new Error(`${origin} is occupied by an incompatible PTY server`)
  }

  const bun = Bun.which('bun')
  const npx = Bun.which('npx')
  if (!bun && !npx) {
    throw new Error('The bun executable or npx is required to launch the shared PTY broker')
  }
  const command = bun
    ? [bun, brokerEntryPath()]
    : [npx as string, '--yes', 'bun', brokerEntryPath()]
  const child = Bun.spawn({
    cmd: command,
    env: process.env,
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  child.unref()

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await health(origin)
    if (result?.broker?.protocol === BROKER_PROTOCOL_VERSION) return
    await Bun.sleep(50)
  }
  throw new Error(`Timed out starting shared PTY broker at ${origin}`)
}

export class BrokerClient implements Disposable {
  readonly ownerId = crypto.randomUUID()
  readonly origin = brokerOrigin()
  private socket: WebSocket | undefined
  private readonly notifications = new NotificationManager()
  private disposed = false
  private autoReconnect = false
  private reconnectPromise: Promise<void> | undefined

  private constructor(client: OpencodeClient) {
    this.notifications.init(client)
  }

  static async connect(client: OpencodeClient): Promise<BrokerClient> {
    const broker = new BrokerClient(client)
    await broker.reconnect()
    broker.autoReconnect = true
    return broker
  }

  private async openLease(): Promise<void> {
    if (this.disposed) throw new Error('PTY broker client is disposed')
    const url = new URL('/ws', this.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('role', 'owner')
    url.searchParams.set('ownerId', this.ownerId)

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url)
      this.socket = socket
      let settled = false
      const timeout = setTimeout(() => {
        settled = true
        socket.close()
        reject(new Error('Timed out acquiring PTY broker lease'))
      }, 2000)
      socket.onerror = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        socket.close()
        reject(new Error('Failed to acquire PTY broker lease'))
      }
      socket.onclose = () => {
        if (this.socket === socket) this.socket = undefined
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          reject(new Error('PTY broker lease closed during startup'))
        }
        if (this.autoReconnect && !this.disposed) void this.reconnect().catch(() => {})
      }
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        const message = JSON.parse(event.data) as BrokerReadyMessage | BrokerExitMessage
        if (message.type === 'owner_ready') {
          if (settled) return
          if (message.ownerId !== this.ownerId || message.protocol !== BROKER_PROTOCOL_VERSION) {
            settled = true
            clearTimeout(timeout)
            socket.close(1002, 'invalid broker identity')
            reject(new Error('PTY broker returned an invalid lease identity'))
            return
          }
          settled = true
          clearTimeout(timeout)
          resolve()
          return
        }
        if (message.type === 'session_exit') {
          if (message.ownerId && message.ownerId !== this.ownerId) return
          void this.notifications.sendExitNotification(
            message.session,
            message.exitCode,
            message.lastLine
          )
        }
      }
    })
  }

  private reconnect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve()
    if (this.reconnectPromise) return this.reconnectPromise
    this.reconnectPromise = (async () => {
      let lastError: unknown
      for (let attempt = 0; attempt < 3 && !this.disposed; attempt++) {
        try {
          await ensureBroker(this.origin)
          if (this.disposed) throw new Error('PTY broker client is disposed')
          await this.openLease()
          return
        } catch (error) {
          lastError = error
          await Bun.sleep(100)
        }
      }
      throw lastError instanceof Error ? lastError : new Error('Failed to connect to PTY broker')
    })().finally(() => {
      this.reconnectPromise = undefined
    })
    return this.reconnectPromise
  }

  async request<T extends BrokerResult>(operation: BrokerOperation): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN) await this.reconnect()
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('PTY broker lease is closed')
    const response = await fetch(`${this.origin}/api/broker`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.ownerId}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(operation),
    })
    const body = (await response.json()) as T | { error?: string }
    if (!response.ok) {
      throw new Error(
        body && 'error' in body && body.error ? body.error : `PTY broker error ${response.status}`
      )
    }
    return body as T
  }

  [Symbol.dispose](): void {
    this.disposed = true
    this.autoReconnect = false
    this.socket?.close(1000, 'plugin disposed')
    this.socket = undefined
  }
}
