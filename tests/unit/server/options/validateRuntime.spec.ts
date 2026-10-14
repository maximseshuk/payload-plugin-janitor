import { cloudStoragePlugin } from '@payloadcms/plugin-cloud-storage'
import type { Config, Payload } from 'payload'
import { describe, expect, it } from 'vitest'

import { janitor } from '@/index.js'
import { resolveOptions } from '@/server/options/resolveOptions.js'
import { validateRuntime } from '@/server/options/validateRuntime.js'
import { PLUGIN_NAME } from '@/shared/constants.js'
import type { ResolvedOptions } from '@/shared/types/resolved.js'

import { config, store } from '../../../helpers/options.js'

describe('validateRuntime', () => {
  const runtime = (db: Record<string, unknown>) => {
    const logged: string[] = []
    const log = (line: string) => logged.push(line)
    const payload = {
      config: { collections: config.collections, jobs: {} },
      db,
      logger: { info: log, warn: log },
    } as unknown as Payload

    return { logged, payload }
  }

  it('refuses a database adapter usage detection cannot read', () => {
    const { payload } = runtime({ name: 'other' })

    expect(() => validateRuntime(payload, resolveOptions({ collections: { tags: true } }, config))).toThrow(
      'janitor: usage detection needs the Postgres, SQLite or MongoDB adapter; "tags" cannot be checked',
    )
  })

  it('tells an upload without storage that only unused is reported, and warns on a cron nothing runs', () => {
    const { logged, payload } = runtime({ client: { execute: () => {} }, name: 'sqlite' })

    validateRuntime(
      payload,
      resolveOptions({ collections: { media: true }, jobs: { queue: 'nightly', schedule: '0 3 * * *' } }, config),
    )

    expect(logged).toEqual([
      'janitor: "media" has no storage, so only `unused` is reported',
      'janitor: `jobs.schedule` queues a scan but nothing runs the "nightly" queue; set Payload\'s `jobs.autoRun` or call GET /api/payload-jobs/handle-schedules and /run from outside',
    ])
  })

  it('refuses tenants when no listed collection has the tenant field, and names the ones without it', () => {
    const { logged, payload } = runtime({ client: { execute: () => {} }, name: 'sqlite' })
    const tenant = { name: 'tenant', type: 'relationship', hasMany: false, relationTo: 'tenants' }
    const resolved = resolveOptions({ collections: { media: true, tags: true }, tenants: true }, config)
    const fieldsOf = (fields: Record<string, unknown[]>) =>
      Object.assign(payload, {
        collections: Object.fromEntries(
          Object.entries(fields).map(([slug, flattenedFields]) => [slug, { config: { flattenedFields } }]),
        ),
      })

    expect(() =>
      validateRuntime(fieldsOf({ media: [{ ...tenant, relationTo: 'sites' }], tags: [] }), resolved),
    ).toThrow(
      'janitor: `tenants` is on, but no listed collection has a `tenant` relationship to "tenants"; is @payloadcms/plugin-multi-tenant set up?',
    )

    logged.length = 0
    validateRuntime(fieldsOf({ media: [], tags: [{ ...tenant, hasMany: true }] }), resolved)

    expect(logged).toEqual([
      'janitor: "media" has no storage, so only `unused` is reported',
      'janitor: "media" has no `tenant` field, so its findings are visible only to users who see every tenant',
    ])
  })
})

describe('plugin order', () => {
  const sqlite = { client: { execute: () => {} }, name: 'sqlite' }
  const logger = { info: () => {}, warn: () => {} }
  const cloud = (useCompositePrefixes: boolean) =>
    cloudStoragePlugin({
      collections: {
        shots: {
          adapter: () => ({
            name: 'test',
            handleDelete: () => {},
            handleUpload: () => {},
            staticHandler: () => new Response(null),
          }),
          prefix: 'shots',
        },
      },
      useCompositePrefixes,
    })
  const base = { collections: [{ slug: 'shots', fields: [], upload: true }] } as unknown as Config
  const check = (built: Config) =>
    validateRuntime(
      { config: built, db: sqlite, logger } as unknown as Payload,
      (built.custom as Record<string, ResolvedOptions>)[PLUGIN_NAME]!,
    )

  it('throws when janitor runs before the storage plugin that sets the prefix', async () => {
    const built = await cloud(false)(await janitor({ collections: { shots: true }, storage: store() })(base))

    expect(() => check(built)).toThrow(
      'janitor: "shots" stores files under "shots" but janitor read "" before its storage plugin ran; list janitor after the storage plugins in `plugins`, or pass `prefix`',
    )
  })

  it('reads the prefix when janitor runs after the storage plugin', async () => {
    const built = await janitor({ collections: { shots: true }, storage: store() })(await cloud(false)(base))

    expect(() => check(built)).not.toThrow()
    expect((built.custom as Record<string, ResolvedOptions>)[PLUGIN_NAME]!.collections[0]!.prefix).toBe('shots')
  })

  it('refuses to guess the keys of a storage plugin with composite prefixes', async () => {
    const composite = await cloud(true)(base)

    await expect(async () => janitor({ collections: { shots: true }, storage: store() })(composite)).rejects.toThrow(
      'janitor: "shots" has a `prefix` field with an empty default',
    )

    const built = await janitor({
      collections: { shots: { compositePrefixes: true, prefix: 'shots' } },
      storage: store(),
    })(composite)

    expect(() => check(built)).not.toThrow()
  })

  it('refuses a prefix passed without compositePrefixes when the storage plugin uses composite prefixes', async () => {
    const composite = await cloud(true)(base)
    const message =
      'janitor: "shots" is given `prefix: "shots"`, but its `prefix` field has an empty default, which is how a storage plugin with `useCompositePrefixes` marks it'

    await expect(async () =>
      janitor({ collections: { shots: { prefix: 'shots' } }, storage: store() })(composite),
    ).rejects.toThrow(message)
    const early = await cloud(true)(
      await janitor({ collections: { shots: { prefix: 'shots' } }, storage: store() })(base),
    )

    expect(() => check(early)).toThrow(message)
    expect(() =>
      check(janitor({ collections: { shots: { prefix: '' } }, storage: store() })(composite) as Config),
    ).not.toThrow()
  })

  it('refuses compositePrefixes when the storage plugin gives the prefix field a default', async () => {
    const settings = { collections: { shots: { compositePrefixes: true, prefix: 'shots' } }, storage: store() }
    const message =
      'janitor: "shots" has `compositePrefixes`, but its `prefix` field defaults to "shots", so its storage plugin does not run with `useCompositePrefixes`'

    await expect(async () => janitor(settings)(await cloud(false)(base))).rejects.toThrow(message)
    const early = await cloud(false)(await janitor(settings)(base))

    expect(() => check(early)).toThrow(message)
  })
})
