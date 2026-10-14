import type { Payload, PayloadRequest, Where } from 'payload'
import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { breakdownOf } from '@/rsc/RunSummary/RunSummary.utils.js'
import { purgeApproved } from '@/server/purge.js'
import { runJanitor, startJanitor } from '@/server/run.js'
import { scanStorage } from '@/server/scan.js'
import { buildUsageIndex, findUsage, findUsageDetail, usageDetail } from '@/server/usage/index.js'
import { PLUGIN_NAME } from '@/shared/constants.js'
import type { ResolvedOptions } from '@/shared/types/resolved.js'

import config, { storage } from '../payload.config.js'
import type { Fixture, Seeded } from '../seed.js'
import { clear, FILES, filenameOf, FIXTURES, REFERENCED, seed } from '../seed.js'

let payload: Payload
let options: ResolvedOptions
let seeded: Seeded

const label = `${process.env.TEST_DB ?? 'sqlite'}${process.env.BLOCKS_AS_JSON === '1' ? ' (blocks as json)' : ''}`

const usageOf = async (fixture: Fixture) =>
  (await findUsage(payload, { ...options.references, collection: 'media', id: String(seeded.ids[fixture]) })) ?? []

const findings = async (where: Where = {}) =>
  payload.find({
    collection: options.findingsSlug as 'media',
    depth: 0,
    pagination: false,
    where,
    overrideAccess: true,
  })

beforeAll(async () => {
  payload = await getPayload({ config })
  options = (payload.config.custom as Record<string, ResolvedOptions>)[PLUGIN_NAME]!

  await clear(payload, options)
  storage.objects.clear()

  seeded = await seed(payload)
})

afterAll(async () => {
  await payload.db.destroy?.()
})

describe(`usage on ${label}`, () => {
  const cases = REFERENCED.map((fixture) => [FIXTURES[fixture], fixture] as const)

  it.each(cases)('finds a reference stored in %s', async (_shape, fixture) => {
    expect([fixture, (await usageOf(fixture)).length]).not.toEqual([fixture, 0])
  })

  it('finds the draft-only reference in a versions table, not in the published document', async () => {
    const usage = await usageOf('draftOnly')

    expect(usage.every((ref) => /_v($|_)|versions/.test(ref.table))).toBe(true)
  })

  it('does not count an id that merely appears in a text field', async () => {
    expect(await usageOf('unused')).toHaveLength(0)
  })

  it('names the sibling upload that points at a self-related one', async () => {
    const usage = await usageOf('thumbnail')

    expect(usage.some((ref) => /^media$/.test(ref.table) && /thumbnail/.test(ref.column))).toBe(true)
  })

  it('does not count an upload pointing at itself as used', async () => {
    const selfie = await payload.create({
      collection: 'media',
      data: { alt: 'selfie' },
      file: { data: Buffer.from('selfie'), mimetype: 'text/plain', name: 'selfie.txt', size: 6 },
      overrideAccess: true,
    })

    await payload.update({ collection: 'media', data: { thumbnail: selfie.id }, id: selfie.id, overrideAccess: true })

    expect(
      await findUsage(payload, { ...options.references, collection: 'media', id: String(selfie.id) }),
    ).toHaveLength(0)

    const index = await buildUsageIndex(payload, { ...options.references, collection: 'media' })

    expect(index?.has(String(selfie.id))).toBe(false)

    await payload.delete({ collection: 'media', id: selfie.id, overrideAccess: true })
  })

  it('builds the same answers in one pass', async () => {
    const index = await buildUsageIndex(payload, { ...options.references, collection: 'media' })

    for (const fixture of Object.keys(FIXTURES) as Fixture[]) {
      expect([fixture, index?.has(String(seeded.ids[fixture]))]).toEqual([fixture, fixture !== 'unused'])
    }
  })
})

