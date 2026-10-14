import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import type { CollectionConfig, Payload, PayloadRequest } from 'payload'
import { createPayloadRequest } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { janitor } from '@/index.js'
import { purgeApproved } from '@/server/purge.js'
import { scanStorage } from '@/server/scan.js'
import { PLUGIN_NAME } from '@/shared/constants.js'
import type { ResolvedOptions } from '@/shared/types/resolved.js'

import { boot } from '../helpers/boot.js'
import { memoryAdapter } from '../memoryAdapter.js'

type Finding = {
  collectionSlug: string
  id: number | string
  kind: string
  note?: null | string
  objectKey: string
  status: string
  tenant?: (number | string)[] | null
}

type Doc = { filename?: string; id: number | string }

type User = Doc & { collection: string }

const label = `${process.env.TEST_DB ?? 'sqlite'}${process.env.BLOCKS_AS_JSON === '1' ? ' (blocks as json)' : ''}`

const storage = memoryAdapter()

const collections: CollectionConfig[] = [
  { slug: 'users', auth: true, fields: [{ name: 'roles', type: 'select', hasMany: true, options: ['super'] }] },
  { slug: 'tenants', fields: [{ name: 'name', type: 'text' }] },
  { slug: 'photos', fields: [], upload: { disableLocalStorage: true } },
  { slug: 'notes', fields: [{ name: 'title', type: 'text' }] },
  { slug: 'tags', fields: [{ name: 'name', type: 'text' }] },
]

let payload: Payload
let options: ResolvedOptions
let teardown = async (): Promise<void> => {}
let gold: number | string
let blue: number | string
let owner: User
let editor: User
let manager: User
let loner: User

const as = (user: User): Promise<PayloadRequest> => createPayloadRequest({ payload, user: user as never })

const post = async (path: string, user: User): Promise<Response> =>
  payload.config.endpoints.find((item) => item.path === path)!.handler(await as(user))

const create = async (collection: string, data: Record<string, unknown>): Promise<Doc> =>
  (await payload.create({ collection: collection as never, data: data as never, overrideAccess: true })) as Doc

const photo = async (name: string, tenant: number | string): Promise<Doc> =>
  (await payload.create({
    collection: 'photos' as never,
    data: { tenant } as never,
    file: { data: Buffer.from(name), mimetype: 'text/plain', name, size: name.length },
    overrideAccess: true,
  })) as Doc

const userOf = async (data: Record<string, unknown>): Promise<User> => ({
  ...(await create('users', { password: 'secret', ...data })),
  collection: 'users',
})

const findings = async (user?: User): Promise<Finding[]> =>
  (
    await payload.find({
      collection: options.findingsSlug as never,
      depth: 0,
      pagination: false,
      sort: 'objectKey',
      ...(user ? { overrideAccess: false, req: await as(user), user: user as never } : { overrideAccess: true }),
    })
  ).docs as unknown as Finding[]

const asUser = async (user: User) => ({ overrideAccess: false, req: await as(user), user: user as never })

const findingOf = async (objectKey: string): Promise<Finding> =>
  (await findings()).find((item) => item.objectKey === objectKey)!

const tenantOf = (finding: Finding): (number | string)[] => finding.tenant ?? []

const decide = (finding: Finding, status: string) =>
  payload.update({
    collection: options.findingsSlug as never,
    data: { status } as never,
    id: finding.id,
    overrideAccess: true,
  })

const move = (collection: string, id: number | string, tenant: number | string) =>
  payload.update({ collection: collection as never, data: { tenant } as never, id, overrideAccess: true })

beforeAll(async () => {
  ;({ payload, teardown } = await boot({
    collections,
    plugins: [
      janitor({ collections: { notes: true, photos: true, tags: true }, minAge: 0, storage, tenants: true }),
      multiTenantPlugin({
        collections: { notes: {}, photos: {} },
        userHasAccessToAllTenants: (user) => Boolean((user as { roles?: string[] }).roles?.includes('super')),
      }),
    ],
  }))

  options = (payload.config.custom as Record<string, ResolvedOptions>)[PLUGIN_NAME]!
  gold = (await create('tenants', { name: 'gold' })).id
  blue = (await create('tenants', { name: 'blue' })).id
  owner = await userOf({ email: 'owner@example.com', roles: ['super'] })
  editor = await userOf({ email: 'editor@example.com', tenants: [{ tenant: gold }] })
  manager = await userOf({ email: 'manager@example.com', tenants: [{ tenant: gold }, { tenant: blue }] })
  loner = await userOf({ email: 'loner@example.com' })
})

