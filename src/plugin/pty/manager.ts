import { Terminal } from 'bun-pty'
import { OutputManager } from './output-manager.ts'
import { SessionLifecycleManager } from './session-lifecycle.ts'
import type { PTYSessionInfo, ReadResult, SearchResult, SpawnOptions } from './types.ts'
import { withSession } from './utils.ts'

const proto = Terminal.prototype as unknown as { _startReadLoop?: (...args: unknown[]) => unknown }

const original = proto._startReadLoop

if (typeof original === 'function') {
  proto._startReadLoop = async function (this: InstanceType<typeof Terminal>, ...args: unknown[]) {
    await Promise.resolve() // Yield to allow event handlers to be registered
    return original.apply(this, args)
  }
}

type SessionUpdateCallback = (session: PTYSessionInfo) => void

export const sessionUpdateCallbacks: SessionUpdateCallback[] = []

export function registerSessionUpdateCallback(callback: SessionUpdateCallback) {
  sessionUpdateCallbacks.push(callback)
}

export function removeSessionUpdateCallback(callback: SessionUpdateCallback) {
  const index = sessionUpdateCallbacks.indexOf(callback)
  if (index !== -1) {
    sessionUpdateCallbacks.splice(index, 1)
  }
}

function notifySessionUpdate(session: PTYSessionInfo) {
  for (const callback of sessionUpdateCallbacks) {
    try {
      callback(session)
    } catch {
      // Ignore callback errors
    }
  }
}

type SessionRemoveCallback = (sessionId: string) => void

export const sessionRemoveCallbacks: SessionRemoveCallback[] = []

export function registerSessionRemoveCallback(callback: SessionRemoveCallback) {
  sessionRemoveCallbacks.push(callback)
}

export function removeSessionRemoveCallback(callback: SessionRemoveCallback) {
  const index = sessionRemoveCallbacks.indexOf(callback)
  if (index !== -1) sessionRemoveCallbacks.splice(index, 1)
}

function notifySessionRemove(sessionId: string) {
  for (const callback of sessionRemoveCallbacks) {
    try {
      callback(sessionId)
    } catch {
      // Ignore callback errors
    }
  }
}

type RawOutputCallback = (session: PTYSessionInfo, rawData: string) => void

export const rawOutputCallbacks: RawOutputCallback[] = []

export function registerRawOutputCallback(callback: RawOutputCallback): void {
  rawOutputCallbacks.push(callback)
}

export function removeRawOutputCallback(callback: RawOutputCallback): void {
  const index = rawOutputCallbacks.indexOf(callback)
  if (index !== -1) {
    rawOutputCallbacks.splice(index, 1)
  }
}

function notifyRawOutput(session: PTYSessionInfo, rawData: string): void {
  for (const callback of rawOutputCallbacks) {
    try {
      callback(session, rawData)
    } catch {
      // Ignore callback errors
    }
  }
}

export type SessionExitCallback = (
  ownerId: string,
  session: PTYSessionInfo,
  exitCode: number,
  lastLine: string
) => void

export const sessionExitCallbacks: SessionExitCallback[] = []

export function registerSessionExitCallback(callback: SessionExitCallback): void {
  sessionExitCallbacks.push(callback)
}

export function removeSessionExitCallback(callback: SessionExitCallback): void {
  const index = sessionExitCallbacks.indexOf(callback)
  if (index !== -1) sessionExitCallbacks.splice(index, 1)
}

function notifySessionExit(
  ownerId: string,
  session: PTYSessionInfo,
  exitCode: number,
  lastLine: string
): void {
  for (const callback of sessionExitCallbacks) {
    try {
      callback(ownerId, session, exitCode, lastLine)
    } catch {
      // Ignore callback errors
    }
  }
}

function getLastLine(lines: string[]): string {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (line?.trim()) return line
  }
  return ''
}

export class PTYManager {
  private lifecycleManager = new SessionLifecycleManager()
  private outputManager = new OutputManager()

  clearAllSessions(): void {
    const ids = this.list().map((session) => session.id)
    this.lifecycleManager.clearAllSessions()
    ids.forEach(notifySessionRemove)
  }

  spawn(opts: SpawnOptions): PTYSessionInfo {
    return this.spawnOwned('legacy', opts)
  }

  spawnOwned(ownerId: string, opts: SpawnOptions): PTYSessionInfo {
    const session = this.lifecycleManager.spawn(
      ownerId,
      opts,
      (session, data) => {
        notifyRawOutput(this.lifecycleManager.toInfo(session), data)
      },
      async (session, exitCode) => {
        if (!this.lifecycleManager.getSession(session.id)) return
        const info = this.lifecycleManager.toInfo(session)
        notifySessionUpdate(info)
        if (session.notifyOnExit) {
          notifySessionExit(
            session.ownerId,
            info,
            exitCode || 0,
            getLastLine(session.buffer.read())
          )
        }
      }
    )
    notifySessionUpdate(session)
    return session
  }

  write(id: string, data: string): boolean {
    return withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.write(session, data),
      false
    )
  }

  read(id: string, offset: number = 0, limit?: number): ReadResult | null {
    return withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.read(session, offset, limit),
      null
    )
  }

  search(id: string, pattern: RegExp, offset: number = 0, limit?: number): SearchResult | null {
    return withSession(
      this.lifecycleManager,
      id,
      (session) => this.outputManager.search(session, pattern, offset, limit),
      null
    )
  }

  list(): PTYSessionInfo[] {
    return this.lifecycleManager.listSessions().map((s) => this.lifecycleManager.toInfo(s))
  }

  get(id: string): PTYSessionInfo | null {
    return withSession(
      this.lifecycleManager,
      id,
      (session) => this.lifecycleManager.toInfo(session),
      null
    )
  }

  owns(ownerId: string, id: string): boolean {
    return this.lifecycleManager.getSession(id)?.ownerId === ownerId
  }

  listOwned(ownerId: string): PTYSessionInfo[] {
    return this.lifecycleManager
      .listSessions()
      .filter((session) => session.ownerId === ownerId)
      .map((session) => this.lifecycleManager.toInfo(session))
  }

  getRawBuffer(id: string): { raw: string; byteLength: number } | null {
    return withSession(
      this.lifecycleManager,
      id,
      (session) => ({
        raw: session.buffer.readRaw(),
        byteLength: session.buffer.byteLength,
      }),
      null
    )
  }

  kill(id: string, cleanup: boolean = false): boolean {
    const removed = cleanup && this.lifecycleManager.getSession(id) !== null
    const success = this.lifecycleManager.kill(id, cleanup)
    if (success && removed) notifySessionRemove(id)
    return success
  }

  cleanupBySession(parentSessionId: string): void {
    const ids = this.list()
      .filter((session) => session.parentSessionId === parentSessionId)
      .map((session) => session.id)
    this.lifecycleManager.cleanupBySession(parentSessionId)
    ids.forEach(notifySessionRemove)
  }

  cleanupByOwner(ownerId: string): void {
    const ids = this.lifecycleManager
      .listSessions()
      .filter((session) => session.ownerId === ownerId)
      .map((session) => session.id)
    for (const id of ids) this.lifecycleManager.kill(id, true)
    ids.forEach(notifySessionRemove)
  }
}

export const manager = new PTYManager()

export function initManager(_client?: unknown): void {}
