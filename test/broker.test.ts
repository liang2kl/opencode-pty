import { afterEach, describe, expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { LeaseManager } from '../src/broker/lease-manager.ts'
import type { BrokerSocketData } from '../src/broker/protocol.ts'
import { handleBrokerRpc } from '../src/broker/rpc.ts'
import { manager } from '../src/plugin/pty/manager.ts'

function fakeSocket(messages: string[] = []): ServerWebSocket<BrokerSocketData> {
  return {
    send: (message: string) => {
      messages.push(message)
      return 0
    },
    close: () => {},
  } as unknown as ServerWebSocket<BrokerSocketData>
}

function spawn(ownerId: string, parentSessionId: string) {
  return manager.spawnOwned(ownerId, {
    command: '/bin/sh',
    args: ['-c', 'sleep 30'],
    parentSessionId,
  })
}

async function rpc(ownerId: string, operation: object, leases: LeaseManager) {
  return handleBrokerRpc(
    new Request('http://127.0.0.1/api/broker', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownerId}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(operation),
    }),
    leases
  )
}

describe('shared broker leases', () => {
  afterEach(() => {
    manager.clearAllSessions()
  })

  it('cleans up only the exiting owner and signals idle after the last owner', async () => {
    let idleCount = 0
    using leases = new LeaseManager(true, () => {
      idleCount++
    })
    const firstSocket = fakeSocket()
    const secondSocket = fakeSocket()
    leases.add('first', firstSocket)
    leases.add('second', secondSocket)

    const first = spawn('first', 'session-first')
    const second = spawn('second', 'session-second')

    leases.remove('first', firstSocket)
    expect(manager.get(first.id)).not.toBeNull()
    expect(manager.get(second.id)).not.toBeNull()
    expect(idleCount).toBe(0)

    await Bun.sleep(2100)
    expect(manager.get(first.id)).toBeNull()
    expect(manager.get(second.id)).not.toBeNull()

    leases.remove('second', secondSocket)
    await Bun.sleep(2400)
    expect(manager.get(second.id)).toBeNull()
    expect(idleCount).toBe(1)
  })

  it('scopes broker RPC operations to the calling owner', async () => {
    using leases = new LeaseManager(false, () => {})
    leases.add('first', fakeSocket())
    leases.add('second', fakeSocket())
    const first = spawn('first', 'session-first')
    const second = spawn('second', 'session-second')

    const firstList = await rpc('first', { type: 'list' }, leases)
    expect((await firstList.json()) as Array<{ id: string }>).toEqual([
      expect.objectContaining({ id: first.id }),
    ])

    const crossOwnerGet = await rpc('first', { type: 'get', id: second.id }, leases)
    expect(await crossOwnerGet.json()).toBeNull()

    const crossOwnerKill = await rpc(
      'first',
      { type: 'kill', id: second.id, cleanup: true },
      leases
    )
    expect(await crossOwnerKill.json()).toBe(false)
    expect(manager.get(second.id)).not.toBeNull()
  })

  it('replays exit notifications after a lease reconnects within the grace period', async () => {
    using leases = new LeaseManager(false, () => {})
    const firstSocket = fakeSocket()
    leases.add('owner', firstSocket)
    manager.spawnOwned('owner', {
      command: '/bin/sh',
      args: ['-c', 'sleep 0.1'],
      parentSessionId: 'session',
      notifyOnExit: true,
    })

    leases.remove('owner', firstSocket)
    await Bun.sleep(200)

    const replayed: string[] = []
    leases.add('owner', fakeSocket(replayed))
    const exit = replayed
      .map((message) => JSON.parse(message))
      .find((message) => message.type === 'session_exit')
    expect(exit).toEqual(expect.objectContaining({ ownerId: 'owner' }))
  })

  it('routes same-session exit notifications only to the spawning owner', async () => {
    using leases = new LeaseManager(false, () => {})
    const firstMessages: string[] = []
    const secondMessages: string[] = []
    leases.add('first', fakeSocket(firstMessages))
    leases.add('second', fakeSocket(secondMessages))

    manager.spawnOwned('first', {
      command: '/bin/sh',
      args: ['-c', 'exit 0'],
      parentSessionId: 'shared-session',
      notifyOnExit: true,
    })

    await Bun.sleep(200)

    const firstExits = firstMessages
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === 'session_exit')
    const secondExits = secondMessages
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === 'session_exit')
    expect(firstExits).toHaveLength(1)
    expect(firstExits[0]).toEqual(
      expect.objectContaining({
        ownerId: 'first',
        session: expect.objectContaining({ parentSessionId: 'shared-session' }),
      })
    )
    expect(secondExits).toHaveLength(0)
  })
})
