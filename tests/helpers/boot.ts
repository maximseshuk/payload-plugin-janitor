import { randomUUID } from 'node:crypto'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import type { Config, Payload } from 'payload'
import { buildConfig, getPayload } from 'payload'

import { startPglite } from './pglite.js'

process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'

export type Booted = {
  payload: Payload
  teardown: () => Promise<void>
}

type PrivateDb = {
  adapter: Config['db']
  stop: () => Promise<void>
}

const privateDb = async (name: string, indexes: boolean): Promise<PrivateDb> => {
  const blocksAsJSON = process.env.BLOCKS_AS_JSON === '1'

  if ((process.env.TEST_DB ?? 'sqlite') === 'sqlite') {
    return { adapter: sqliteAdapter({ blocksAsJSON, client: { url: ':memory:' }, push: true }), stop: async () => {} }
  }

  if (process.env.TEST_DB === 'mongodb') {
    const url = new URL(process.env.DATABASE_URI ?? 'mongodb://127.0.0.1')

    url.pathname = `/${name}`

    const automatic = indexes ? { ensureIndexes: true } : { connectOptions: { autoIndex: false } }

    return { adapter: mongooseAdapter({ ...automatic, url: url.href }), stop: async () => {} }
  }

  const pglite = await startPglite()

  return {
    adapter: postgresAdapter({ blocksAsJSON, pool: { connectionString: pglite.url }, push: true }),
    stop: pglite.stop,
  }
}

export const boot = async (
  config: Omit<Config, 'db' | 'secret'> & { secret?: string },
  { indexes = true }: { indexes?: boolean } = {},
): Promise<Booted> => {
  const key = `janitor_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const db = await privateDb(key, indexes)
  const payload = await getPayload({
    config: buildConfig({
      secret: 'boot',
      typescript: { autoGenerate: false },
      ...config,
      collections: config.collections?.map((collection) => ({ versions: false, ...collection })),
      db: db.adapter,
      globals: config.globals?.map((global) => ({ versions: false, ...global })),
    }),
    key,
  })

  const teardown = async (): Promise<void> => {
    const adapter = payload.db as {
      connection?: { dropDatabase?: () => Promise<unknown> }
      destroy?: () => Promise<void>
      pool?: { on: (event: 'error', handle: () => void) => void }
    }

    await adapter.connection?.dropDatabase?.()
    await adapter.destroy?.()
    adapter.pool?.on('error', () => {})
    await db.stop()
    ;(globalThis as { _payload?: Map<string, unknown> })._payload?.delete(key)
  }

  return { payload, teardown }
}