describe(`usage detail on ${label}`, () => {
  const detailOf = async (fixture: Fixture) =>
    (await findUsageDetail(payload, { ...options.references, collection: 'media', id: String(seeded.ids[fixture]) })) ??
    []

  it('names the document, the field and a link to it', async () => {
    const [hit, ...rest] = await detailOf('hero')

    expect(rest).toHaveLength(0)
    expect(hit).toMatchObject({ collection: 'posts', global: false, status: 'published', title: 'seeded post' })
    expect(hit!.fields.some((field) => /hero/i.test(field))).toBe(true)
    expect(hit!.url).toBe(`/admin/collections/posts/${hit!.id}#field-hero`)
  })

  it('names a field buried in a block', async () => {
    const [hit] = await detailOf('blockGroup')

    expect(hit!.fields.some((field) => /portrait/i.test(field))).toBe(true)
  })

  it('anchors a field inside a block to the block itself, whose id needs no row index', async () => {
    const [hit] = await detailOf('blockGroup')

    expect(hit!.url).toContain('#field-layout')
  })

  it('links a global to its own view', async () => {
    const [hit] = await detailOf('logo')

    expect(hit).toMatchObject({ collection: 'settings', global: true, url: '/admin/globals/settings#field-logo' })
  })

  it('finds the draft-only reference as a version, with a link to that version', async () => {
    const hits = await detailOf('draftOnly')

    expect(hits).not.toHaveLength(0)

    for (const hit of hits) {
      expect(hit.versionId).toBeDefined()
      expect(hit.url).toBe(`/admin/collections/deep/${hit.id}/versions/${hit.versionId}`)
      expect(['draft', 'version']).toContain(hit.status)
    }
  })

  it('answers the usage route with the verdict purge would give', async () => {
    const route = payload.config.endpoints.find((item) => item.path === '/janitor/usage/:collection/:id')!
    const ask = async (fixture: Fixture) => {
      const req = {
        payload,
        routeParams: { collection: 'media', id: String(seeded.ids[fixture]) },
        searchParams: new URLSearchParams(),
        user: { collection: 'users', id: 1 },
      }

      return (await route.handler(req as unknown as PayloadRequest)).json()
    }

    expect(await ask('hero')).toMatchObject({ supported: true, used: true })
    expect(await ask('unused')).toEqual({ supported: true, usage: [], used: false })
  })

  it('lists only what the user may read, and answers 404 for a target the user may not read', async () => {
    const route = payload.config.endpoints.find((item) => item.path === '/janitor/usage/:collection/:id')!
    const hero = { ...options.references, collection: 'media', id: String(seeded.ids.hero) }
    const missing = {
      payload,
      routeParams: { collection: 'media', id: '999999' },
      searchParams: new URLSearchParams(),
      user: { collection: 'users', id: 1 },
    }

    expect(await findUsageDetail(payload, hero)).not.toHaveLength(0)
    expect(await findUsageDetail(payload, { ...hero, user: null })).toEqual([])
    expect((await route.handler(missing as unknown as PayloadRequest)).status).toBe(404)
  })

  it('reports every place at once, and limits only when asked', async () => {
    const all = await findUsageDetail(payload, {
      ...options.references,
      collection: 'media',
      id: String(seeded.ids.deep),
    })
    const one = await findUsageDetail(payload, {
      ...options.references,
      collection: 'media',
      id: String(seeded.ids.deep),
      limit: 1,
    })

    expect(all!.length).toBeGreaterThan(1)
    expect(one).toHaveLength(1)
  })

  it('counts only the places that block a delete when old versions do not', async () => {
    const args = { ...options.references, collection: 'media', id: String(seeded.ids.deep) }
    const used = await usageDetail(payload, args)
    const unused = await usageDetail(payload, { ...args, versions: 'unused' })

    expect(unused!.total).toBe(used!.hits.filter((hit) => hit.status !== 'version').length)
    expect(unused!.total).toBeLessThan(used!.total)
  })
})

