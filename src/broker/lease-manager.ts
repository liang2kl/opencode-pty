import type { ServerWebSocket } from 'bun'
import {
  manager,
  registerSessionExitCallback,
  removeSessionExitCallback,
} from '../plugin/pty/manager.ts'
import type { BrokerExitMessage, BrokerSocketData } from './protocol.ts'

export class LeaseManager implements Disposable {
  private readonly owners = new Map<string, ServerWebSocket<BrokerSocketData>>()
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pendingExitMessages = new Map<string, BrokerExitMessage[]>()
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly exitWhenIdle: boolean,
    private readonly onIdle: () => void
  ) {
    registerSessionExitCallback(this.onSessionExit)
    if (exitWhenIdle) this.scheduleIdleExit(5000)
  }

  get size(): number {
    return this.owners.size
  }

  has(ownerId: string): boolean {
    return this.owners.has(ownerId)
  }

  add(ownerId: string, socket: ServerWebSocket<BrokerSocketData>): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    const cleanupTimer = this.cleanupTimers.get(ownerId)
    if (cleanupTimer) clearTimeout(cleanupTimer)
    this.cleanupTimers.delete(ownerId)
    const previous = this.owners.get(ownerId)
    this.owners.set(ownerId, socket)
    if (previous && previous !== socket) previous.close(1000, 'lease replaced')
    for (const message of this.pendingExitMessages.get(ownerId) ?? []) {
      socket.send(JSON.stringify(message))
    }
    this.pendingExitMessages.delete(ownerId)
  }

  remove(ownerId: string, socket: ServerWebSocket<BrokerSocketData>): void {
    if (this.owners.get(ownerId) !== socket) return
    this.owners.delete(ownerId)
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(ownerId)
      this.pendingExitMessages.delete(ownerId)
      if (this.owners.has(ownerId)) return
      manager.cleanupByOwner(ownerId)
      if (this.exitWhenIdle && this.owners.size === 0 && this.cleanupTimers.size === 0) {
        this.scheduleIdleExit(250)
      }
    }, 2000)
    this.cleanupTimers.set(ownerId, timer)
  }

  private scheduleIdleExit(delay: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.owners.size === 0) this.onIdle()
    }, delay)
  }

  private onSessionExit = (
    ownerId: string,
    session: BrokerExitMessage['session'],
    exitCode: number,
    lastLine: string
  ): void => {
    const message: BrokerExitMessage = {
      type: 'session_exit',
      ownerId,
      session,
      exitCode,
      lastLine,
    }
    const socket = this.owners.get(ownerId)
    if (!socket) {
      if (this.cleanupTimers.has(ownerId)) {
        const pending = this.pendingExitMessages.get(ownerId) ?? []
        pending.push(message)
        this.pendingExitMessages.set(ownerId, pending)
      }
      return
    }
    socket.send(JSON.stringify(message))
  };

  [Symbol.dispose](): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer)
    this.cleanupTimers.clear()
    this.pendingExitMessages.clear()
    removeSessionExitCallback(this.onSessionExit)
    for (const ownerId of this.owners.keys()) manager.cleanupByOwner(ownerId)
    this.owners.clear()
  }
}
