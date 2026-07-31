import type { Server } from 'bun'
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
  public readonly server: Server<undefined>
  private readonly staticRoutes: Record<string, Response>
  private readonly stack = new DisposableStack()

  private constructor(
    staticRoutes: Record<string, Response>,
    private readonly owner: string
  ) {
    this.staticRoutes = staticRoutes
    this.server = this.startWebServer()
    this.stack.use(this.server)
    this.stack.use(new CallbackManager(this.server))
  }

  [Symbol.dispose]() {
    this.stack.dispose()
  }

  public static async createServer(owner: string = ''): Promise<PTYServer> {
    const staticRoutes = await buildStaticRoutes()

    return new PTYServer(staticRoutes, owner)
  }

  private startWebServer(): Server<undefined> {
    return Bun.serve({
      port: process.env.PTY_WEB_PORT ? parseInt(process.env.PTY_WEB_PORT, 10) : 0,
      hostname: process.env.PTY_WEB_HOSTNAME ?? '::1',

      routes: {
        ...this.staticRoutes,
        [routes.websocket.path]: (req: Request) => handleUpgrade(this.server, req),
        [routes.health.path]: () => handleHealth(this.server),
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
        data: undefined as undefined,
        perMessageDeflate: true,
        open: (ws) => {
          ws.subscribe('sessions:update')
          ws.send(JSON.stringify({ type: 'server_info', owner: this.owner }))
        },
        message: handleWebSocketMessage,
        close: (ws) => {
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
}
