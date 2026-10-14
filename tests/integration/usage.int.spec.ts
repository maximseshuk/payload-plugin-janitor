import { randomUUID } from 'node:crypto'

import { postgresAdapter } from '@payloadcms/db-postgres'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import type { Payload } from 'payload'
import { buildConfig, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { janitor } from '@/index.js'
import { janitorOptions } from '@/server/run.js'
import type { UsageOptions } from '@/server/usage/index.js'
import {
  buildUsageIndex,
  eachPage,
  findUsage,
  findUsageDetail,
  supportsUsage,
  usageDetail,
} from '@/server/usage/index.js'
import { buildUsageIndexMongo, findUsageMongo } from '@/server/usage/mongo.js'
import { run } from '@/server/usage/sql.js'
import { walkIds } from '@/server/usage/walk.js'

import { boot } from '../helpers/boot.js'
import { startPglite } from '../helpers/pglite.js'

const db = process.env.TEST_DB ?? 'sqlite'
const label = `${db}${process.env.BLOCKS_AS_JSON === '1' ? ' (blocks as json)' : ''}`

const references = (overrides: Partial<UsageOptions> = {}): UsageOptions => ({
  ignoreTables: [],
  text: false,
  versions: 'used',
  ...overrides,
})

const file = (name: string) => ({ data: Buffer.from(name), mimetype: 'text/plain', name, size: name.length })

const upload = { disableLocalStorage: true }

describe(`versioned usage on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  const media = async (name: string): Promise<[number | string, string]> => {
    const { id } = await payload.create({
      collection: 'media' as never,
      data: {},
      file: file(name),
      overrideAccess: true,
    })

    return [id, String(id)]
  }

  const page = (data: Record<string, unknown>, draft = false) =>
    payload.create({ collection: 'pages' as never, data: data as never, draft, overrideAccess: true })

  const usage = (id: string, overrides: Partial<UsageOptions> = {}) =>
    findUsage(payload, { ...references(overrides), collection: 'media', id })

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      collections: [
        {
          slug: 'media',
          fields: [
            { name: 'alt', type: 'text' },
            { name: 'thumbnail', type: 'upload', relationTo: 'media' },
          ],
          upload,
          versions: { drafts: true },
        },
        {
          slug: 'pages',
          fields: [
            { name: 'hero', type: 'upload', relationTo: 'media' },
            { name: 'body', type: 'json' },
          ],
          versions: { drafts: true },
        },
      ],
    }))
  })

  afterAll(async () => {
    await teardown()
  })

  it('reports a versioned upload with no reference as unused, never used by its own versions', async () => {
    const [raw, id] = await media('lonely.txt')

    await payload.update({ collection: 'media' as never, data: { alt: 'one' } as never, id: raw, overrideAccess: true })
    await payload.update({
      collection: 'media' as never,
      data: { alt: 'two', thumbnail: raw } as never,
      id: raw,
      overrideAccess: true,
    })
    await payload.update({
      collection: 'media' as never,
      data: { alt: 'three' } as never,
      draft: true,
      id: raw,
      overrideAccess: true,
    })

    for (const versions of ['used', 'unused'] as const) {
      expect(await usage(id, { versions })).toEqual([])
      expect((await buildUsageIndex(payload, { ...references({ versions }), collection: 'media' }))?.has(id)).toBe(
        false,
      )
      expect(await findUsageDetail(payload, { ...references({ versions }), collection: 'media', id })).toEqual([])
    }
  })

  it('reports progress while it builds the index, and fails when the progress callback fails', async () => {
    const onProgress = vi.fn()

    await buildUsageIndex(payload, { ...references(), collection: 'media', onProgress })

    expect(onProgress).toHaveBeenCalled()

    await expect(
      buildUsageIndex(payload, {
        ...references(),
        collection: 'media',
        onProgress: () => {
          throw new Error('beat failed')
        },
      }),
    ).rejects.toThrow('beat failed')
  })

  it('tags a reference that only an old version holds', async () => {
    const [raw, id] = await media('old.txt')
    const created = await page({ _status: 'published', body: { image: id }, hero: raw })

    await payload.update({
      collection: 'pages' as never,
      data: { _status: 'published', body: {}, hero: null } as never,
      id: created.id,
      overrideAccess: true,
    })

    const refs = await usage(id, { versions: 'unused' })

    expect(refs).not.toHaveLength(0)
    expect(refs!.every((ref) => ref.versions === true)).toBe(true)

    const index = await buildUsageIndex(payload, { ...references({ versions: 'unused' }), collection: 'media' })

    expect(index?.get(id)?.every((ref) => ref.versions === true)).toBe(true)

    for (const versions of ['used', 'unused'] as const) {
      const detail = await usageDetail(payload, { ...references({ versions }), collection: 'media', id })

      expect(detail!.used).toBe(versions === 'used')
    }
  })

  it('counts a reference in the latest draft as live', async () => {
    const [raw, id] = await media('draft.txt')
    const created = await page({ _status: 'published', hero: null })

    await payload.update({
      collection: 'pages' as never,
      data: { body: { image: id }, hero: raw } as never,
      draft: true,
      id: created.id,
      overrideAccess: true,
    })

    const refs = await usage(id, { versions: 'unused' })

    expect(refs).not.toHaveLength(0)
    expect(refs!.some((ref) => ref.versions)).toBe(false)

    const hits = await findUsageDetail(payload, { ...references(), collection: 'media', id })

    expect(hits!.map((hit) => hit.status)).toContain('draft')
    expect((await usageDetail(payload, { ...references({ versions: 'unused' }), collection: 'media', id }))!.used).toBe(
      true,
    )
  })

  it("keeps the output of versions: 'used' free of tags and equal in total", async () => {
    const [raw, id] = await media('both.txt')
    const created = await page({ _status: 'published', hero: raw })

    await payload.update({
      collection: 'pages' as never,
      data: { _status: 'published', hero: null } as never,
      id: created.id,
      overrideAccess: true,
    })
    await page({ _status: 'published', hero: raw })

    const used = (await usage(id, { versions: 'used' }))!
    const tagged = (await usage(id, { versions: 'unused' }))!
    const total = (refs: typeof used) => refs.reduce((sum, ref) => sum + ref.count, 0)

    expect(used.some((ref) => 'versions' in ref)).toBe(false)
    expect(tagged.some((ref) => ref.versions)).toBe(true)
    expect(tagged.some((ref) => !ref.versions)).toBe(true)
    expect(total(used)).toBe(total(tagged))
  })

  it('shows a published document once, not again as its latest version', async () => {
    const [raw, id] = await media('published.txt')
    const created = await page({ _status: 'published', hero: raw })

    const hits = await findUsageDetail(payload, { ...references(), collection: 'media', id })

    expect(hits!.map((hit) => [String(hit.id), hit.status, hit.versionId])).toEqual([
      [String(created.id), 'published', undefined],
    ])
  })
})

describe(`text ids on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  const usage = (id: string, text: boolean) => findUsage(payload, { ...references({ text }), collection: 'tags', id })

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      collections: [
        {
          slug: 'tags',
          fields: [
            { name: 'id', type: 'text' },
            { name: 'name', type: 'text' },
          ],
        },
        {
          slug: 'notes',
          fields: [
            { name: 'body', type: 'text' },
            { name: 'kinds', type: 'select', hasMany: true, options: ['gamma', 'other'] },
            { name: 'tag', type: 'relationship', relationTo: 'tags' },
          ],
        },
      ],
      plugins: [janitor({ admin: false, collections: { tags: { usagePanel: false } }, endpoints: false })],
    }))

    for (const id of ['alpha', 'beta', 'gamma', 'lonely', "o'brien/1", "o'brien/2"]) {
      await payload.create({ collection: 'tags' as never, data: { id, name: id } as never, overrideAccess: true })
    }

    await payload.create({ collection: 'notes' as never, data: { body: 'alpha' } as never, overrideAccess: true })
    await payload.create({
      collection: 'notes' as never,
      data: { body: 'beta and more' } as never,
      overrideAccess: true,
    })
    await payload.create({ collection: 'notes' as never, data: { kinds: ['gamma'] } as never, overrideAccess: true })
    await payload.create({ collection: 'notes' as never, data: { tag: "o'brien/1" } as never, overrideAccess: true })
  })

  afterAll(async () => {
    await teardown()
  })

  it('finds an id stored whole in a plain text field only with text: true', async () => {
    expect(await usage('alpha', false)).toEqual([])
    expect(await usage('alpha', true)).not.toHaveLength(0)

    const index = await buildUsageIndex(payload, { ...references({ text: true }), collection: 'tags' })

    expect(index?.has('alpha')).toBe(true)
  })

  it('never matches an id inside a longer string', async () => {
    expect(await usage('beta', true)).toEqual([])

    const index = await buildUsageIndex(payload, { ...references({ text: true }), collection: 'tags' })

    expect(index?.has('beta')).toBe(false)
    expect(index?.has('lonely')).toBe(false)
  })

  it('matches a select hasMany value with text: true', async () => {
    expect(await usage('gamma', true)).not.toHaveLength(0)
  })

  it('lets the delete guard answer for text ids with quotes and slashes', async () => {
    await expect(
      payload.delete({ collection: 'tags' as never, id: "o'brien/1", overrideAccess: true }),
    ).rejects.toThrow()
    expect(
      (
        await payload.count({
          collection: 'tags' as never,
          where: { id: { equals: "o'brien/1" } },
          overrideAccess: true,
        })
      ).totalDocs,
    ).toBe(1)

    await payload.delete({ collection: 'tags' as never, id: "o'brien/2", overrideAccess: true })

    expect(
      (
        await payload.count({
          collection: 'tags' as never,
          where: { id: { equals: "o'brien/2" } },
          overrideAccess: true,
        })
      ).totalDocs,
    ).toBe(0)
  })
})

