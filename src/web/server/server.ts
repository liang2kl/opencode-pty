import type { Server } from 'bun'
import { BROKER_PROTOCOL_VERSION, type BrokerSocketData } from '../../broker/protocol.ts'
import { LeaseManager } from '../../broker/lease-manager.ts'
import { handleBrokerRpc } from '../../broker/rpc.ts'
import { manager } from '../../plugin/pty/manager.ts'
import { routes } from '../shared/routes.ts'
import { CallbackManager } from './callback-manager.ts'
import { handleHealth } from './handlers/health.ts'
import {
  cleanupSession,
  clearSessions,
  createSession,
  getPlainBuffer,
  getRawBuffer,
  getSession,
  getSessions,
  killSession,
  sendInput,
} from './handlers/sessions.ts'
import { buildStaticRoutes } from './handlers/static.ts'
import { handleUpgrade } from './handlers/upgrade.ts'
import { handleWebSocketMessage } from './handlers/websocket.ts'

export class PTYServer implements Disposable {
  public readonly server: Server<BrokerSocketData>
  private readonly staticRoutes: Record<string, Response>
  private readonly stack = new DisposableStack()
  private readonly leases: LeaseManager
  private disposed = false

  private constructor(
    staticRoutes: Record<string, Response>,
    private readonly options: { broker: boolean; exitWhenIdle: boolean }
  ) {
    this.staticRoutes = staticRoutes
    this.server = this.startWebServer()
    this.stack.use(this.server)
    this.leases = new LeaseManager(options.exitWhenIdle, () => this.shutdown())
    this.stack.use(this.leases)
    this.stack.use(new CallbackManager(this.server))
  }

  [Symbol.dispose]() {
    if (this.disposed) return
    this.disposed = true
    this.stack.dispose()
  }

  public static async createServer(
    options: string | { broker?: boolean; exitWhenIdle?: boolean } = ''
  ): Promise<PTYServer> {
    const staticRoutes = await buildStaticRoutes()
    const resolved =
      typeof options === 'string'
        ? { broker: false, exitWhenIdle: false }
        : { broker: options.broker ?? false, exitWhenIdle: options.exitWhenIdle ?? false }
    return new PTYServer(staticRoutes, resolved)
  }

  private startWebServer(): Server<BrokerSocketData> {
    return Bun.serve({
      port: this.options.broker ? parseInt(process.env.PTY_WEB_PORT ?? '4097', 10) : 0,
      hostname: this.options.broker ? (process.env.PTY_WEB_HOSTNAME ?? '127.0.0.1') : '::1',

      routes: {
        ...this.staticRoutes,
        [routes.websocket.path]: (req: Request) => handleUpgrade(this.server, req),
        [routes.health.path]: () =>
          handleHealth(
            this.server,
            this.options.broker
              ? { protocol: BROKER_PROTOCOL_VERSION, owners: this.leases?.size ?? 0 }
              : undefined
          ),
        [routes.broker.path]: {
          POST: (req: Request) => handleBrokerRpc(req, this.leases),
        },
        [routes.sessions.path]: {
          GET: getSessions,
          POST: createSession,
          DELETE: clearSessions,
        },
        [routes.session.path]: {
          GET: getSession,
          DELETE: killSession,
        },
        [routes.session.cleanup.path]: {
          DELETE: cleanupSession,
        },
        [routes.session.input.path]: {
          POST: sendInput,
        },
        [routes.session.buffer.raw.path]: {
          GET: getRawBuffer,
        },
        [routes.session.buffer.plain.path]: {
          GET: getPlainBuffer,
        },
      },

      websocket: {
        data: {} as BrokerSocketData,
        perMessageDeflate: true,
        open: (ws) => {
          if (ws.data.role === 'owner') {
            this.leases.add(ws.data.ownerId, ws)
            ws.send(
              JSON.stringify({
                type: 'owner_ready',
                ownerId: ws.data.ownerId,
                protocol: BROKER_PROTOCOL_VERSION,
              })
            )
            return
          }
          ws.subscribe('sessions:update')
          ws.send(JSON.stringify({ type: 'server_info', protocol: BROKER_PROTOCOL_VERSION }))
        },
        message: (ws, message) => {
          if (ws.data.role === 'viewer') handleWebSocketMessage(ws, message)
        },
        close: (ws) => {
          if (ws.data.role === 'owner') {
            this.leases.remove(ws.data.ownerId, ws)
            return
          }
          ws.subscriptions.forEach((topic) => {
            ws.unsubscribe(topic)
          })
        },
      },

      fetch: () => new Response(null, { status: 302, headers: { Location: '/index.html' } }),
    })
  }

  public getWsUrl(): string {
    return `${this.server.url.origin.replace(/^http/, 'ws')}${routes.websocket.path}`
  }

  private shutdown(): void {
    if (this.disposed) return
    manager.clearAllSessions()
    this[Symbol.dispose]()
    if (this.options.exitWhenIdle) setTimeout(() => process.exit(0), 0)
  }
}