describe(`scan on ${label}`, () => {
  it('reports an object with no document as an orphan', async () => {
    storage.put('media/stray.txt')

    const report = await scanStorage(payload, options)

    expect(report.orphans).toBe(1)
    expect((await findings({ kind: { equals: 'orphan' } })).docs).toHaveLength(1)
  })

  it('reports a document with no object as missing', async () => {
    const report = await scanStorage(payload, options)

    expect(report.missing).toBe(Object.keys(FIXTURES).length + Object.keys(FILES).length)
  })

  it('reports only the unreferenced upload once its object exists', async () => {
    for (const fixture of Object.keys(FIXTURES) as Fixture[]) storage.put(`media/${filenameOf(fixture)}`)
    for (const fixture of Object.keys(FILES)) storage.put(`files/${filenameOf(fixture as keyof typeof FILES)}`)

    const report = await scanStorage(payload, options)

    expect(report.missing).toBe(0)
    expect(report.unused).toBe(2)

    expect([report.byCollection.media?.unused, report.byCollection.files?.unused]).toEqual([1, 1])

    const unused = await findings({ kind: { equals: 'unused' } })
    const keys = (unused.docs as unknown as { objectKey: string }[]).map((doc) => doc.objectKey).toSorted()

    expect(keys).toEqual([`files/${filenameOf('spare')}`, `media/${seeded.unusedFilename}`])
  })

  it('breaks a run down by collection from the findings it saw last', async () => {
    const run = await payload.create({
      collection: options.runsSlug as 'media',
      data: { mode: 'scan', startedAt: new Date().toISOString(), status: 'done' } as never,
      overrideAccess: true,
    })
    const report = await scanStorage(payload, options, run.id)
    const req = await createLocalReq({ user: { collection: 'users', id: 1 } as never }, payload)
    const rows = await breakdownOf(req, run.id, 'scan')
    const expected = Object.entries(report.byCollection).flatMap(([slug, stats]) => {
      const counts = Object.fromEntries(
        (['orphans', 'missing', 'unused'] as const)
          .filter((tally) => stats[tally] > 0)
          .map((tally) => [tally, stats[tally]]),
      )

      return Object.keys(counts).length > 0 ? [[slug, counts]] : []
    })

    expect(rows.length).toBeGreaterThan(1)
    expect(Object.fromEntries(rows.map((row) => [row.slug, row.counts]))).toEqual(Object.fromEntries(expected))
  })

  it('keeps the human decision on a rescan and drops only undecided findings that resolved', async () => {
    storage.put('media/passing.txt')
    await scanStorage(payload, options)

    const orphan = (await findings({ objectKey: { equals: 'media/stray.txt' } })).docs[0]!

    await payload.update({
      collection: options.findingsSlug as 'media',
      data: { status: 'keep' } as never,
      id: orphan.id,
      overrideAccess: true,
    })

    await scanStorage(payload, options)

    const after = await payload.findByID({
      collection: options.findingsSlug as 'media',
      id: orphan.id,
      overrideAccess: true,
    })
    expect((after as unknown as { status: string }).status).toBe('keep')

    storage.objects.delete('media/stray.txt')
    storage.objects.delete('media/passing.txt')
    await scanStorage(payload, options)

    const left = (await findings({ kind: { equals: 'orphan' } })).docs as unknown as { objectKey: string }[]

    expect(left.map((doc) => doc.objectKey)).toEqual(['media/stray.txt'])
  })
})

