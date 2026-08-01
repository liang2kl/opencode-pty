import type { PluginContext, PluginResult } from './plugin/types.ts'
import { initPermissions } from './plugin/pty/permissions.ts'
import { BrokerClient } from './plugin/pty/broker-client.ts'
import type { BrokerOperation, BrokerResult, BrokerTransport } from './broker/protocol.ts'
import { createPtySpawn } from './plugin/pty/tools/spawn.ts'
import { createPtyWrite } from './plugin/pty/tools/write.ts'
import { createPtyRead } from './plugin/pty/tools/read.ts'
import { createPtyList } from './plugin/pty/tools/list.ts'
import { createPtyKill } from './plugin/pty/tools/kill.ts'
import open from 'open'

const ptyOpenClientCommand = 'pty-open-background-spy'
const ptyShowServerUrlCommand = 'pty-show-server-url'

export const PTYPlugin = async ({ client, directory }: PluginContext): Promise<PluginResult> => {
  initPermissions(client, directory)
  let broker: BrokerClient | undefined
  let brokerPromise: Promise<BrokerClient | undefined> | undefined
  let disposed = false

  const connectBroker = async () => {
    if (disposed) return
    if (broker) return broker
    if (brokerPromise) return brokerPromise
    brokerPromise = BrokerClient.connect(client)
      .then((connected) => {
        if (disposed) {
          connected[Symbol.dispose]()
          return undefined
        }
        broker = connected
        return connected
      })
      .catch((error) => {
        if (disposed) return undefined
        const message = error instanceof Error ? error.message : String(error)
        void client.tui
          .showToast({
            body: { message: `PTY broker unavailable: ${message}`, variant: 'warning' },
          })
          .catch(() => {})
        return undefined
      })
      .finally(() => {
        brokerPromise = undefined
      })
    return brokerPromise
  }

  await connectBroker()
  const transport: BrokerTransport = {
    async request<T extends BrokerResult>(operation: BrokerOperation): Promise<T> {
      const activeBroker = await connectBroker()
      if (!activeBroker) throw new Error('PTY broker is unavailable')
      return activeBroker.request<T>(operation)
    },
  }

  return {
    dispose: async () => {
      disposed = true
      broker?.[Symbol.dispose]()
    },
    'command.execute.before': async (input) => {
      if (input.command !== ptyOpenClientCommand && input.command !== ptyShowServerUrlCommand) {
        return
      }
      const activeBroker = await connectBroker()
      if (!activeBroker) throw new Error('PTY broker is unavailable')
      if (input.command === ptyOpenClientCommand) {
        open(activeBroker.origin)
      } else if (input.command === ptyShowServerUrlCommand) {
        const message = `PTY Sessions Web Interface URL: ${activeBroker.origin}`
        await client.tui.showToast({ body: { message, variant: 'info' } })
      }
      throw new Error('Command handled by PTY plugin')
    },
    tool: {
      pty_spawn: createPtySpawn(transport),
      pty_write: createPtyWrite(transport),
      pty_read: createPtyRead(transport),
      pty_list: createPtyList(transport),
      pty_kill: createPtyKill(transport),
    },
    config: async (input) => {
      if (!input.command) {
        input.command = {}
      }
      input.command[ptyOpenClientCommand] = {
        template: `This command will start the PTY Sessions Web Interface in your default browser.`,
        description: 'Open PTY Sessions Web Interface',
      }
      input.command[ptyShowServerUrlCommand] = {
        template: `This command will show the PTY Sessions Web Interface URL.`,
        description: 'Show PTY Sessions Web Interface URL',
      }
    },
    event: async ({ event }) => {
      if (event.type === 'session.deleted') {
        await broker?.request({
          type: 'cleanupBySession',
          parentSessionId: event.properties.info.id,
        })
      }
    },
  }
}
