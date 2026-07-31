import {
  registerRawOutputCallback,
  registerSessionRemoveCallback,
  registerSessionUpdateCallback,
  removeRawOutputCallback,
  removeSessionRemoveCallback,
  removeSessionUpdateCallback,
} from '../../plugin/pty/manager'
import type { PTYSessionInfo } from '../../plugin/pty/types'
import type {
  WSMessageServerRawData,
  WSMessageServerSessionRemoved,
  WSMessageServerSessionUpdate,
} from '../shared/types'

export class CallbackManager implements Disposable {
  constructor(private server: Bun.Server<undefined>) {
    this.server = server
    registerSessionUpdateCallback(this.sessionUpdateCallback)
    registerSessionRemoveCallback(this.sessionRemoveCallback)
    registerRawOutputCallback(this.rawOutputCallback)
  }

  private sessionUpdateCallback = (session: PTYSessionInfo): void => {
    const message: WSMessageServerSessionUpdate = { type: 'session_update', session }
    this.server.publish('sessions:update', JSON.stringify(message))
  }

  private rawOutputCallback = (session: PTYSessionInfo, rawData: string): void => {
    const message: WSMessageServerRawData = { type: 'raw_data', session, rawData }
    this.server.publish(`session:${session.id}`, JSON.stringify(message))
  }

  private sessionRemoveCallback = (sessionId: string): void => {
    const message: WSMessageServerSessionRemoved = { type: 'session_removed', sessionId }
    this.server.publish('sessions:update', JSON.stringify(message))
  };

  [Symbol.dispose]() {
    removeSessionUpdateCallback(this.sessionUpdateCallback)
    removeSessionRemoveCallback(this.sessionRemoveCallback)
    removeRawOutputCallback(this.rawOutputCallback)
  }
}