describe(`block references on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      blocks: [{ slug: 'hero', fields: [{ name: 'image', type: 'upload', relationTo: 'media' }] }],
      collections: [
        { slug: 'media', fields: [], upload },
        { slug: 'landing', fields: [{ name: 'layout', type: 'blocks', blockReferences: ['hero'], blocks: [] }] },
      ],
    }))
  })

  afterAll(async () => {
    await teardown()
  })

  it('finds an upload used only inside a block referenced by slug', async () => {
    const image = (
      await payload.create({ collection: 'media' as never, data: {}, file: file('hero.txt'), overrideAccess: true })
    ).id
    const used = String(image)
    const idle = String(
      (await payload.create({ collection: 'media' as never, data: {}, file: file('idle.txt'), overrideAccess: true }))
        .id,
    )

    await payload.create({
      collection: 'landing' as never,
      data: { layout: [{ blockType: 'hero', image }] } as never,
      overrideAccess: true,
    })

    expect(await findUsage(payload, { ...references(), collection: 'media', id: used })).not.toHaveLength(0)
    expect(await findUsage(payload, { ...references(), collection: 'media', id: idle })).toEqual([])

    const index = await buildUsageIndex(payload, { ...references(), collection: 'media' })

    expect([index?.has(used), index?.has(idle)]).toEqual([true, false])

    const hits = await findUsageDetail(payload, { ...references(), collection: 'media', id: used })

    expect(hits!.map((hit) => hit.collection)).toEqual(['landing'])
  })
})

const onPostgres = db === 'postgres'

if (onPostgres) {
  describe(`custom schemaName on ${label} (runs only when TEST_DB=postgres)`, () => {
    let payload: Payload
    let stop = async (): Promise<void> => {}

    beforeAll(async () => {
      const pglite = await startPglite()
      const key = `janitor_${randomUUID().replaceAll('-', '').slice(0, 16)}`

      payload = await getPayload({
        config: buildConfig({
          collections: [
            { slug: 'media', fields: [], upload, versions: false },
            {
              slug: 'posts',
              fields: [
                { name: 'hero', type: 'upload', relationTo: 'media' },
                { name: 'body', type: 'json' },
              ],
              versions: false,
            },
          ],
          db: postgresAdapter({
            blocksAsJSON: process.env.BLOCKS_AS_JSON === '1',
            pool: { connectionString: pglite.url },
            push: true,
            schemaName: 'janitor_custom',
          }),
          secret: 'schema',
          typescript: { autoGenerate: false },
        }),
        key,
      })

      stop = async () => {
        const adapter = payload.db as { pool?: { on: (event: 'error', handle: () => void) => void } }

        await payload.db.destroy?.()
        adapter.pool?.on('error', () => {})
        await pglite.stop()
        ;(globalThis as { _payload?: Map<string, unknown> })._payload?.delete(key)
      }
    })

    afterAll(async () => {
      await stop()
    })

    it('finds a reference inside a JSON column and a foreign key outside the public schema', async () => {
      const inJson = String(
        (await payload.create({ collection: 'media' as never, data: {}, file: file('j.txt'), overrideAccess: true }))
          .id,
      )
      const key = (
        await payload.create({ collection: 'media' as never, data: {}, file: file('k.txt'), overrideAccess: true })
      ).id
      const inKey = String(key)
      const idle = String(
        (await payload.create({ collection: 'media' as never, data: {}, file: file('i.txt'), overrideAccess: true }))
          .id,
      )

      await payload.create({
        collection: 'posts' as never,
        data: { body: { image: inJson }, hero: key } as never,
        overrideAccess: true,
      })

      expect(await findUsage(payload, { ...references(), collection: 'media', id: inJson })).not.toHaveLength(0)
      expect(await findUsage(payload, { ...references(), collection: 'media', id: inKey })).not.toHaveLength(0)

      const index = await buildUsageIndex(payload, { ...references(), collection: 'media' })

      expect([index?.has(inJson), index?.has(inKey), index?.has(idle)]).toEqual([true, true, false])
      expect(await findUsageDetail(payload, { ...references(), collection: 'media', id: inJson })).toHaveLength(1)
    })
  })
}

const onRelational = db !== 'mongodb'

describe(`schema shapes without drafts on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      collections: [
        { slug: 'media', fields: [], upload },
        { slug: 'users', auth: true, fields: [] },
        {
          slug: 'blog-posts',
          access: { read: ({ req }) => !req.user || req.user.email === 'boss@example.com' },
          admin: { useAsTitle: 'title' },
          fields: [
            { name: 'title', type: 'text' },
            { name: 'body', type: 'json' },
          ],
        },
        {
          slug: 'notes',
          fields: [
            { name: 'heroText', type: 'json' },
            { name: 'items', type: 'array', fields: [{ name: 'data', type: 'json' }] },
            { name: 'gallery', type: 'array', dbName: 'media_gallery', fields: [{ name: 'data', type: 'json' }] },
            { name: 'editor', type: 'json' },
          ],
        },
      ],
    }))

    for (const name of ['hyphen', 'camel', 'array', 'dbName', 'custom', 'legacy', 'manual', 'lookalike', 'idle']) {
      ids[name] = String(
        (await payload.create({ collection: 'media' as never, data: {}, file: file(name), overrideAccess: true })).id,
      )
    }

    const value = (name: string) => (onRelational ? Number(ids[name]) : ids[name])
    const note = (data: Record<string, unknown>) =>
      payload.create({ collection: 'notes' as never, data: data as never, overrideAccess: true })

    await payload.create({
      collection: 'blog-posts' as never,
      data: { body: { image: value('hyphen') }, title: 'Hello' } as never,
      overrideAccess: true,
    })
    await note({ heroText: { image: value('camel') } })
    await note({ items: [{ data: { image: value('array') } }] })
    await note({ gallery: [{ data: { image: value('dbName') } }] })
    await note({
      editor: {
        root: {
          type: 'root',
          children: [{ type: 'custom-media', format: '', mediaId: value('custom'), version: 1 }],
          format: '',
          indent: 0,
          version: 1,
        },
      },
    })

    if (!onRelational) {
      const mongo = payload.db as unknown as {
        connection: { db: { collection: (name: string) => { insertOne: (doc: object) => Promise<unknown> } } }
      }

      await mongo.connection.db.collection('legacy_refs').insertOne({ nested: { media: ids.legacy } })
    }

    if (onRelational) {
      await run(payload, 'CREATE TABLE legacy_refs (id integer PRIMARY KEY, media_id integer REFERENCES media(id))')
      await run(payload, `INSERT INTO legacy_refs (id, media_id) VALUES (1, ${Number(ids.legacy)})`)

      const json = db === 'postgres' ? 'jsonb' : 'text'

      await run(payload, `ALTER TABLE notes ADD COLUMN extra ${json}`)
      await run(payload, `UPDATE notes SET extra = '{"image": ${Number(ids.manual)}}'`)
      await run(payload, `CREATE TABLE users_archive (id integer PRIMARY KEY, data ${json})`)
      await run(payload, `INSERT INTO users_archive (id, data) VALUES (1, '{"image": ${Number(ids.lookalike)}}')`)
    }
  })

  afterAll(async () => {
    await teardown()
  })

  it.each(['hyphen', 'camel', 'array', 'dbName', 'custom'])(
    'keeps an upload referenced from a %s json field used',
    async (name) => {
      const id = ids[name]!

      expect(await findUsage(payload, { ...references(), collection: 'media', id })).not.toHaveLength(0)
      expect((await buildUsageIndex(payload, { ...references(), collection: 'media' }))?.has(id)).toBe(true)
      expect(await findUsageDetail(payload, { ...references(), collection: 'media', id })).not.toHaveLength(0)
    },
  )

  it('leaves an upload nothing references unused', async () => {
    const id = ids.idle!

    expect(await findUsage(payload, { ...references(), collection: 'media', id })).toEqual([])
    expect((await buildUsageIndex(payload, { ...references(), collection: 'media' }))?.has(id)).toBe(false)
    expect(await findUsageDetail(payload, { ...references(), collection: 'media', id })).toEqual([])
  })

  it('titles a place in a hyphenated collection, and lists it only to a user who may read it', async () => {
    const detail = (user?: object) =>
      findUsageDetail(payload, { ...references(), collection: 'media', id: ids.hyphen!, user: user as never })
    const person = async (email: string) => ({
      ...(await payload.create({
        collection: 'users' as never,
        data: { email, password: 'secret' } as never,
        overrideAccess: true,
      })),
      collection: 'users',
    })

    expect((await detail())!.map((hit) => [hit.collection, hit.title])).toEqual([['blog-posts', 'Hello']])
    expect((await detail(await person('boss@example.com')))!.map((hit) => hit.title)).toEqual(['Hello'])
    expect(await detail(await person('reader@example.com'))).toEqual([])
  })

  it.runIf(onRelational).each(['manual', 'lookalike'])(
    'reads a %s json column Payload did not create, instead of calling the upload unused',
    async (name) => {
      const id = ids[name]!

      expect(await findUsage(payload, { ...references(), collection: 'media', id })).not.toHaveLength(0)
      expect((await buildUsageIndex(payload, { ...references(), collection: 'media' }))?.has(id)).toBe(true)
    },
  )

  it('shows a reference from a table no collection owns, as the guard counts it', async () => {
    const id = ids.legacy!

    expect(await findUsage(payload, { ...references(), collection: 'media', id })).not.toHaveLength(0)

    const hits = (await findUsageDetail(payload, { ...references(), collection: 'media', id }))!

    expect(hits.map((hit) => [hit.collection, hit.title, hit.url])).toEqual([['legacy_refs', undefined, undefined]])
  })
})

