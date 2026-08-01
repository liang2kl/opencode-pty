import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { PluginContext } from '../src/plugin/types.ts'
import { PTYPlugin } from '../src/plugin.ts'
import { BrokerClient } from '../src/plugin/pty/broker-client.ts'

describe('PTY plugin startup', () => {
  afterEach(() => {
    mock.restore()
  })

  it('does not wait for a toast when the broker is unavailable', async () => {
    spyOn(BrokerClient, 'connect').mockRejectedValue(new Error('Address already in use'))
    let toastCalled = false

    const context = {
      client: {
        tui: {
          showToast: () => {
            toastCalled = true
            return new Promise(() => {})
          },
        },
      },
      directory: process.cwd(),
      serverUrl: new URL('http://127.0.0.1:4096'),
    } as unknown as PluginContext

    const result = await Promise.race([
      PTYPlugin(context),
      Bun.sleep(100).then(() => 'timed out' as const),
    ])

    expect(result).not.toBe('timed out')
    expect(toastCalled).toBe(true)
  })
})