afterAll(async () => {
  await teardown()
})

beforeEach(async () => {
  for (const slug of ['photos', 'notes', 'tags', options.findingsSlug, options.runsSlug]) {
    await payload.delete({ collection: slug as never, where: {}, overrideAccess: true })
  }

  storage.objects.clear()
})

describe(`tenants on ${label}`, () => {
  const seed = async () => {
    const lost = (await photo('lost.txt', gold)).filename!
    const kept = (await photo('kept.txt', blue)).filename!

    storage.put(kept)
    storage.put('stray.txt')

    const note = await create('notes', { tenant: gold, title: 'gold note' })
    const tag = await create('tags', { name: 'shared' })

    await scanStorage(payload, options)

    return { kept, lost, note: `notes/${note.id}`, tag: `tags/${tag.id}` }
  }

  it('writes the tenant of the document on missing and unused findings, none on orphans and unscoped ones', async () => {
    const { kept, lost, note, tag } = await seed()
    const all = await findings()

    expect(all.map((finding) => [finding.objectKey, finding.kind, tenantOf(finding)])).toEqual(
      [
        [kept, 'unused', [blue]],
        [lost, 'missing', [gold]],
        [note, 'unused', [gold]],
        ['stray.txt', 'orphan', []],
        [tag, 'unused', []],
      ].toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
    )
  })

  it("shows a tenant admin only their tenants' findings and lets them decide those", async () => {
    const { kept, lost, note } = await seed()
    const req = await as(editor)
    const blueFinding = await findingOf(kept)
    const goldFinding = await findingOf(note)

    expect((await findings(editor)).map((finding) => finding.objectKey).toSorted()).toEqual([lost, note].toSorted())
    expect(await findings(owner)).toHaveLength(5)

    await payload.update({
      collection: options.findingsSlug as never,
      data: { note: 'mine', status: 'keep' } as never,
      id: goldFinding.id,
      overrideAccess: false,
      req,
      user: editor as never,
    })

    expect(await findingOf(note)).toMatchObject({ note: 'mine', status: 'keep' })
    await expect(
      payload.update({
        collection: options.findingsSlug as never,
        data: { status: 'delete' } as never,
        id: blueFinding.id,
        overrideAccess: false,
        req,
        user: editor as never,
      }),
    ).rejects.toThrow()
    expect(await findingOf(kept)).toMatchObject({ status: 'found' })
  })

  it('refuses scan and purge to a tenant admin and hides runs from them', async () => {
    expect((await post('/janitor/scan', editor)).status).toBe(403)
    expect((await post('/janitor/purge', editor)).status).toBe(403)
    expect((await post('/janitor/scan', owner)).status).toBe(200)
    expect((await post('/janitor/purge', owner)).status).toBe(200)

    const runsAs = async (user: User) =>
      payload.find({
        collection: options.runsSlug as never,
        overrideAccess: false,
        req: await as(user),
        user: user as never,
      })

    expect((await runsAs(owner)).totalDocs).toBe(2)
    await expect(runsAs(editor)).rejects.toThrow()
  })

  it('keeps a decision on rescan and resets it when the document moves to another tenant', async () => {
    const { note } = await seed()

    await decide(await findingOf(note), 'delete')
    await scanStorage(payload, options)

    expect(await findingOf(note)).toMatchObject({ status: 'delete' })

    await move('notes', note.split('/')[1]!, blue)
    await scanStorage(payload, options)

    const moved = await findingOf(note)

    expect(moved.status).toBe('found')
    expect(tenantOf(moved)).toEqual([blue])
  })

  it('keeps the decisions of findings written before tenants was on', async () => {
    const note = await create('notes', { tenant: gold, title: 'older' })

    await payload.create({
      collection: options.findingsSlug as never,
      data: {
        collectionSlug: 'notes',
        documentId: String(note.id),
        kind: 'unused',
        objectKey: `notes/${note.id}`,
        status: 'delete',
      } as never,
      overrideAccess: true,
    })
    await scanStorage(payload, options)

    const finding = await findingOf(`notes/${note.id}`)

    expect(finding.status).toBe('delete')
    expect(tenantOf(finding)).toEqual([gold])
  })

  it('skips a document that moved to another tenant after approval', async () => {
    const { note } = await seed()
    const id = note.split('/')[1]!

    await decide(await findingOf(note), 'delete')
    await move('notes', id, blue)

    const report = await purgeApproved(payload, options)

    expect(report.skipped).toEqual([{ key: note, reason: 'the document moved to another tenant' }])
    expect(await findingOf(note)).toMatchObject({ note: 'the document moved to another tenant', status: 'keep' })
    expect(
      await payload.count({ collection: 'notes' as never, where: { id: { equals: id } }, overrideAccess: true }),
    ).toEqual({
      totalDocs: 1,
    })
  })

  it("limits a tenant admin's bulk update and delete to their tenants' findings", async () => {
    const { kept, lost, note, tag } = await seed()
    const collection = options.findingsSlug as never

    await payload.update({ collection, data: { status: 'keep' } as never, where: {}, ...(await asUser(editor)) })

    expect(
      (await findings())
        .filter((finding) => finding.status === 'keep')
        .map((finding) => finding.objectKey)
        .toSorted(),
    ).toEqual([lost, note].toSorted())

    await payload.delete({ collection, where: {}, ...(await asUser(editor)) })

    expect((await findings()).map((finding) => finding.objectKey).toSorted()).toEqual(
      [kept, 'stray.txt', tag].toSorted(),
    )
  })

  it("refuses a tenant admin another tenant's finding by id and keeps the tenant they send", async () => {
    const { kept, note } = await seed()
    const collection = options.findingsSlug as never

    await expect(
      payload.delete({ collection, id: (await findingOf(kept)).id, ...(await asUser(editor)) }),
    ).rejects.toThrow()
    expect(await findingOf(kept)).toBeDefined()

    await payload.update({
      collection,
      data: { note: 'mine', tenant: [blue] } as never,
      id: (await findingOf(note)).id,
      ...(await asUser(editor)),
    })

    expect(await findingOf(note)).toMatchObject({ note: 'mine', tenant: [gold] })
  })

  it('shows no findings to a user without tenants', async () => {
    await seed()

    await expect(findings(loner)).rejects.toThrow()
  })

  it("answers 404 on the usage route for another tenant's document", async () => {
    const own = await create('notes', { tenant: gold, title: 'gold note' })
    const other = await create('notes', { tenant: blue, title: 'blue note' })
    const route = payload.config.endpoints.find((item) => item.path === '/janitor/usage/:collection/:id')!
    const usage = async (doc: Doc) =>
      (
        await route.handler(
          Object.assign(await as(editor), {
            routeParams: { collection: 'notes', id: String(doc.id) },
            searchParams: new URLSearchParams(),
          }),
        )
      ).status

    expect(await usage(own)).toBe(200)
    expect(await usage(other)).toBe(404)
  })

  it('treats a user whose tenants access returns a query as a tenant admin, even with every tenant', async () => {
    const { kept, lost, note } = await seed()

    expect((await findings(manager)).map((finding) => finding.objectKey).toSorted()).toEqual(
      [kept, lost, note].toSorted(),
    )
    expect((await post('/janitor/scan', manager)).status).toBe(403)
  })

  it('clears the tenant of findings in a collection without the tenant field and purges their documents', async () => {
    const tag = await create('tags', { name: 'stale' })
    const key = `tags/${tag.id}`

    await payload.create({
      collection: options.findingsSlug as never,
      data: {
        collectionSlug: 'tags',
        documentId: String(tag.id),
        kind: 'unused',
        objectKey: key,
        status: 'delete',
        tenant: [gold],
      } as never,
      overrideAccess: true,
    })
    await scanStorage(payload, options)

    const reset = await findingOf(key)

    expect(reset.status).toBe('found')
    expect(tenantOf(reset)).toEqual([])

    await decide(reset, 'delete')

    const report = await purgeApproved(payload, options)

    expect(report.skipped).toEqual([])
    expect(report.deleted).toBe(1)
  })
})