describe(`plugin bookkeeping on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      collections: [{ slug: 'media', fields: [], upload }],
      plugins: [janitor({ collections: { media: true }, references: { text: true } })],
    }))
  })

  afterAll(async () => {
    await teardown()
  })

  it("never counts the plugin's own finding about a document as a reference to it", async () => {
    const id = String(
      (await payload.create({ collection: 'media' as never, data: {}, file: file('found.txt'), overrideAccess: true }))
        .id,
    )
    const options = janitorOptions(payload)!

    await payload.create({
      collection: options.findingsSlug as never,
      data: { collectionSlug: 'media', documentId: id, kind: 'unused', objectKey: id, ref: id } as never,
      overrideAccess: true,
    })

    for (const ignoreTables of [options.references.ignoreTables, [options.findingsSlug, options.runsSlug]]) {
      const args = { ...options.references, collection: 'media', ignoreTables }

      expect(await findUsage(payload, { ...args, id })).toEqual([])
      expect((await buildUsageIndex(payload, args))?.has(id)).toBe(false)
    }
  })
})

describe(`deep json on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      collections: [
        { slug: 'media', fields: [], upload },
        { slug: 'pages', fields: [{ name: 'body', type: 'json' }] },
      ],
    }))
  })

  afterAll(async () => {
    await teardown()
  })

  it('reports an id beyond the walk depth as unknown, never as unused', () => {
    let deep: unknown = { image: 7 }

    for (let level = 0; level < 200; level += 1) deep = { next: deep }

    const found: string[] = []

    expect(walkIds({ near: 3, deep }, (id) => found.push(id))).toBe(false)
    expect(found).toEqual(['3'])
    expect(walkIds({ near: 3 }, () => {})).toBe(true)
  })

  it.runIf(onRelational)('fails closed on a document nested past the walk depth', async () => {
    const created = await payload.create({
      collection: 'media' as never,
      data: {},
      file: file('deep.txt'),
      overrideAccess: true,
    })
    const id = String(created.id)
    let body: unknown = { image: created.id }

    for (let level = 0; level < 200; level += 1) body = { next: body }

    await payload.create({ collection: 'pages' as never, data: { body } as never, overrideAccess: true })

    expect(await findUsage(payload, { ...references(), collection: 'media', id })).not.toHaveLength(0)
    expect(await buildUsageIndex(payload, { ...references(), collection: 'media' })).toBeNull()
    expect(await findUsageDetail(payload, { ...references(), collection: 'media', id })).not.toHaveLength(0)
  })
})

