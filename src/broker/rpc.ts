import { manager } from '../plugin/pty/manager.ts'
import type { BrokerOperation } from './protocol.ts'
import type { LeaseManager } from './lease-manager.ts'
import { ErrorResponse, JsonResponse } from '../web/server/handlers/responses.ts'

function ownerFromRequest(request: Request): string | undefined {
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return
  return authorization.slice('Bearer '.length)
}

export async function handleBrokerRpc(request: Request, leases: LeaseManager): Promise<Response> {
  const ownerId = ownerFromRequest(request)
  if (!ownerId || !leases.has(ownerId)) return new ErrorResponse('Invalid broker lease', 401)

  let operation: BrokerOperation
  try {
    operation = (await request.json()) as BrokerOperation
  } catch {
    return new ErrorResponse('Invalid broker request', 400)
  }
  if (!leases.has(ownerId)) return new ErrorResponse('Broker lease closed', 401)

  const owns = (id: string) => manager.owns(ownerId, id)

  try {
    switch (operation.type) {
      case 'spawn':
        return new JsonResponse(
          manager.spawnOwned(ownerId, {
            ...operation.options,
            env: { ...operation.processEnv, ...operation.options.env },
          })
        )
      case 'list':
        return new JsonResponse(manager.listOwned(ownerId))
      case 'get':
        return new JsonResponse(owns(operation.id) ? manager.get(operation.id) : null)
      case 'write':
        return new JsonResponse(owns(operation.id) && manager.write(operation.id, operation.data))
      case 'read':
        return new JsonResponse(
          owns(operation.id) ? manager.read(operation.id, operation.offset, operation.limit) : null
        )
      case 'search':
        return new JsonResponse(
          owns(operation.id)
            ? manager.search(
                operation.id,
                new RegExp(operation.pattern, operation.flags),
                operation.offset,
                operation.limit
              )
            : null
        )
      case 'kill':
        return new JsonResponse(
          owns(operation.id) && manager.kill(operation.id, operation.cleanup ?? false)
        )
      case 'cleanupBySession':
        for (const session of manager.listOwned(ownerId)) {
          if (session.parentSessionId === operation.parentSessionId) {
            manager.kill(session.id, true)
          }
        }
        return new JsonResponse(true)
    }
  } catch (error) {
    return new ErrorResponse(error instanceof Error ? error.message : String(error), 400)
  }
}