describe(`purge on ${label}`, () => {
  it('never touches a finding the admin left alone', async () => {
    const report = await purgeApproved(payload, options)

    expect(report.deleted).toBe(0)
    expect(storage.objects.has(`media/${seeded.unusedFilename}`)).toBe(true)
  })

  it('deletes an approved unused upload together with its document', async () => {
    const unused = (await findings({ collectionSlug: { equals: 'media' }, kind: { equals: 'unused' } })).docs[0]!

    await payload.update({
      collection: options.findingsSlug as 'media',
      data: { status: 'delete' } as never,
      id: unused.id,
      overrideAccess: true,
    })

    const report = await purgeApproved(payload, options)

    expect(report.deleted).toBe(1)

    const media = await payload.find({
      collection: 'media',
      where: { filename: { equals: seeded.unusedFilename } },
      overrideAccess: true,
    })

    expect(media.docs).toHaveLength(0)

    const done = await payload.findByID({
      collection: options.findingsSlug as 'media',
      id: unused.id,
      overrideAccess: true,
    })

    expect(done).toMatchObject({ purgedAt: expect.any(String), status: 'deleted' })
    expect(done).not.toHaveProperty('deletedAt')
  })

  it('lets only the plugin set or clear the deleted status', async () => {
    const found = (await findings({ status: { equals: 'found' } })).docs[0]!
    const purged = (await findings({ status: { equals: 'deleted' } })).docs[0]!
    const write = (id: number | string, data: Record<string, unknown>) =>
      payload.update({
        collection: options.findingsSlug as 'media',
        data: data as never,
        id,
        overrideAccess: false,
        user: { collection: 'users', id: 1 } as never,
      })

    await expect(write(found.id, { status: 'deleted' })).rejects.toMatchObject({
      data: { errors: [{ message: 'Only the plugin sets or clears the deleted status.', path: 'status' }] },
    })
    await expect(write(purged.id, { status: 'found' })).rejects.toThrow('status')
    await expect(write(purged.id, { note: 'Kept for audit' })).resolves.toMatchObject({
      note: 'Kept for audit',
      status: 'deleted',
    })
    await expect(write(found.id, { status: 'keep' })).resolves.toMatchObject({ status: 'keep' })
    await write(found.id, { status: 'found' })
  })

  it('hands the provider back the handle its listing gave', async () => {
    storage.put('media/handle.txt', { ref: 'https://blob.example/handle-abc123' })
    await scanStorage(payload, options)

    const orphan = (await findings({ objectKey: { equals: 'media/handle.txt' } })).docs[0]!

    await payload.update({
      collection: options.findingsSlug as 'media',
      data: { status: 'delete' } as never,
      id: orphan.id,
      overrideAccess: true,
    })

    storage.deletes.length = 0
    await purgeApproved(payload, options)

    expect(storage.deletes).toEqual([
      { collection: 'media', key: 'media/handle.txt', prefix: 'media', ref: 'https://blob.example/handle-abc123' },
    ])
  })

  it('refuses to delete a finding whose file became used again', async () => {
    storage.put('media/reused.txt')
    await scanStorage(payload, options)

    const orphan = (await findings({ objectKey: { equals: 'media/reused.txt' } })).docs[0]!

    await payload.update({
      collection: options.findingsSlug as 'media',
      data: { status: 'delete' } as never,
      id: orphan.id,
      overrideAccess: true,
    })

    await payload.create({
      collection: 'media',
      data: { alt: 'reused' },
      file: { data: Buffer.from('reused'), mimetype: 'text/plain', name: 'reused.txt', size: 6 },
      overrideAccess: true,
    })

    const report = await purgeApproved(payload, options)

    expect(report.deleted).toBe(0)
    expect(report.skipped).toHaveLength(1)
    expect(storage.objects.has('media/reused.txt')).toBe(true)
  })
})