describe('database transport', () => {
  const fake = (adapter: object) => ({ db: adapter }) as unknown as Payload

  it('refuses a transaction whose driver it cannot read, instead of inlining values', async () => {
    const payload = fake({
      name: 'postgres',
      pool: { query: async () => ({ rows: [] }) },
      sessions: { '1': { db: { execute: async () => [] } } },
    })

    await expect(run(payload, 'SELECT $1', ['x'], { transactionID: 1 })).rejects.toThrow(/janitor:/)
  })

  it('does not claim support for a SQLite client without execute, like D1', () => {
    expect(supportsUsage(fake({ name: 'sqlite', client: { prepare: () => {} } }))).toBe(false)
    expect(supportsUsage(fake({ name: 'sqlite', client: { execute: async () => ({ rows: [] }) } }))).toBe(true)
  })

  it('pages collections in id order', async () => {
    const calls: unknown[] = []
    const payload = {
      find: async (args: unknown) => {
        calls.push(args)

        return { docs: [], hasNextPage: false }
      },
    } as unknown as Payload

    await eachPage(payload, 'media', {}, () => {})

    expect(calls).toEqual([expect.objectContaining({ sort: 'id' })])
  })

  it('pages by id, so documents deleted during the pass push nothing out of view', async () => {
    const rows = Array.from({ length: 2500 }, (_, index) => ({ id: index + 1 }))
    const payload = {
      find: async (args: { limit: number; page?: number; where?: { id?: { greater_than?: number } } }) => {
        const after = args.where?.id?.greater_than ?? 0
        const left = rows.filter((row) => row.id > after)
        const page = args.page ?? 1

        return {
          docs: left.slice((page - 1) * args.limit, page * args.limit),
          hasNextPage: page * args.limit < left.length,
        }
      },
    } as unknown as Payload
    const seen: number[] = []

    await eachPage<{ id: number }>(payload, 'media', {}, (docs) => {
      for (const doc of docs) {
        seen.push(doc.id)
        rows.splice(rows.indexOf(doc), 1)
      }
    })

    expect(seen).toHaveLength(2500)
  })
})

