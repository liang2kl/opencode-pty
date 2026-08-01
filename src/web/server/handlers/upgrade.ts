import type { BrokerSocketData } from '../../../broker/protocol.ts'

export function handleUpgrade(server: Bun.Server<BrokerSocketData>, req: Request) {
  if (!(req.headers.get('upgrade') === 'websocket')) {
    return new Response('WebSocket endpoint - use WebSocket upgrade', { status: 426 })
  }
  const url = new URL(req.url)
  const ownerId = url.searchParams.get('ownerId')
  const data: BrokerSocketData =
    url.searchParams.get('role') === 'owner' && ownerId
      ? { role: 'owner', ownerId }
      : { role: 'viewer' }
  const success = server.upgrade(req, { data })
  if (success) {
    return undefined // Upgrade succeeded, Bun sends 101 automatically
  }
  return new Response('WebSocket upgrade failed', { status: 400 })
}