describe(`protection on ${label}`, () => {
  it('refuses to delete an upload something still points at', async () => {
    await expect(payload.delete({ collection: 'media', id: seeded.ids.hero, overrideAccess: true })).rejects.toThrow(
      /still used/,
    )
  })

  it('refuses to delete an upload only the latest draft points at', async () => {
    await expect(
      payload.delete({ collection: 'media', id: seeded.ids.draftOnly, overrideAccess: true }),
    ).rejects.toThrow(/still used/)
  })

  it('names only the places the user may read', async () => {
    const shared = await payload.create({
      collection: 'media',
      data: { alt: 'shared' },
      file: { data: Buffer.from('shared'), mimetype: 'text/plain', name: 'shared.txt', size: 6 },
      overrideAccess: true,
    })

    await payload.create({
      collection: 'simple',
      data: { image: shared.id, title: 'hidden from the user' },
      overrideAccess: true,
    })

    const error = await payload
      .delete({
        collection: 'media',
        id: shared.id,
        overrideAccess: false,
        user: { collection: 'users', id: 1 } as never,
      })
      .catch((caught: unknown) => caught)

    expect(String(error)).toMatch(/still used/)
    expect(String(error)).not.toMatch(/hidden from the user/)
  })

  it('counts the places the user may not read', async () => {
    const shared = await payload.create({
      collection: 'media',
      data: { alt: 'counted' },
      file: { data: Buffer.from('counted'), mimetype: 'text/plain', name: 'counted.txt', size: 7 },
      overrideAccess: true,
    })

    for (const title of ['seen by the user', 'hidden from the user'])
      await payload.create({ collection: 'simple', data: { image: shared.id, title }, overrideAccess: true })

    const error = await payload
      .delete({
        collection: 'media',
        id: shared.id,
        overrideAccess: false,
        user: { collection: 'users', id: 1 } as never,
      })
      .catch((caught: unknown) => caught)

    expect(String(error)).toMatch(/used in 2 places/)
    expect(String(error)).toMatch(/seen by the user/)
    expect(String(error)).not.toMatch(/hidden from the user/)
  })

  it('checks a global the user may read inside the delete transaction', { timeout: 15_000 }, async () => {
    await expect(
      payload.delete({
        collection: 'media',
        id: seeded.ids.logo,
        overrideAccess: false,
        user: { collection: 'users', id: 1 } as never,
      }),
    ).rejects.toThrow(/still used/)
  })

  it('keeps the rest of a bulk delete when a place the user may not read blocks one upload', async () => {
    const create = (name: string) =>
      payload.create({
        collection: 'media',
        data: { alt: name },
        file: { data: Buffer.from(name), mimetype: 'text/plain', name, size: name.length },
        overrideAccess: true,
      })
    const free = await create('free.txt')
    const blocked = await create('blocked.txt')

    await payload.create({
      collection: 'locked' as 'media',
      data: { image: blocked.id } as never,
      overrideAccess: true,
    })

    const result = await payload.delete({
      collection: 'media',
      overrideAccess: false,
      user: { collection: 'users', id: 1 } as never,
      where: { id: { in: [free.id, blocked.id] } },
    })
    const left = await payload.find({
      collection: 'media',
      overrideAccess: true,
      where: { id: { in: [free.id, blocked.id] } },
    })

    expect(result.docs.map((doc) => doc.id)).toEqual([free.id])
    expect(result.errors.map((error) => [error.id, error.message])).toEqual([
      [blocked.id, expect.stringMatching(/still used in 1 place/)],
    ])
    expect(left.docs.map((doc) => doc.id)).toEqual([blocked.id])
  })

  it('names only the places anyone may read on a delete from outside without a user', async () => {
    const shared = await payload.create({
      collection: 'media',
      data: { alt: 'anonymous' },
      file: { data: Buffer.from('anonymous'), mimetype: 'text/plain', name: 'anonymous.txt', size: 9 },
      overrideAccess: true,
    })

    await payload.create({
      collection: 'simple',
      data: { image: shared.id, title: 'hidden from the user' },
      overrideAccess: true,
    })

    const error = await payload
      .delete({ collection: 'media', id: shared.id, overrideAccess: true, req: { payloadAPI: 'REST' } })
      .catch((caught: unknown) => caught)

    expect(String(error)).toMatch(/still used/)
    expect(String(error)).not.toMatch(/hidden from the user/)
  })

  it('titles a place with what anyone may read on a delete from outside without a user', async () => {
    const shared = await payload.create({
      collection: 'media',
      data: { alt: 'titled' },
      file: { data: Buffer.from('titled'), mimetype: 'text/plain', name: 'titled.txt', size: 6 },
      overrideAccess: true,
    })

    await payload.create({
      collection: 'notices' as 'media',
      data: { image: shared.id, title: 'title for users only' } as never,
      overrideAccess: true,
    })

    const error = await payload
      .delete({ collection: 'media', id: shared.id, overrideAccess: true, req: { payloadAPI: 'REST' } })
      .catch((caught: unknown) => caught)

    expect(String(error)).toMatch(/still used/)
    expect(String(error)).not.toMatch(/title for users only/)
  })

  it('lets an unreferenced upload go', async () => {
    const loose = await payload.create({
      collection: 'files' as 'media',
      data: { title: 'loose' },
      file: { data: Buffer.from('loose'), mimetype: 'text/plain', name: 'loose.txt', size: 5 },
      overrideAccess: true,
    })

    await payload.delete({ collection: 'files' as 'media', id: loose.id, overrideAccess: true })

    const left = await payload.find({
      collection: 'files' as 'media',
      where: { id: { equals: loose.id } },
      overrideAccess: true,
    })

    expect(left.docs).toHaveLength(0)
  })
})