if (onPostgres) {
  describe(`foreign keys on ${label} (runs only when TEST_DB=postgres)`, () => {
    const config = (): Parameters<typeof boot>[0] => ({
      collections: [
        { slug: 'media', fields: [], upload },
        { slug: 'posts', fields: [{ name: 'hero', type: 'upload', relationTo: 'media' }] },
      ],
    })

    it('finds a foreign key while the app connects as a role that owns no table', async () => {
      const { payload, teardown } = await boot(config())

      try {
        const hero = (
          await payload.create({ collection: 'media' as never, data: {}, file: file('hero.txt'), overrideAccess: true })
        ).id

        await payload.create({ collection: 'posts' as never, data: { hero } as never, overrideAccess: true })
        await run(payload, 'CREATE ROLE janitor_reader')
        await run(payload, 'GRANT USAGE ON SCHEMA public TO janitor_reader')
        await run(payload, 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO janitor_reader')
        await run(payload, 'SET ROLE janitor_reader')

        expect(await findUsage(payload, { ...references(), collection: 'media', id: String(hero) })).not.toHaveLength(0)
      } finally {
        await run(payload, 'RESET ROLE')
        await teardown()
      }
    })

    it('throws instead of answering unused when no foreign key to the collection is visible', async () => {
      const { payload, teardown } = await boot(config())

      try {
        const id = String(
          (await payload.create({ collection: 'media' as never, data: {}, file: file('x.txt'), overrideAccess: true }))
            .id,
        )
        const keys = await run(
          payload,
          `SELECT c.relname AS "table", k.conname AS "name" FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
           WHERE k.contype = 'f' AND k.confrelid = 'public.media'::regclass`,
        )

        for (const key of keys) await run(payload, `ALTER TABLE "${key.table}" DROP CONSTRAINT "${key.name}"`)

        await expect(findUsage(payload, { ...references(), collection: 'media', id })).rejects.toThrow(/janitor:/)
      } finally {
        await teardown()
      }
    })
  })
}

describe(`fields named parent on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  const post = async (title: string) =>
    (await payload.create({ collection: 'posts' as never, data: { title } as never, overrideAccess: true })).id
  const create = (collection: string, data: Record<string, unknown>) =>
    payload.create({ collection: collection as never, data: data as never, overrideAccess: true })
  const lookups = async (collection: string, id: number | string) => {
    const args = { ...references(), collection, id: String(id) }

    return {
      detail: (await findUsageDetail(payload, args))!.map((hit) => [hit.collection, hit.fields.join(', ')]),
      indexed: (await buildUsageIndex(payload, { ...references(), collection }))?.has(String(id)),
      refs: (await findUsage(payload, args))!.length,
    }
  }

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      blocks: [{ slug: 'reply', fields: [{ name: 'parent', type: 'relationship', relationTo: 'posts' }] }],
      collections: [
        { slug: 'posts', fields: [{ name: 'title', type: 'text' }] },
        { slug: 'tags', fields: [{ name: 'name', type: 'text' }] },
        {
          slug: 'comments',
          fields: [
            { name: 'parent', type: 'relationship', relationTo: 'posts' },
            { name: 'about', type: 'relationship', relationTo: 'tags' },
          ],
        },
        { slug: 'cats', fields: [{ name: 'parent', type: 'relationship', relationTo: 'cats' }] },
        {
          slug: 'threads',
          fields: [
            { name: 'items', type: 'array', fields: [{ name: 'parent', type: 'relationship', relationTo: 'posts' }] },
            { name: 'meta', type: 'group', fields: [{ name: 'parent', type: 'relationship', relationTo: 'posts' }] },
            { name: 'layout', type: 'blocks', blockReferences: ['reply'], blocks: [] },
          ],
        },
        {
          slug: 'links',
          fields: [
            { name: 'parent', type: 'relationship', hasMany: true, relationTo: 'posts' },
            { name: 'owner', type: 'relationship', relationTo: ['posts', 'tags'] },
          ],
        },
        {
          slug: 'drafts',
          fields: [{ name: 'parent', type: 'relationship', relationTo: 'posts' }],
          versions: { drafts: true },
        },
      ],
      plugins: [
        janitor({
          admin: false,
          collections: { cats: { usagePanel: false }, posts: { usagePanel: false } },
          endpoints: false,
        }),
      ],
    }))
  })

  afterAll(async () => {
    await teardown()
  })

  it('counts a relationship named parent, keeps the guard shut and names the right document', async () => {
    const id = await post('commented')
    const tag = (await create('tags', { name: 'about' })).id
    const comment = await create('comments', { about: tag, parent: id })

    expect(await lookups('posts', id)).toEqual({ detail: [['comments', 'Parent']], indexed: true, refs: 1 })
    await expect(payload.delete({ collection: 'posts' as never, id, overrideAccess: true })).rejects.toThrow()

    const about = (await findUsageDetail(payload, { ...references(), collection: 'tags', id: String(tag) }))!

    expect(about.map((hit) => [hit.collection, String(hit.id), hit.fields])).toEqual([
      ['comments', String(comment.id), ['About']],
    ])
  })

  it('counts a self-referencing parent but never the document as its own parent', async () => {
    const root = (await create('cats', {})).id
    const lonely = (await create('cats', {})).id

    await create('cats', { parent: root })
    await payload.update({
      collection: 'cats' as never,
      data: { parent: lonely } as never,
      id: lonely,
      overrideAccess: true,
    })

    expect((await lookups('cats', root)).refs).toBe(1)
    expect((await lookups('cats', root)).indexed).toBe(true)
    expect(await lookups('cats', lonely)).toEqual({ detail: [], indexed: false, refs: 0 })
    await expect(payload.delete({ collection: 'cats' as never, id: root, overrideAccess: true })).rejects.toThrow()
  })

  it.each([
    ['items', (id: unknown) => ({ items: [{ parent: id }] }), 'Items › Parent'],
    ['meta', (id: unknown) => ({ meta: { parent: id } }), 'Meta › Parent'],
    ['layout', (id: unknown) => ({ layout: [{ blockType: 'reply', parent: id }] }), 'Layout › Parent'],
  ])('counts parent inside %s', async (name, data, field) => {
    const id = await post(name)

    await create('threads', data(id))

    const found = await lookups('posts', id)

    expect([found.refs > 0, found.indexed]).toEqual([true, true])
    expect(found.detail.map(([collection]) => collection)).toEqual(['threads'])
    expect(found.detail[0]![1]).toContain(field.split(' › ').at(-1))
  })

  it('counts hasMany and polymorphic parents', async () => {
    const many = await post('many')
    const poly = await post('poly')

    await create('links', { parent: [many] })
    await create('links', { owner: { relationTo: 'posts', value: poly } })

    expect(await lookups('posts', many)).toEqual({ detail: [['links', 'Parent']], indexed: true, refs: 1 })
    expect(await lookups('posts', poly)).toEqual({ detail: [['links', 'Owner']], indexed: true, refs: 1 })
  })

  it('counts parent in a versioned collection, versions included', async () => {
    const id = await post('versioned')
    const draft = await create('drafts', { parent: id })

    await payload.update({
      collection: 'drafts' as never,
      data: { parent: null } as never,
      draft: true,
      id: draft.id,
      overrideAccess: true,
    })

    expect(
      (await findUsage(payload, { ...references(), collection: 'posts', id: String(id) }))!.length,
    ).toBeGreaterThan(0)
    expect(
      (await findUsage(payload, { ...references({ versions: 'unused' }), collection: 'posts', id: String(id) }))!.some(
        (ref) => !ref.versions,
      ),
    ).toBe(true)
  })
})

describe(`many json rows on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      collections: [
        { slug: 'media', fields: [], upload },
        { slug: 'pages', fields: [{ name: 'body', type: 'json' }] },
      ],
    }))

    for (const name of [...Array.from({ length: 10 }, (_, index) => `pad${index}`), 'late', 'crowded', 'idle']) {
      ids[name] = String(
        (
          await payload.create({
            collection: 'media' as never,
            data: {},
            file: file(`${name}.txt`),
            overrideAccess: true,
          })
        ).id,
      )
    }

    if (!onRelational) return

    const json = (text: string) => (db === 'postgres' ? `(${text})::jsonb` : text)
    const insert = (count: number, body: string) =>
      run(
        payload,
        `INSERT INTO pages (body, updated_at, created_at)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
         SELECT ${json(body)}, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z' FROM n`,
      )
    for (const name of ['exponent', 'escaped', 'fraction', 'rounded']) {
      ids[name] = String(
        (
          await payload.create({
            collection: 'media' as never,
            data: {},
            file: file(`${name}.txt`),
            overrideAccess: true,
          })
        ).id,
      )
    }

    const escaped = [...ids.escaped!].map((digit) => `\\u00${digit.charCodeAt(0).toString(16)}`).join('')
    const exponent = `${ids.exponent!.slice(0, 1)}.${ids.exponent!.slice(1)}e${ids.exponent!.length - 1}`

    await insert(1100, `'{"other": ' || (i + 100000) || '}'`)
    await insert(1, `'{"image": ${ids.late}}'`)
    await insert(620, `'{"image": "${ids.crowded}"}'`)
    await insert(1, `'{"image": ${exponent}}'`)
    await insert(1, `'{"image": "${escaped}"}'`)
    await insert(1, `'{"image": ${ids.fraction}.0}'`)
    await insert(1, `'{"image": ${Number(ids.rounded) - 1}.99999999999999999}'`)
  })

  afterAll(async () => {
    await teardown()
  })

  const count = async (id: string) =>
    (await findUsage(payload, { ...references(), collection: 'media', id }))!.reduce((sum, ref) => sum + ref.count, 0)

  it.runIf(onRelational)('pages past the first 500 rows of a json column, both in the index and a lookup', async () => {
    const onProgress = vi.fn()
    const index = await buildUsageIndex(payload, { ...references(), collection: 'media', onProgress })

    expect([index?.has(ids.late!), index?.has(ids.crowded!), index?.has(ids.idle!)]).toEqual([true, true, false])
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(await count(ids.late!)).toBe(1)
    expect(await count(ids.crowded!)).toBe(620)
    expect(await count(ids.idle!)).toBe(0)
  })

  it.runIf(onRelational).each(['exponent', 'escaped', 'fraction', 'rounded'])(
    'finds an id written as a %s in json, whatever the prefilter reads',
    async (name) => {
      expect(await count(ids[name]!)).toBe(1)
    },
  )
})

