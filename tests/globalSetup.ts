import { startPglite } from './helpers/pglite.js'

let stop: (() => Promise<unknown>) | undefined

export const setup = async (): Promise<void> => {
  if (process.env.DATABASE_URI) return

  if (process.env.TEST_DB === 'mongodb') {
    const { MongoMemoryServer } = await import('mongodb-memory-server')
    const instance = await MongoMemoryServer.create()

    stop = () => instance.stop()
    process.env.DATABASE_URI = instance.getUri('janitor_test')

    return
  }

  if (process.env.TEST_DB === 'postgres') {
    const pglite = await startPglite()

    stop = pglite.stop
    process.env.DATABASE_URI = pglite.url
  }
}

export const teardown = async (): Promise<void> => {
  await stop?.()
}