describe(`trash on ${label}`, () => {
  it('moves an approved upload to the trash instead of deleting it', async () => {
    const finding = (await findings({ collectionSlug: { equals: 'files' }, kind: { equals: 'unused' } })).docs[0]!

    await payload.update({
      collection: options.findingsSlug as 'media',
      data: { status: 'delete' } as never,
      id: finding.id,
      overrideAccess: true,
    })

    const report = await purgeApproved(payload, options)

    expect(report.deleted).toBe(1)

    const spare = await payload.findByID({
      collection: 'files' as 'media',
      id: seeded.fileIds.spare,
      trash: true,
      overrideAccess: true,
    })

    expect((spare as unknown as { deletedAt?: string }).deletedAt).toBeTruthy()
    expect(storage.objects.has(`files/${filenameOf('spare')}`)).toBe(true)
  })

  it('does not report a trashed upload again', async () => {
    const report = await scanStorage(payload, options)

    expect(report.byCollection.files?.unused).toBe(0)
    expect(report.byCollection.files?.orphans).toBe(0)
  })
})

describe(`queue on ${label}`, () => {
  it('stamps every finding with the run that last saw it', async () => {
    await runJanitor(payload, 'scan')

    const run = await payload.find({
      collection: options.runsSlug as 'media',
      depth: 0,
      limit: 1,
      sort: '-createdAt',
      overrideAccess: true,
    })
    const rows = await payload.find({
      collection: options.findingsSlug as 'media',
      depth: 0,
      limit: 100,
      where: { status: { equals: 'found' } },
      overrideAccess: true,
    })

    expect(rows.docs.length).toBeGreaterThan(0)
    for (const doc of rows.docs as unknown as { run?: number | string }[]) {
      expect(doc.run).toBe(run.docs[0]!.id)
    }
  })

  it('queues a run as a job and runs it off the request', async () => {
    const started = await startJanitor(payload, 'scan')

    expect(started.queued).toBe(true)
    expect(started.jobId).toBeDefined()

    const before = (await payload.count({ collection: options.runsSlug as 'media', overrideAccess: true })).totalDocs

    await payload.jobs.run({ overrideAccess: true })

    const after = await payload.find({
      collection: options.runsSlug as 'media',
      depth: 0,
      limit: 1,
      sort: '-createdAt',
      overrideAccess: true,
    })

    expect((await payload.count({ collection: options.runsSlug as 'media', overrideAccess: true })).totalDocs).toBe(
      before,
    )
    expect(after.docs[0] as unknown as { id: number | string; mode: string; status: string }).toMatchObject({
      id: started.runId,
      mode: 'scan',
      status: 'done',
    })
  })
})
