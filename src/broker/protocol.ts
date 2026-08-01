import type { PTYSessionInfo, ReadResult, SearchResult, SpawnOptions } from '../plugin/pty/types.ts'

export const BROKER_PROTOCOL_VERSION = 1

export type BrokerOperation =
  | { type: 'spawn'; options: SpawnOptions; processEnv?: Record<string, string> }
  | { type: 'get'; id: string }
  | { type: 'list' }
  | { type: 'write'; id: string; data: string }
  | { type: 'read'; id: string; offset?: number; limit?: number }
  | { type: 'search'; id: string; pattern: string; flags: string; offset?: number; limit?: number }
  | { type: 'kill'; id: string; cleanup?: boolean }
  | { type: 'cleanupBySession'; parentSessionId: string }

export type BrokerResult =
  | PTYSessionInfo
  | PTYSessionInfo[]
  | ReadResult
  | SearchResult
  | boolean
  | null

export type BrokerSocketData = { role: 'viewer' } | { role: 'owner'; ownerId: string }

export interface BrokerReadyMessage {
  type: 'owner_ready'
  ownerId: string
  protocol: number
}

export interface BrokerExitMessage {
  type: 'session_exit'
  session: PTYSessionInfo
  exitCode: number
  lastLine: string
}

export interface BrokerHealth {
  protocol: number
  owners: number
}