describe(`binary json on ${label} (runs only when TEST_DB=sqlite)`, () => {
  it.runIf(db === 'sqlite')('never reads a document behind a JSONB blob as unused', async () => {
    const { payload, teardown } = await boot({
      collections: [
        { slug: 'media', fields: [], upload },
        { slug: 'pages', fields: [{ name: 'body', type: 'json' }] },
      ],
    })

    try {
      const id = String(
        (await payload.create({ collection: 'media' as never, data: {}, file: file('blob.txt'), overrideAccess: true }))
          .id,
      )

      await run(
        payload,
        `INSERT INTO pages (body, updated_at, created_at)
         VALUES (jsonb('{"image": ${id}}'), '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
      )

      expect(await findUsage(payload, { ...references(), collection: 'media', id })).not.toEqual([])
      expect(await buildUsageIndex(payload, { ...references(), collection: 'media' })).toBeNull()
    } finally {
      await teardown()
    }
  })
})

describe(`localized references on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      collections: [
        { slug: 'media', fields: [], upload },
        {
          slug: 'articles',
          fields: [
            { name: 'cover', type: 'upload', localized: true, relationTo: 'media' },
            { name: 'gallery', type: 'upload', hasMany: true, localized: true, relationTo: 'media' },
            {
              name: 'hero',
              type: 'upload',
              label: { de: 'Titelbild', en: 'Hero image' },
              relationTo: 'media',
            },
          ],
        },
      ],
      localization: { defaultLocale: 'en', locales: ['en', 'de'] },
    }))
  })

  afterAll(async () => {
    await teardown()
  })

  const media = async (name: string) =>
    (await payload.create({ collection: 'media' as never, data: {}, file: file(`${name}.txt`), overrideAccess: true }))
      .id

  it.each(['cover', 'gallery'])('reports the locale of a localized %s reference', async (field) => {
    const id = await media(field)
    const article = await payload.create({ collection: 'articles' as never, data: {} as never, overrideAccess: true })

    await payload.update({
      collection: 'articles' as never,
      data: { [field]: field === 'gallery' ? [id] : id } as never,
      id: article.id,
      locale: 'de',
      overrideAccess: true,
    })

    const hits = (await findUsageDetail(payload, { ...references(), collection: 'media', id: String(id) }))!

    expect(hits.map((hit) => [hit.collection, hit.fields, hit.locales])).toEqual([
      ['articles', [field === 'gallery' ? 'Gallery' : 'Cover'], ['de']],
    ])
  })

  it('names a field in the language of the request', async () => {
    const id = await media('hero')

    await payload.create({ collection: 'articles' as never, data: { hero: id } as never, overrideAccess: true })

    const detail = (language?: string) =>
      findUsageDetail(payload, {
        ...references(),
        collection: 'media',
        i18n: language ? ({ fallbackLanguage: 'en', language, t: (key: string) => key } as never) : undefined,
        id: String(id),
      })

    expect((await detail('de'))!.map((hit) => hit.fields)).toEqual([['Titelbild']])
    expect((await detail('fr'))!.map((hit) => hit.fields)).toEqual([['Hero image']])
    expect((await detail())!.map((hit) => hit.fields)).toEqual([['Hero image']])
  })
})

