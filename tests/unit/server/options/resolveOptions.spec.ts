import { sanitizePrefix } from '@payloadcms/plugin-cloud-storage/utilities'
import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { cleanPrefix, resolveOptions } from '@/server/options/resolveOptions.js'
import type { Check, JanitorPluginOptions } from '@/shared/types/options.js'

import { config, store } from '../../../helpers/options.js'

const sharedStore = store()

describe('resolveOptions', () => {
  const resolve = (options: JanitorPluginOptions) => resolveOptions(options, config)
  const only = (options: JanitorPluginOptions) => resolve(options).collections[0]!

  it('gives an upload with storage every check, the panel and the guard for `true`', () => {
    const storage = store()

    expect(only({ collections: { media: true }, storage })).toEqual({
      blockDelete: true,
      checks: ['orphans', 'missing', 'unused'],
      composite: false,
      prefix: 'uploads/media',
      prefixFrom: 'config',
      slug: 'media',
      storage,
      trash: false,
      upload: true,
      usagePanel: { limit: 0, position: 'first' },
    })
  })

  it('gives an upload without storage only the unused check for `true`', () => {
    expect(only({ collections: { media: true } })).toMatchObject({ checks: ['unused'], storage: undefined })
  })

  it('gives a non-upload collection only the unused check, no storage and no prefix, for `true`', () => {
    expect(only({ collections: { tags: true }, storage: undefined })).toEqual({
      blockDelete: true,
      checks: ['unused'],
      composite: false,
      prefix: '',
      prefixFrom: 'config',
      slug: 'tags',
      storage: undefined,
      trash: false,
      upload: false,
      usagePanel: { limit: 0, position: 'sidebar' },
    })
  })

  it('keeps the panel and the guard when `report` is false', () => {
    expect(only({ collections: { tags: { report: false } } })).toMatchObject({
      blockDelete: true,
      checks: [],
      usagePanel: { limit: 0, position: 'sidebar' },
    })
  })

  it('takes trash from the collection itself', () => {
    const resolved = resolve({ collections: { files: true, media: true } })

    expect(resolved.collections.map((item) => [item.slug, item.trash])).toEqual([
      ['files', true],
      ['media', false],
    ])
  })

  it('lets a collection storage win over the global one', () => {
    const global = store()
    const own = store()
    const resolved = resolve({ collections: { files: true, media: { storage: own } }, storage: global })

    expect(resolved.collections.map((item) => item.storage)).toEqual([global, own])
  })

  it('fills the defaults once', () => {
    const resolved = resolve({ collections: { media: true } })

    expect(resolved).toMatchObject({
      admin: { group: 'System' },
      endpoints: { path: '/janitor' },
      findingsSlug: 'janitor-findings',
      minAge: 86_400,
      references: { text: false, versions: 'used' },
      runsSlug: 'janitor-runs',
      jobs: false,
      tenants: false,
    })
    expect(resolved.references.ignoreTables).toEqual(
      expect.arrayContaining([
        'payload_preferences',
        'payload_jobs',
        'payload-jobs',
        'janitor-findings',
        'janitor_findings',
        'janitor_findings_rels',
        'janitor-runs',
        'janitor_runs',
        'janitor_runs_rels',
      ]),
    )
  })

  it('lets in only users of the admin user collection by default, any user when there is none', () => {
    const { access } = resolve({ collections: { media: true } })
    const check = (user: null | object, admin?: string) =>
      access.read({ req: { payload: { config: { admin: { user: admin } } }, user } } as never)

    expect(check({ collection: 'users', id: 1 }, 'users')).toBe(true)
    expect(check({ collection: 'members', id: 1 }, 'users')).toBe(false)
    expect(check({ collection: 'members', id: 1 })).toBe(true)
    expect(check(null, 'users')).toBe(false)
  })

  it('lets nested prefixes share one storage when only one collection lists it', () => {
    const resolved = resolve({
      collections: { files: { prefix: 'uploads', report: ['unused'] }, media: true },
      storage: sharedStore,
    })

    expect(resolved.collections.map((item) => item.prefix)).toEqual(['uploads', 'uploads/media'])
  })

  it('lets two collections share one storage under the same prefix', () => {
    const resolved = resolve({
      collections: { files: { prefix: 'shared' }, media: { prefix: 'shared' } },
      storage: sharedStore,
    })

    expect(resolved.collections.map((item) => item.prefix)).toEqual(['shared', 'shared'])
  })

  it('cuts trailing slashes off the endpoints path', () => {
    expect(resolve({ collections: { media: true }, endpoints: { path: '/tidy//' } }).endpoints).toEqual({
      path: '/tidy',
    })
  })

  const throws: [string, JanitorPluginOptions, string][] = [
    [
      'nothing is listed',
      { collections: {} },
      'janitor: no collection listed; list at least one under `collections` or set `enabled: false` to switch the plugin off',
    ],
    [
      'every listed collection is off',
      { collections: { media: false } },
      'janitor: no collection listed; list at least one under `collections` or set `enabled: false` to switch the plugin off',
    ],
    ['the slug does not exist', { collections: { nope: true } }, 'janitor: collection "nope" does not exist'],
    [
      'the slug is the plugin own collection',
      { collections: { 'janitor-findings': true } },
      'janitor: "janitor-findings" is the plugin\'s own collection and cannot be watched',
    ],
    [
      'a non-upload collection reports orphans',
      { collections: { tags: { report: ['orphans'] } } },
      'janitor: "tags" is not an upload collection; only `unused` can be reported for it',
    ],
    [
      'a non-upload collection gets storage',
      { collections: { tags: { storage: store() } } },
      'janitor: "tags" is not an upload collection; `storage`, `prefix` and `compositePrefixes` do not apply',
    ],
    [
      'a non-upload collection gets a prefix',
      { collections: { tags: { prefix: 'tags' } } },
      'janitor: "tags" is not an upload collection; `storage`, `prefix` and `compositePrefixes` do not apply',
    ],
    [
      'a non-upload collection gets composite prefixes',
      { collections: { tags: { compositePrefixes: false } } },
      'janitor: "tags" is not an upload collection; `storage`, `prefix` and `compositePrefixes` do not apply',
    ],
    [
      'composite prefixes come without the prefix',
      { collections: { media: { compositePrefixes: true } } },
      'janitor: "media" has `compositePrefixes` but no `prefix`; pass the prefix its storage plugin was given, "" for none',
    ],
    [
      'an upload asks for missing objects without storage',
      { collections: { media: { report: ['missing'] } } },
      'janitor: "media" reports orphans and missing objects but has no storage; pass `storage` on the collection or globally',
    ],
    [
      'a collection has nothing switched on',
      { collections: { tags: { blockDelete: false, report: false, usagePanel: false } } },
      'janitor: "tags" has nothing switched on; remove it or drop it from `collections`',
    ],
    [
      'a check is unknown',
      { collections: { media: { report: ['orphan' as Check] } } },
      'janitor: "media" has an unknown check "orphan"; use missing, orphans, unused',
    ],
    [
      'a check is listed twice',
      { collections: { media: { report: ['unused', 'unused'] } } },
      'janitor: "media" has a duplicate check "unused"; use missing, orphans, unused',
    ],
    [
      'global storage has no upload to serve',
      { collections: { tags: true }, storage: store() },
      'janitor: `storage` is set but no listed collection is an upload collection',
    ],
    [
      'two collections on one storage have nested prefixes',
      { collections: { files: { prefix: 'uploads' }, media: true }, storage: sharedStore },
      'janitor: "files" and "media" share storage with nested prefixes "uploads" and "uploads/media"; give them the same prefix or separate ones',
    ],
    [
      'one collection on a storage sits at the root of another',
      { collections: { files: true, media: true }, storage: sharedStore },
      'janitor: "files" and "media" share storage with nested prefixes "" and "uploads/media"; give them the same prefix or separate ones',
    ],
    [
      'the admin UI is on without endpoints',
      { collections: { media: true }, endpoints: false },
      'janitor: the admin UI needs the REST endpoints; set `admin: false` too or keep `endpoints`',
    ],
    [
      'a usage panel is on without endpoints',
      { admin: false, collections: { media: { usagePanel: true } }, endpoints: false },
      'janitor: "media" has a usage panel, which needs the REST endpoints; set `usagePanel: false` or keep `endpoints`',
    ],
    [
      'the endpoints path has no leading slash',
      { collections: { media: true }, endpoints: { path: 'janitor' } },
      'janitor: `endpoints.path` must start with "/"',
    ],
    [
      'the endpoints path has whitespace',
      { collections: { media: true }, endpoints: { path: '/jani tor' } },
      'janitor: `endpoints.path` must start with "/"',
    ],
    [
      'the endpoints path is only a slash',
      { collections: { media: true }, endpoints: { path: '//' } },
      'janitor: `endpoints.path` must name a path under /api, such as "/janitor"',
    ],
    [
      'jobs is true',
      { collections: { media: true }, jobs: true as never },
      'janitor: `jobs` must be `false` or an object',
    ],
    [
      'jobs is null',
      { collections: { media: true }, jobs: null as never },
      'janitor: `jobs` must be `false` or an object',
    ],
    [
      'jobs is an array',
      { collections: { media: true }, jobs: [] as never },
      'janitor: `jobs` must be `false` or an object',
    ],
    [
      'the queue is not a string',
      { collections: { media: true }, jobs: { queue: 1 as never } },
      'janitor: `jobs.queue` must name a queue',
    ],
    [
      'the queue is empty',
      { collections: { media: true }, jobs: { queue: ' ' } },
      'janitor: `jobs.queue` must name a queue',
    ],
    [
      'the schedule is empty',
      { collections: { media: true }, jobs: { schedule: ' ' } },
      'janitor: `jobs.schedule` must be a cron expression',
    ],
    [
      'minAge is negative',
      { collections: { media: true }, minAge: -1 },
      'janitor: `minAge` must be a number of seconds, 0 or more',
    ],
    [
      'minAge is not finite',
      { collections: { media: true }, minAge: Number.POSITIVE_INFINITY },
      'janitor: `minAge` must be a number of seconds, 0 or more',
    ],
    [
      'minAge looks like hours',
      { collections: { media: true }, minAge: 48 },
      'janitor: `minAge` is in seconds and must be 0 or at least 3600; 48 looks like hours',
    ],
    [
      'minAge is one second short of an hour',
      { collections: { media: true }, minAge: 3599 },
      'janitor: `minAge` is in seconds and must be 0 or at least 3600; 3599 looks like hours',
    ],
    [
      'references.versions is invalid',
      { collections: { media: true }, references: { versions: 'maybe' as 'used' } },
      'janitor: `references.versions` must be "used" or "unused"',
    ],
    [
      'tenants is null',
      { collections: { media: true }, tenants: null as never },
      'janitor: `tenants` must be `true`, `false` or an object',
    ],
    [
      'tenants is an array',
      { collections: { media: true }, tenants: [] as never },
      'janitor: `tenants` must be `true`, `false` or an object',
    ],
    [
      'tenants is a string',
      { collections: { media: true }, tenants: 'tenants' as never },
      'janitor: `tenants` must be `true`, `false` or an object',
    ],
    [
      'the tenants collection is empty',
      { collections: { media: true }, tenants: { collection: ' ' as never } },
      'janitor: `tenants.collection` must name a collection',
    ],
    [
      'the tenant field is not a string',
      { collections: { media: true }, tenants: { field: 1 as never } },
      'janitor: `tenants.field` must name a field',
    ],
    [
      'the tenants collection is the plugin own collection',
      { collections: { media: true }, tenants: { collection: 'janitor-runs' as never } },
      'janitor: `tenants.collection` "janitor-runs" is the plugin\'s own collection',
    ],
    [
      'the tenants collection is not in the config',
      { collections: { media: true }, tenants: { collection: 'sites' as never } },
      'janitor: `tenants.collection` "sites" is not a collection in the config; name the tenants collection of @payloadcms/plugin-multi-tenant, or list janitor after the plugin that adds it',
    ],
    [
      'the tenants collection is not in the config of a disabled plugin',
      { collections: {}, enabled: false, tenants: { collection: 'sites' as never } },
      'janitor: `tenants.collection` "sites" is not a collection in the config; name the tenants collection of @payloadcms/plugin-multi-tenant, or list janitor after the plugin that adds it',
    ],
    [
      'the panel is placed next to a missing field',
      { collections: { media: { usagePanel: { position: { after: 'caption' } } } } },
      'janitor: "media" cannot place the usage panel: Field path "caption" not found',
    ],
    [
      'the panel is placed before a missing field',
      { collections: { media: { usagePanel: { position: { before: 'caption' } } } } },
      'janitor: "media" cannot place the usage panel: Field path "caption" not found',
    ],
  ]

  it('leaves the usage panel off by default when endpoints are off', () => {
    expect(only({ admin: false, collections: { media: true }, endpoints: false })).toMatchObject({
      blockDelete: true,
      usagePanel: false,
    })
  })

  it('takes an explicit prefix over the prefix field', () => {
    expect(only({ collections: { media: { prefix: '/cdn//media/' } } })).toMatchObject({
      composite: false,
      prefix: 'cdn/media',
      prefixFrom: 'option',
    })
  })

  it('refuses to guess the keys of a prefix field with an empty default', () => {
    const blank = {
      collections: [{ slug: 'shots', fields: [{ name: 'prefix', type: 'text' }], upload: true }],
    } as unknown as Config

    expect(() => resolveOptions({ collections: { shots: true }, storage: store() }, blank)).toThrow(
      'janitor: "shots" has a `prefix` field with an empty default, so its keys are unknown',
    )
    expect(resolveOptions({ collections: { shots: true } }, blank).collections[0]!.checks).toEqual(['unused'])
    expect(
      resolveOptions({ collections: { shots: { prefix: '' } }, storage: store() }, blank).collections[0],
    ).toMatchObject({ prefix: '', prefixFrom: 'option' })
  })

  it('refuses unused on a collection without timestamps, which purge could never re-check', () => {
    const bare = { collections: [{ slug: 'logs', fields: [], timestamps: false }] } as unknown as Config

    expect(() => resolveOptions({ collections: { logs: true } }, bare)).toThrow(
      'janitor: "logs" has `timestamps: false`, so an unused document can be neither aged nor re-checked',
    )
    expect(resolveOptions({ collections: { logs: { report: false } } }, bare).collections[0]!.checks).toEqual([])
  })

  it('lets collections nest prefixes on an adapter that keeps each collection apart', () => {
    const apart = { ...store(), perCollection: true }

    expect(() => resolve({ collections: { files: { prefix: 'uploads' }, media: true }, storage: apart })).not.toThrow()
  })

  it.each(throws)('throws when %s', (_case, options, text) => {
    expect(() => resolve(options)).toThrow(text)
  })

  it('gives every action one function, or each action its own with the default for the rest', async () => {
    const own = () => true
    const all = resolve({ access: own, collections: { media: true } }).access
    const split = resolve({ access: { purge: () => false, read: own }, collections: { media: true } }).access
    const as = (user: null | object) => ({ req: { payload: { config: { admin: { user: 'users' } } }, user } }) as never

    expect(all).toEqual({ approve: own, purge: own, read: own, scan: own })
    expect(split.read).toBe(own)
    expect(await split.purge(as({ collection: 'users', id: 1 }))).toBe(false)
    expect(await split.scan(as({ collection: 'users', id: 1 }))).toBe(true)
    expect(await split.approve(as(null))).toBe(false)
  })

  it('runs inline by default and queues on the default queue unless jobs names one', () => {
    const schedule = '0 3 * * *'

    expect(resolve({ collections: { media: true } }).jobs).toBe(false)
    expect(resolve({ collections: { media: true }, jobs: false }).jobs).toBe(false)
    expect(resolve({ collections: { media: true }, jobs: {} }).jobs).toEqual({ queue: 'default' })
    expect(resolve({ collections: { media: true }, jobs: { queue: 'nightly', schedule } }).jobs).toEqual({
      queue: 'nightly',
      schedule,
    })
  })

  it('takes the tenants collection and field, or the multi-tenant defaults for `true`', () => {
    expect(resolve({ collections: { media: true }, tenants: true }).tenants).toEqual({
      collection: 'tenants',
      field: 'tenant',
    })
    expect(
      resolveOptions({ collections: { media: true }, tenants: { collection: 'sites' as never, field: 'site' } }, {
        collections: [...config.collections!, { slug: 'sites', fields: [] }],
      } as Config).tenants,
    ).toEqual({ collection: 'sites', field: 'site' })
    expect(resolve({ collections: {}, enabled: false, tenants: true }).tenants).toEqual({
      collection: 'tenants',
      field: 'tenant',
    })
  })

  it('accepts minAge 0 and one hour', () => {
    expect(resolve({ collections: { media: true }, minAge: 0 }).minAge).toBe(0)
    expect(resolve({ collections: { media: true }, minAge: 3600 }).minAge).toBe(3600)
  })

  it('takes the slugs of both collections from overrides and keeps them out of the reference index', () => {
    const resolved = resolve({
      collections: { media: true },
      overrides: { findings: { slug: 'cleanupFindings' }, runs: { slug: 'cleanup-runs' } },
    })

    expect(resolved).toMatchObject({ findingsSlug: 'cleanupFindings', runsSlug: 'cleanup-runs' })
    expect(resolved.references.ignoreTables).toEqual(
      expect.arrayContaining(['cleanupFindings', 'cleanup_findings', 'cleanup-runs', 'cleanup_runs_rels']),
    )
    expect(() => resolve({ collections: { cleanupFindings: true }, overrides: resolved.overrides })).toThrow(
      'janitor: "cleanupFindings" is the plugin\'s own collection and cannot be watched',
    )
  })
})

describe('cleanPrefix', () => {
  it.each([
    'media',
    '/media/',
    'a//b',
    './a/../b',
    'a\\b',
    '%2Fa%2Fb',
    '%252f',
    'a\u0001b',
    'a\u007fb',
    'a\u0085b',
    '%zz',
  ])('reads %j as the storage plugin does', (value) => {
    expect(cleanPrefix(value)).toBe(sanitizePrefix(value).split('/').filter(Boolean).join('/'))
  })
})
