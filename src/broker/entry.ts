import { PTYServer } from '../web/server/server.ts'

await PTYServer.createServer({ broker: true, exitWhenIdle: true })
await new Promise(() => {})