describe(`delete guard wording on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}
  let explode = false

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      collections: [
        { slug: 'posts', fields: [] },
        {
          slug: 'remarks',
          fields: [{ name: 'targets', type: 'relationship', hasMany: true, relationTo: 'posts' }],
          hooks: {
            afterRead: [
              ({ doc }) => {
                if (explode) throw new Error('unreadable')

                return doc
              },
            ],
          },
          labels: { plural: 'Remarks', singular: 'Remark' },
        },
      ],
      plugins: [janitor({ admin: false, collections: { posts: { usagePanel: false } }, endpoints: false })],
    }))
  })

  afterAll(async () => {
    await teardown()
  })

  it('names the collection, not the table, when the places cannot be read', async () => {
    const post = await payload.create({ collection: 'posts' as never, data: {} as never, overrideAccess: true })

    await payload.create({
      collection: 'remarks' as never,
      data: { targets: [post.id] } as never,
      overrideAccess: true,
    })
    explode = true

    try {
      const t = (key: string, values: object) => `${key} ${JSON.stringify(values)}`
      const i18n = { fallbackLanguage: 'en', language: 'en', t }
      const error = await payload
        .delete({ collection: 'posts' as never, id: post.id, req: { i18n, t } as never, overrideAccess: true })
        .catch((caught: Error) => caught)

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('"places":"Remark"')
    } finally {
      explode = false
    }
  })
})

describe('mongo walk depth', () => {
  it('throws instead of answering unused when a document nests past the walk depth', async () => {
    let body: unknown = { image: '7' }

    for (let level = 0; level < 200; level += 1) body = { next: body }

    const pages = {
      collectionName: 'pages',
      find: async function* () {
        yield { _id: 'p1', body }
      },
    }
    const payload = {
      config: { localization: false },
      db: {
        collections: { pages: { collection: { collectionName: 'pages' } } },
        connection: { db: { collections: async () => [pages] } },
      },
    } as unknown as Payload
    const args = {
      candidates: new Map([['pages', { fields: new Set(['body']), kind: 'collection' as const, slug: 'pages' }]]),
      collection: 'media',
      ignored: [],
      text: false,
      versions: 'used' as const,
    }

    await expect(findUsageMongo(payload, { ...args, id: '7' })).rejects.toThrow(/janitor:/)
    await expect(buildUsageIndexMongo(payload, { ...args, ids: new Set(['7']) })).rejects.toThrow(/janitor:/)
  })

  it('walks a collection Payload did not create, whole, without text: true', async () => {
    const foreign = {
      collectionName: 'legacy_links',
      find: async function* () {
        yield { _id: 'l1', nested: { media: '7' } }
      },
    }
    const payload = {
      config: { localization: false },
      db: { collections: {}, connection: { db: { collections: async () => [foreign] } } },
    } as unknown as Payload
    const args = {
      candidates: new Map(),
      collection: 'media',
      ignored: [],
      text: false,
      versions: 'used' as const,
    }

    expect(await findUsageMongo(payload, { ...args, id: '7' })).toEqual([
      { column: 'nested.media', count: 1, table: 'legacy_links' },
    ])
    expect(await findUsageMongo(payload, { ...args, id: '8' })).toEqual([])
  })
})

if (db === 'sqlite') {
  describe(`foreign keys on ${label} (runs only when TEST_DB=sqlite)`, () => {
    it('throws instead of answering unused when no foreign key to the collection is visible', async () => {
      const { payload, teardown } = await boot({
        collections: [
          { slug: 'media', fields: [], upload },
          { slug: 'posts', fields: [{ name: 'hero', type: 'upload', relationTo: 'media' }] },
        ],
      })

      try {
        const id = String(
          (await payload.create({ collection: 'media' as never, data: {}, file: file('x.txt'), overrideAccess: true }))
            .id,
        )
        const keys = await run(
          payload,
          `SELECT DISTINCT m.name AS "table" FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
           WHERE m.type = 'table' AND f."table" = 'media'`,
        )

        await run(payload, 'PRAGMA foreign_keys = OFF')

        for (const { table } of keys) {
          await run(payload, `CREATE TABLE "${table}_copy" AS SELECT * FROM "${table}"`)
          await run(payload, `DROP TABLE "${table}"`)
          await run(payload, `ALTER TABLE "${table}_copy" RENAME TO "${table}"`)
        }

        expect(keys.length).toBeGreaterThan(0)
        await expect(findUsage(payload, { ...references(), collection: 'media', id })).rejects.toThrow(/janitor:/)
      } finally {
        await teardown()
      }
    })
  })
}

if (onRelational) {
  describe(`custom table suffixes on ${label} (runs only on relational databases)`, () => {
    let payload: Payload
    let stop = async (): Promise<void> => {}

    beforeAll(async () => {
      const key = `janitor_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const blocksAsJSON = process.env.BLOCKS_AS_JSON === '1'
      const suffixes = { localesSuffix: '_i18n', relationshipsSuffix: '_links', versionsSuffix: '_hist' }
      const pglite = db === 'postgres' ? await startPglite() : undefined
      const adapter = pglite
        ? postgresAdapter({ ...suffixes, blocksAsJSON, pool: { connectionString: pglite.url }, push: true })
        : sqliteAdapter({ ...suffixes, blocksAsJSON, client: { url: ':memory:' }, push: true })

      payload = await getPayload({
        config: buildConfig({
          blocks: [{ slug: 'hero', fields: [{ name: 'image', type: 'upload', relationTo: 'media' }] }],
          collections: [
            { slug: 'media', fields: [], upload, versions: true },
            {
              slug: 'posts',
              fields: [
                { name: 'parent', type: 'relationship', relationTo: 'posts' },
                { name: 'hero', type: 'upload', relationTo: 'media' },
                { name: 'gallery', type: 'upload', hasMany: true, relationTo: 'media' },
                { name: 'cover', type: 'upload', localized: true, relationTo: 'media' },
                { name: 'layout', type: 'blocks', blockReferences: ['hero'], blocks: [] },
              ],
              versions: { drafts: true },
            },
          ],
          db: adapter,
          localization: { defaultLocale: 'en', locales: ['en', 'de'] },
          secret: 'suffixes',
          typescript: { autoGenerate: false },
        }),
        key,
      })

      stop = async () => {
        const pool = (payload.db as { pool?: { on: (event: 'error', handle: () => void) => void } }).pool

        await payload.db.destroy?.()
        pool?.on('error', () => {})
        await pglite?.stop()
        ;(globalThis as { _payload?: Map<string, unknown> })._payload?.delete(key)
      }
    })

    afterAll(async () => {
      await stop()
    })

    const media = async (name: string) =>
      (
        await payload.create({
          collection: 'media' as never,
          data: {},
          file: file(`${name}.txt`),
          overrideAccess: true,
        })
      ).id
    const post = (data: Record<string, unknown>) =>
      payload.create({
        collection: 'posts' as never,
        data: { _status: 'published', ...data } as never,
        overrideAccess: true,
      })
    const lookups = async (collection: string, id: number | string, versions: 'unused' | 'used' = 'used') => {
      const args = { ...references({ versions }), collection, id: String(id) }
      const refs = (await findUsage(payload, args))!

      return {
        detail: (await findUsageDetail(payload, args))!
          .filter((hit) => hit.versionId === undefined)
          .map((hit) => [hit.collection, hit.fields.join(', '), hit.locales]),
        indexed: (await buildUsageIndex(payload, { ...references({ versions }), collection }))?.has(String(id)),
        live: refs.some((ref) => !ref.versions),
        refs: refs.length,
      }
    }

    it('reads the adapter suffixes', () => {
      const adapter = payload.db as unknown as Record<string, unknown>

      expect([adapter.localesSuffix, adapter.relationshipsSuffix, adapter.versionsSuffix]).toEqual([
        '_i18n',
        '_links',
        '_hist',
      ])
    })

    it('keeps an upload referenced through every table shape used', async () => {
      const hero = await media('hero')
      const gallery = await media('gallery')
      const cover = await media('cover')
      const block = await media('block')
      const idle = await media('idle')
      const created = await post({ gallery: [gallery], hero, layout: [{ blockType: 'hero', image: block }] })

      await payload.update({
        collection: 'posts' as never,
        data: { cover } as never,
        id: created.id,
        locale: 'de',
        overrideAccess: true,
      })

      for (const [id, field] of [
        [hero, 'Hero'],
        [gallery, 'Gallery'],
        [cover, 'Cover'],
        [block, 'Layout › Image'],
      ] as const) {
        const found = await lookups('media', id, 'unused')

        expect([found.refs > 0, found.live, found.indexed]).toEqual([true, true, true])
        expect(found.detail.map(([collection]) => collection)).toEqual(['posts'])
        expect(found.detail[0]![1]).toBe(field)
      }

      expect((await lookups('media', cover)).detail[0]![2]).toEqual(['de'])
      expect(await lookups('media', idle)).toEqual({ detail: [], indexed: false, live: false, refs: 0 })
    })

    it('counts a parent field, never a post or an upload as used by its own versions', async () => {
      const root = await post({})
      const child = await post({ parent: root.id })
      const lonely = await media('lonely')

      await payload.update({
        collection: 'posts' as never,
        data: { _status: 'published' } as never,
        id: child.id,
        overrideAccess: true,
      })
      await payload.update({ collection: 'media' as never, data: {} as never, id: lonely, overrideAccess: true })

      expect((await lookups('posts', root.id)).refs).toBeGreaterThan(0)
      expect((await lookups('posts', root.id)).detail.map(([collection, field]) => [collection, field])).toEqual([
        ['posts', 'Parent'],
      ])
      expect(await lookups('posts', child.id)).toEqual({ detail: [], indexed: false, live: false, refs: 0 })
      expect(await lookups('media', lonely)).toEqual({ detail: [], indexed: false, live: false, refs: 0 })
    })

    it('tags a reference only an old version holds', async () => {
      const id = await media('old')
      const created = await post({ hero: id })

      await payload.update({
        collection: 'posts' as never,
        data: { hero: null } as never,
        id: created.id,
        overrideAccess: true,
      })

      const found = await lookups('media', id, 'unused')

      expect([found.refs > 0, found.live, found.indexed]).toEqual([true, false, true])
    })
  })
}
