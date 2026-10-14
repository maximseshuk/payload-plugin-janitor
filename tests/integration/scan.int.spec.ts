import { cloudStoragePlugin } from '@payloadcms/plugin-cloud-storage'
import type { Adapter } from '@payloadcms/plugin-cloud-storage/types'
import { getFileKey } from '@payloadcms/plugin-cloud-storage/utilities'
import type { CollectionConfig, GlobalConfig, Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { janitor } from '@/index.js'
import { purgeApproved } from '@/server/purge.js'
import { runJanitor } from '@/server/run.js'
import { scanStorage } from '@/server/scan.js'
import { PLUGIN_NAME } from '@/shared/constants.js'
import type { Check } from '@/shared/types/options.js'
import type { ResolvedCollection, ResolvedOptions } from '@/shared/types/resolved.js'
import type { StorageAdapter } from '@/shared/types/storage.js'

import { boot } from '../helpers/boot.js'
import { memoryAdapter } from '../memoryAdapter.js'

const usageOff = vi.hoisted(() => ({ value: false }))
const indexing = vi.hoisted(() => ({
  value: undefined as undefined | { progress: () => Promise<void>; start: () => void },
}))

vi.mock('@/server/usage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/usage/index.js')>()

  return {
    ...actual,
    buildUsageIndex: (...[payload, args]: Parameters<typeof actual.buildUsageIndex>) => {
      if (usageOff.value) return Promise.resolve(null)

      const spy = indexing.value

      if (!spy) return actual.buildUsageIndex(payload, args)

      spy.start()

      return actual.buildUsageIndex(payload, {
        ...args,
        onProgress: async () => {
          await args.onProgress?.()
          await spy.progress()
        },
      })
    },
    findUsage: (...args: Parameters<typeof actual.findUsage>) =>
      usageOff.value ? Promise.resolve(null) : actual.findUsage(...args),
  }
})

type Finding = {
  collectionSlug: string
  documentId?: string
  id: number | string
  kind: string
  objectKey: string
  status: string
  usage?: { versions?: boolean }[]
}

type Doc = { deletedAt?: null | string; filename: string; id: number | string }

const label = `${process.env.TEST_DB ?? 'sqlite'}${process.env.BLOCKS_AS_JSON === '1' ? ' (blocks as json)' : ''}`

const shared = memoryAdapter()
const own = memoryAdapter(shared.objects)

const upload = { disableLocalStorage: true }

const collections: CollectionConfig[] = [
  { slug: 'users', auth: true, fields: [] },
  {
    slug: 'photos',
    fields: [{ name: 'alt', type: 'text' }],
    upload: { ...upload, imageSizes: [{ name: 'thumb', height: 10, width: 10 }] },
  },
  {
    slug: 'docs',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'stream', type: 'group', fields: [{ name: 'videoId', type: 'text' }] },
    ],
    upload,
  },
  { slug: 'assets', fields: [{ name: 'title', type: 'text' }], trash: true, upload },
  { slug: 'avatars', fields: [{ name: 'prefix', type: 'text', defaultValue: 'avatars' }], upload },
  {
    slug: 'sheets',
    fields: [{ name: 'title', type: 'text' }],
    upload: { ...upload, imageSizes: [{ name: 'thumb', height: 10, width: 10 }] },
    versions: { drafts: true },
  },
  { slug: 'tags', fields: [{ name: 'name', type: 'text' }] },
  {
    slug: 'codes',
    fields: [
      { name: 'id', type: 'text' },
      { name: 'name', type: 'text' },
    ],
  },
  { slug: 'categories', fields: [{ name: 'name', type: 'text' }], trash: true },
  {
    slug: 'posts',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'related', type: 'relationship', relationTo: ['photos', 'tags'] },
      { name: 'tag', type: 'relationship', relationTo: 'tags' },
    ],
  },
  {
    slug: 'pages',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'tag', type: 'relationship', relationTo: 'tags' },
    ],
    versions: { drafts: true },
  },
]

const globals: GlobalConfig[] = [
  { slug: 'site', fields: [{ name: 'featured', type: 'relationship', relationTo: 'tags' }] },
]

let payload: Payload
let options: ResolvedOptions
let teardown = async (): Promise<void> => {}

const withChecks = (checks: Record<string, Check[]>): ResolvedOptions => ({
  ...options,
  collections: options.collections.map((target) => ({ ...target, checks: checks[target.slug] ?? [] })),
})

const findings = async (): Promise<Finding[]> =>
  (await payload.find({ collection: options.findingsSlug as never, depth: 0, pagination: false, overrideAccess: true }))
    .docs as unknown as Finding[]

const findingOf = async (collectionSlug: string, objectKey: string): Promise<Finding | undefined> =>
  (await findings()).find((item) => item.collectionSlug === collectionSlug && item.objectKey === objectKey)

const approve = (finding: Finding) =>
  payload.update({
    collection: options.findingsSlug as never,
    data: { status: 'delete' } as never,
    id: finding.id,
    overrideAccess: true,
  })

const decide = (finding: Finding, status: string) =>
  payload.update({
    collection: options.findingsSlug as never,
    data: { status } as never,
    id: finding.id,
    overrideAccess: true,
  })

const create = async (collection: string, data: Record<string, unknown>): Promise<Doc> =>
  (await payload.create({
    collection: collection as never,
    data: data as never,
    overrideAccess: true,
  })) as unknown as Doc

const fileOf = (name: string) => ({ data: Buffer.from(name), mimetype: 'text/plain', name, size: name.length })

const thumbOf = (name: string) => ({ thumb: { filename: `${name}-10x10.txt` } })

const file = async (collection: string, name: string, data: Record<string, unknown> = {}): Promise<Doc> =>
  (await payload.create({
    collection: collection as never,
    data: data as never,
    file: fileOf(name),
    overrideAccess: true,
  })) as unknown as Doc

const draftFile = (collection: string, id: number | string, name: string) =>
  payload.update({
    collection: collection as never,
    data: {} as never,
    draft: true,
    file: fileOf(name),
    id,
    overrideAccess: true,
  })

const withStorage = (slugs: string[], storage: StorageAdapter | undefined): ResolvedOptions => ({
  ...options,
  collections: options.collections.map((target): ResolvedCollection =>
    slugs.includes(target.slug) ? { ...target, storage } : target,
  ),
})

const noteOf = async (collectionSlug: string, objectKey: string) =>
  (await findingOf(collectionSlug, objectKey)) as (Finding & { note?: null | string; run?: unknown }) | undefined

const later = () => new Promise((resolve) => setTimeout(resolve, 20))

const reread = async (collection: string, id: number | string): Promise<Doc | undefined> =>
  (
    await payload.find({
      collection: collection as never,
      depth: 0,
      trash: true,
      where: { id: { equals: id } },
      overrideAccess: true,
    })
  ).docs[0] as unknown as Doc | undefined

beforeAll(async () => {
  ;({ payload, teardown } = await boot({
    collections,
    globals,
    plugins: [
      janitor({
        collections: {
          photos: true,
          docs: true,
          assets: { prefix: 'assets', storage: own },
          categories: true,
          sheets: true,
          tags: true,
          codes: true,
        },
        minAge: 0,
        storage: shared,
      }),
    ],
  }))

  options = (payload.config.custom as Record<string, ResolvedOptions>)[PLUGIN_NAME]!
})

afterAll(async () => {
  await teardown()
})

beforeEach(async () => {
  usageOff.value = false
  await payload.updateGlobal({ data: { featured: null } as never, slug: 'site' as never, overrideAccess: true })

  const slugs = ['posts', 'pages', 'tags', 'codes', 'categories', 'photos', 'docs', 'assets', 'avatars', 'sheets']

  for (const slug of [...slugs, options.findingsSlug]) {
    await payload.delete({ collection: slug as never, trash: true, where: {}, overrideAccess: true })
  }

  for (const adapter of [shared, own]) {
    adapter.objects.clear()
    adapter.deletes.length = 0
    adapter.lists.length = 0
  }
})

describe(`scan of ordinary collections on ${label}`, () => {
  it('never lists or deletes storage for a non-upload collection', async () => {
    const tag = await create('tags', { name: 'loose' })

    await scanStorage(payload, withChecks({ categories: ['unused'], tags: ['unused'] }))

    const finding = await findingOf('tags', `tags/${tag.id}`)

    expect(finding).toMatchObject({ documentId: String(tag.id), kind: 'unused' })

    await approve(finding!)
    const report = await purgeApproved(payload, options)

    expect(report.deleted).toBe(1)
    expect(await reread('tags', tag.id)).toBeUndefined()
    expect([...shared.lists, ...own.lists]).toEqual([])
    expect([...shared.deletes, ...own.deletes]).toEqual([])
  })

  it('does not report a tag referenced through a polymorphic relationship', async () => {
    const used = await create('tags', { name: 'used' })
    const loose = await create('tags', { name: 'loose' })

    await create('posts', { related: { relationTo: 'tags', value: used.id }, title: 'post' })
    await scanStorage(payload, options)

    expect(await findingOf('tags', `tags/${used.id}`)).toBeUndefined()
    expect(await findingOf('tags', `tags/${loose.id}`)).toBeDefined()
  })

  it('does not report a tag referenced from a global', async () => {
    const featured = await create('tags', { name: 'featured' })

    await payload.updateGlobal({
      data: { featured: featured.id } as never,
      slug: 'site' as never,
      overrideAccess: true,
    })
    await scanStorage(payload, options)

    expect(await findingOf('tags', `tags/${featured.id}`)).toBeUndefined()
  })

  it('does not report a young document or a young missing upload', async () => {
    const tag = await create('tags', { name: 'young' })
    const photo = await file('photos', 'young.txt')
    const patient = { ...options, minAge: 86_400 }

    const young = await scanStorage(payload, patient)

    expect([young.unused, young.missing]).toEqual([0, 0])
    expect(await findings()).toEqual([])

    await scanStorage(payload, options)

    expect(await findingOf('tags', `tags/${tag.id}`)).toBeDefined()
    expect(await findingOf('photos', 'young.txt')).toMatchObject({ documentId: String(photo.id), kind: 'missing' })
  })

  it('records when the document of a missing file was created', async () => {
    const photo = (await file('photos', 'vanished.txt')) as Doc & { createdAt: string }

    await scanStorage(payload, options)

    const finding = (await findingOf('photos', 'vanished.txt')) as Finding & { uploadedAt?: string }

    expect(finding.kind).toBe('missing')
    expect(new Date(finding.uploadedAt ?? 0).getTime()).toBe(new Date(photo.createdAt).getTime())
  })

  it('keeps a document that was referenced again between approval and purge', async () => {
    const tag = await create('tags', { name: 'again' })

    await scanStorage(payload, options)
    await approve((await findingOf('tags', `tags/${tag.id}`))!)
    await create('posts', { tag: tag.id, title: 'late' })

    const report = await purgeApproved(payload, options)

    expect(report.deleted).toBe(0)
    expect((await findingOf('tags', `tags/${tag.id}`))?.status).toBe('keep')
    expect(await reread('tags', tag.id)).toBeDefined()
  })

  it('moves a document of a trash collection to the trash', async () => {
    const category = await create('categories', { name: 'bin' })

    await scanStorage(payload, options)
    await approve((await findingOf('categories', `categories/${category.id}`))!)

    const report = await purgeApproved(payload, options)

    expect(report.deleted).toBe(1)
    expect((await reread('categories', category.id))?.deletedAt).toBeTruthy()
    expect((await findingOf('categories', `categories/${category.id}`))?.status).toBe('deleted')
  })

  it('skips a document already in the trash instead of deleting it for good', async () => {
    const category = await create('categories', { name: 'binned' })

    await scanStorage(payload, options)
    await approve((await findingOf('categories', `categories/${category.id}`))!)
    await payload.update({
      collection: 'categories' as never,
      data: { deletedAt: new Date().toISOString() } as never,
      id: category.id,
      overrideAccess: true,
    })

    const hard = {
      ...options,
      collections: options.collections.map((target) => ({ ...target, trash: false })),
    }
    const report = await purgeApproved(payload, hard)

    expect(report.deleted).toBe(0)
    expect(report.skipped).toHaveLength(1)
    expect(await reread('categories', category.id)).toBeDefined()
  })

  it('reports a version-only reference only when versions count as unused', async () => {
    const tag = await create('tags', { name: 'drafted' })
    const page = await create('pages', { _status: 'published', title: 'page' })

    await payload.update({
      collection: 'pages' as never,
      data: { tag: tag.id } as never,
      draft: true,
      id: page.id,
      overrideAccess: true,
    })
    await payload.update({
      collection: 'pages' as never,
      data: { title: 'moved on' } as never,
      draft: true,
      id: page.id,
      overrideAccess: true,
    })
    await payload.update({
      collection: 'pages' as never,
      data: { _status: 'published', tag: null } as never,
      id: page.id,
      overrideAccess: true,
    })

    await scanStorage(payload, options)

    expect(await findingOf('tags', `tags/${tag.id}`)).toBeUndefined()

    const loose = { ...options, references: { ...options.references, versions: 'unused' as const } }

    await scanStorage(payload, loose)

    const finding = await findingOf('tags', `tags/${tag.id}`)

    expect(finding?.kind).toBe('unused')
    expect(finding?.usage?.length).toBeGreaterThan(0)
    expect(finding?.usage?.every((ref) => ref.versions)).toBe(true)

    await expect(payload.delete({ collection: 'tags' as never, id: tag.id, overrideAccess: true })).rejects.toThrow()

    await approve(finding!)
    const report = await purgeApproved(payload, loose)

    expect(report).toMatchObject({ deleted: 1, failed: [] })
    expect(await reread('tags', tag.id)).toBeUndefined()
  })
})

describe(`scan of upload collections on ${label}`, () => {
  it('writes only orphans when the report asks for orphans', async () => {
    await file('photos', 'loose.txt')
    await file('photos', 'gone.txt')
    shared.put('loose.txt')
    shared.put('stray.txt')

    const report = await scanStorage(payload, withChecks({ photos: ['orphans'] }))

    expect([report.orphans, report.missing, report.unused]).toEqual([1, 0, 0])
    expect((await findings()).map((item) => [item.kind, item.objectKey])).toEqual([['orphan', 'stray.txt']])
  })

  it('knows image size files, and purge refuses to delete one', async () => {
    const photo = await file('photos', 'big.txt')

    await payload.update({
      collection: 'photos' as never,
      data: { sizes: { thumb: { filename: 'big-10x10.txt' } } } as never,
      id: photo.id,
      overrideAccess: true,
    })
    shared.put('big.txt')
    shared.put('big-10x10.txt')
    shared.put('late-10x10.txt')

    await scanStorage(payload, options)

    expect(await findingOf('photos', 'big-10x10.txt')).toBeUndefined()

    const orphan = (await findingOf('photos', 'late-10x10.txt'))!

    expect(orphan.kind).toBe('orphan')

    await approve(orphan)
    const late = await file('photos', 'late.txt')

    await payload.update({
      collection: 'photos' as never,
      data: { sizes: { thumb: { filename: 'late-10x10.txt' } } } as never,
      id: late.id,
      overrideAccess: true,
    })

    const report = await purgeApproved(payload, options)

    expect(report.deleted).toBe(0)
    expect(shared.objects.has('late-10x10.txt')).toBe(true)
    expect((await findingOf('photos', 'late-10x10.txt'))?.status).toBe('keep')
  })

  it('does not read one collection as the orphans of another on a shared scope', async () => {
    await file('photos', 'same.txt')
    await file('docs', 'same.txt')
    await file('docs', 'manual.txt')
    shared.put('same.txt')
    shared.put('manual.txt')
    shared.put('stray.txt')

    const report = await scanStorage(payload, options)

    expect(report.orphans).toBe(1)
    expect(await findingOf('photos', 'stray.txt')).toMatchObject({ kind: 'orphan' })

    const unused = (await findings()).filter((item) => item.kind === 'unused')

    expect(unused.map((item) => `${item.collectionSlug}:${item.objectKey}`).toSorted()).toEqual([
      'docs:manual.txt',
      'docs:same.txt',
      'photos:same.txt',
    ])

    await scanStorage(payload, options)

    expect((await findings()).map((item) => item.id).toSorted()).toEqual(
      [...unused.map((item) => item.id), (await findingOf('photos', 'stray.txt'))!.id].toSorted(),
    )
  })

  it('reports no missing file for a document whose storage marks it external, and still finds it unused', async () => {
    const streamed = await file('docs', 'video.txt', { stream: { videoId: 'v1' } })
    const lost = await file('docs', 'lost.txt')

    const report = await scanStorage(
      payload,
      withStorage(['docs'], memoryAdapter(shared.objects, { external: 'stream.videoId' })),
    )

    expect(report.missing).toBe(1)
    expect(await findingOf('docs', streamed.filename)).toMatchObject({ kind: 'unused' })
    expect(await findingOf('docs', lost.filename)).toMatchObject({ kind: 'missing' })
  })
})

describe(`decisions on ${label}`, () => {
  it('keeps a decision through a scan that skipped the collection', async () => {
    const kept = await create('tags', { name: 'kept' })
    const doomed = await create('tags', { name: 'doomed' })

    await scanStorage(payload, options)
    await decide((await findingOf('tags', `tags/${kept.id}`))!, 'keep')
    await approve((await findingOf('tags', `tags/${doomed.id}`))!)

    await scanStorage(payload, withChecks({ categories: ['unused'] }))

    expect((await findingOf('tags', `tags/${kept.id}`))?.status).toBe('keep')

    await create('posts', { tag: doomed.id, title: 'saves it' })
    await scanStorage(payload, options)

    expect((await findingOf('tags', `tags/${doomed.id}`))?.status).toBe('delete')
  })
})

describe(`full keys on a shared bucket on ${label}`, () => {
  const orphans = async () =>
    (await findings())
      .filter((item) => item.kind === 'orphan')
      .map((item) => `${item.collectionSlug}:${item.objectKey}`)

  it('knows the files of another adapter object on the same bucket by their full key', async () => {
    await file('assets', 'kept.txt')
    shared.put('assets/kept.txt')
    shared.put('assets/stray.txt')

    await scanStorage(payload, options)

    expect((await orphans()).toSorted()).toEqual(['assets:assets/stray.txt', 'photos:assets/stray.txt'])
  })

  it('knows the files of an unlisted upload collection, under its own or a per-document prefix', async () => {
    await file('avatars', 'face.txt')
    await file('avatars', 'old.txt', { prefix: '/legacy/' })
    shared.put('avatars/face.txt')
    shared.put('legacy/old.txt')
    shared.put('face.txt')

    await scanStorage(payload, options)

    expect(await orphans()).toEqual(['photos:face.txt'])
  })

  it('keeps an approved orphan once another collection holds its full key', async () => {
    shared.put('assets/late.txt')
    await scanStorage(payload, options)
    await approve((await findingOf('photos', 'assets/late.txt'))!)
    await file('assets', 'late.txt')

    const report = await purgeApproved(payload, options)

    expect(report.deleted).toBe(0)
    expect(shared.objects.has('assets/late.txt')).toBe(true)
    expect((await findingOf('photos', 'assets/late.txt'))?.status).toBe('keep')
  })

  it('keeps an approved orphan whose key lies outside the collection prefix', async () => {
    shared.put('outside.txt')

    await payload.create({
      collection: options.findingsSlug as never,
      data: { collectionSlug: 'assets', kind: 'orphan', objectKey: 'outside.txt', status: 'delete' } as never,
      overrideAccess: true,
    })

    shared.put('assets/stray.txt')
    await scanStorage(payload, options)
    await approve((await findingOf('assets', 'assets/stray.txt'))!)

    const strict = memoryAdapter(shared.objects, {
      list: (args) => {
        if (args.keys?.some((key) => !key.startsWith(`${args.prefix}/`))) throw new Error('outside the directory')

        return own.list(args)
      },
    })
    const report = await purgeApproved(payload, withStorage(['assets'], strict))

    expect(report).toMatchObject({ deleted: 1, failed: [] })
    expect(report.skipped).toEqual([{ key: 'outside.txt', reason: 'the key is outside the collection prefix' }])
    expect(shared.objects.has('outside.txt')).toBe(true)
    expect(shared.objects.has('assets/stray.txt')).toBe(false)
  })

  it('reports no missing file for a document stored outside the collection prefix', async () => {
    const avatars: ResolvedCollection = {
      ...options.collections.find((target) => target.slug === 'photos')!,
      checks: ['missing'],
      prefix: 'avatars',
      slug: 'avatars',
    }

    await file('avatars', 'away.txt', { prefix: 'elsewhere' })
    shared.put('elsewhere/away.txt')

    const report = await scanStorage(payload, { ...options, collections: [avatars] })

    expect(report.missing).toBe(0)
    expect(await findings()).toEqual([])
  })

  it('keeps an unused document whose file another document also holds', async () => {
    await file('photos', 'twin.txt')
    const twin = await file('docs', 'twin.txt')

    shared.put('twin.txt')
    await scanStorage(payload, options)
    await approve((await findingOf('docs', 'twin.txt'))!)

    const report = await purgeApproved(payload, options)

    expect(report.skipped).toEqual([{ key: 'twin.txt', reason: 'another document holds the same file' }])
    expect(await reread('docs', twin.id)).toBeDefined()
  })

  it('counts an object once when two collections list the same scope', async () => {
    shared.put('one.txt')

    const report = await scanStorage(payload, withChecks({ docs: ['orphans'], photos: ['orphans'] }))

    expect([report.scanned, report.orphans]).toEqual([1, 1])
  })
})

describe(`draft uploads on ${label}`, () => {
  it('knows a file uploaded as a draft over a published document', async () => {
    const sheet = await file('sheets', 'live.txt', { _status: 'published' })

    await draftFile('sheets', sheet.id, 'draft.txt')
    shared.put('live.txt')
    shared.put('draft.txt')

    expect((await reread('sheets', sheet.id)) as unknown as { filename: string }).toMatchObject({
      filename: 'live.txt',
    })

    await scanStorage(payload, options)

    expect((await findings()).filter((item) => item.kind === 'orphan')).toEqual([])
  })

  it('keeps an approved orphan once a draft holds it', async () => {
    const sheet = await file('sheets', 'live.txt', { _status: 'published' })

    shared.put('live.txt')
    shared.put('later.txt')
    await scanStorage(payload, options)
    await approve((await findingOf('photos', 'later.txt'))!)
    await draftFile('sheets', sheet.id, 'later.txt')

    const report = await purgeApproved(payload, options)

    expect(report.deleted).toBe(0)
    expect(shared.objects.has('later.txt')).toBe(true)
  })

  it('finds nothing for the image sizes of draft images', async () => {
    await payload.create({
      collection: 'sheets' as never,
      data: { sizes: thumbOf('draft-only') } as never,
      draft: true,
      file: fileOf('draft-only.txt'),
      overrideAccess: true,
    })

    const sheet = await file('sheets', 'live.txt', { _status: 'published', sizes: thumbOf('live') })

    await payload.update({
      collection: 'sheets' as never,
      data: { sizes: thumbOf('later') } as never,
      draft: true,
      file: fileOf('later.txt'),
      id: sheet.id,
      overrideAccess: true,
    })

    const names = ['draft-only', 'live', 'later'].flatMap((name) => [`${name}.txt`, `${name}-10x10.txt`])

    for (const name of names) shared.put(name)
    shared.put('stray-10x10.txt')

    await scanStorage(payload, options)

    expect((await findings()).filter((item) => item.kind === 'orphan').map((item) => item.objectKey)).toEqual([
      'stray-10x10.txt',
    ])
  })

  it('keeps an approved orphan image size once only a draft holds it', async () => {
    const sheet = await file('sheets', 'live.txt', { _status: 'published', sizes: thumbOf('live') })

    shared.put('live.txt')
    shared.put('live-10x10.txt')
    shared.put('late-10x10.txt')
    await scanStorage(payload, options)

    const orphan = (await findings()).find((item) => item.objectKey === 'late-10x10.txt')!

    expect(orphan.kind).toBe('orphan')

    await approve(orphan)
    await payload.update({
      collection: 'sheets' as never,
      data: { sizes: thumbOf('late') } as never,
      draft: true,
      file: fileOf('late.txt'),
      id: sheet.id,
      overrideAccess: true,
    })

    expect(await reread('sheets', sheet.id)).toMatchObject({ filename: 'live.txt' })

    const report = await purgeApproved(payload, options)

    expect(report.deleted).toBe(0)
    expect(shared.objects.has('late-10x10.txt')).toBe(true)
  })
})

describe(`rescans and approvals on ${label}`, () => {
  it('resets an approved finding whose key now belongs to another document', async () => {
    const first = await file('photos', 'reuse.txt')

    await file('photos', 'keeps-ids-apart.txt')
    shared.put('reuse.txt')
    await scanStorage(payload, options)
    await payload.update({
      collection: options.findingsSlug as never,
      data: { note: 'checked by hand', status: 'delete' } as never,
      id: (await findingOf('photos', 'reuse.txt'))!.id,
      overrideAccess: true,
    })
    await payload.delete({ collection: 'photos' as never, id: first.id, overrideAccess: true })

    const second = await file('photos', 'reuse.txt')

    await scanStorage(payload, options)

    expect(await noteOf('photos', 'reuse.txt')).toMatchObject({
      documentId: String(second.id),
      note: 'checked by hand',
      status: 'found',
    })

    const report = await purgeApproved(payload, options)

    expect(report.deleted).toBe(0)
    expect(await reread('photos', second.id)).toBeDefined()
  })

  it('keeps a kept finding that a scan no longer sees', async () => {
    const tag = await create('tags', { name: 'kept' })

    await scanStorage(payload, options)
    await decide((await findingOf('tags', `tags/${tag.id}`))!, 'keep')
    await create('posts', { tag: tag.id, title: 'uses it' })
    await scanStorage(payload, options)

    expect((await findingOf('tags', `tags/${tag.id}`))?.status).toBe('keep')
  })

  it('keeps an approved missing finding, since there is nothing to delete', async () => {
    const photo = await file('photos', 'absent.txt')

    await scanStorage(payload, options)
    await approve((await findingOf('photos', 'absent.txt'))!)

    const report = await purgeApproved(payload, options)

    expect(report.skipped).toEqual([{ key: 'absent.txt', reason: 'a missing file has nothing to delete' }])
    expect((await findingOf('photos', 'absent.txt'))?.status).toBe('keep')
    expect(await reread('photos', photo.id)).toBeDefined()
  })

  it('keeps the decision on a finding of a collection that is no longer watched, with the reason', async () => {
    const tag = await create('tags', { name: 'unlisted' })

    await scanStorage(payload, options)
    await approve((await findingOf('tags', `tags/${tag.id}`))!)

    const unwatched = { ...options, collections: options.collections.filter((target) => target.slug !== 'tags') }
    const report = await purgeApproved(payload, unwatched)
    const finding = (await findings()).find((item) => item.objectKey === `tags/${tag.id}`) as Finding & {
      note?: string
    }

    expect(report.skipped).toEqual([{ key: `tags/${tag.id}`, reason: 'collection is not watched' }])
    expect([finding.status, finding.note]).toEqual(['delete', 'collection is not watched'])
    expect(await reread('tags', tag.id)).toBeDefined()
  })

  it("keeps the admin's note and adds the reason once when purge skips a finding", async () => {
    const tag = await create('tags', { name: 'unlisted' })

    await scanStorage(payload, options)
    await payload.update({
      collection: options.findingsSlug as never,
      data: { note: 'checked by hand', status: 'delete' } as never,
      id: (await findingOf('tags', `tags/${tag.id}`))!.id,
      overrideAccess: true,
    })

    const unwatched = { ...options, collections: options.collections.filter((target) => target.slug !== 'tags') }

    await purgeApproved(payload, unwatched)
    await purgeApproved(payload, unwatched)

    expect(await noteOf('tags', `tags/${tag.id}`)).toMatchObject({
      note: 'checked by hand\ncollection is not watched',
      status: 'delete',
    })
  })

  it('frees no bytes when purge moves an upload to the trash', async () => {
    await file('assets', 'bin.txt')
    shared.put('assets/bin.txt')
    await scanStorage(payload, options)
    await approve((await findingOf('assets', 'assets/bin.txt'))!)

    const report = await purgeApproved(payload, options)

    expect([report.deleted, report.freedBytes]).toEqual([1, 0])
  })
})

describe(`purge re-checks on ${label}`, () => {
  const newer = 'the document is not the one the scan found: its id now belongs to a newer document'

  it('keeps an approved finding whose custom id now belongs to a newer document', async () => {
    await create('codes', { id: 'reused', name: 'first' })
    await scanStorage(payload, options)
    await approve((await findingOf('codes', 'codes/reused'))!)
    await payload.delete({ collection: 'codes' as never, id: 'reused', overrideAccess: true })
    await later()
    await create('codes', { id: 'reused', name: 'second' })

    const report = await purgeApproved(payload, options)

    expect(report.skipped).toEqual([{ key: 'codes/reused', reason: newer }])
    expect(await reread('codes', 'reused')).toBeDefined()
    expect((await findingOf('codes', 'codes/reused'))?.status).toBe('keep')
  })

  it('keeps an approved finding whose numeric id the database handed out again', async () => {
    await create('tags', { name: 'keeps ids apart' })
    const first = await create('tags', { name: 'first' })

    await scanStorage(payload, options)
    await approve((await findingOf('tags', `tags/${first.id}`))!)
    await payload.delete({ collection: 'tags' as never, id: first.id, overrideAccess: true })
    await later()

    const second = await create('tags', { name: 'second' })

    if ((process.env.TEST_DB ?? 'sqlite') === 'sqlite') expect(second.id).toBe(first.id)

    const report = await purgeApproved(payload, options)

    expect(report.deleted).toBe(0)
    expect(await reread('tags', second.id)).toBeDefined()
    expect((await findingOf('tags', `tags/${first.id}`))?.status).toBe('keep')
  })

  it('keeps an approved document that changed within minAge of the purge', async () => {
    const tag = await create('tags', { name: 'fresh' })

    await scanStorage(payload, options)
    await approve((await findingOf('tags', `tags/${tag.id}`))!)

    const report = await purgeApproved(payload, { ...options, minAge: 86_400 })

    expect(report.skipped).toEqual([{ key: `tags/${tag.id}`, reason: 'the document changed recently' }])
    expect(await reread('tags', tag.id)).toBeDefined()
  })

  it('keeps an approved document when usage cannot be read', async () => {
    const tag = await create('tags', { name: 'unknown' })

    await scanStorage(payload, options)
    await approve((await findingOf('tags', `tags/${tag.id}`))!)
    usageOff.value = true

    const report = await purgeApproved(payload, options)

    expect(report.skipped).toEqual([
      { key: `tags/${tag.id}`, reason: 'usage detection is not available for this database' },
    ])
    expect(await reread('tags', tag.id)).toBeDefined()
  })

  it('writes no unused finding and drops none when the usage index cannot be built', async () => {
    const tag = await create('tags', { name: 'unknown' })

    await scanStorage(payload, options)
    await payload.delete({ collection: 'tags' as never, id: tag.id, overrideAccess: true })
    await create('tags', { name: 'another' })
    usageOff.value = true

    const warn = vi.spyOn(payload.logger, 'warn')
    const report = await scanStorage(payload, withChecks({ tags: ['unused'] }))

    expect(report.unused).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('usage of "tags" could not be read reliably'))
    expect(await findingOf('tags', `tags/${tag.id}`)).toBeDefined()
    warn.mockRestore()
  })

  it('leaves an approved orphan of a collection without storage waiting', async () => {
    shared.put('stray.txt')
    await scanStorage(payload, options)
    await approve((await findingOf('photos', 'stray.txt'))!)

    const report = await purgeApproved(payload, withStorage(['photos'], undefined))

    expect(report.skipped).toEqual([{ key: 'stray.txt', reason: 'no storage adapter configured' }])
    expect((await findingOf('photos', 'stray.txt'))?.status).toBe('delete')
    expect(shared.objects.has('stray.txt')).toBe(true)
  })

  it('reports a storage delete that throws and leaves the finding approved, with the error in error', async () => {
    const denying = memoryAdapter(shared.objects, {
      delete: async () => {
        throw new Error('denied')
      },
    })

    shared.put('stray.txt')
    await scanStorage(payload, options)
    await approve((await findingOf('photos', 'stray.txt'))!)

    const report = await purgeApproved(payload, withStorage(['photos', 'docs', 'sheets'], denying))

    expect(report).toMatchObject({ deleted: 0, failed: [{ error: 'denied', key: 'stray.txt' }] })
    expect(await noteOf('photos', 'stray.txt')).toMatchObject({ error: 'denied', status: 'delete' })
    expect((await noteOf('photos', 'stray.txt'))?.note ?? null).toBeNull()
    expect(shared.objects.has('stray.txt')).toBe(true)

    await purgeApproved(payload, options)

    expect(await noteOf('photos', 'stray.txt')).toMatchObject({ error: null, status: 'deleted' })
  })

  it("keeps the admin's note when a delete fails or succeeds", async () => {
    const denying = memoryAdapter(shared.objects, {
      delete: async () => {
        throw new Error('denied')
      },
    })

    shared.put('stray.txt')
    await scanStorage(payload, options)
    await payload.update({
      collection: options.findingsSlug as never,
      data: { note: 'old banner, checked by hand', status: 'delete' } as never,
      id: (await findingOf('photos', 'stray.txt'))!.id,
      overrideAccess: true,
    })

    const report = await purgeApproved(payload, withStorage(['photos', 'docs', 'sheets'], denying))

    expect(report.failed).toEqual([{ error: 'denied', key: 'stray.txt' }])
    expect(await noteOf('photos', 'stray.txt')).toMatchObject({
      note: 'old banner, checked by hand',
      error: 'denied',
      status: 'delete',
    })

    await purgeApproved(payload, options)

    expect(await noteOf('photos', 'stray.txt')).toMatchObject({
      note: 'old banner, checked by hand',
      status: 'deleted',
    })
  })

  it('reopens a deleted finding when a scan sees its object again', async () => {
    shared.put('stray.txt')
    await scanStorage(payload, options)
    await approve((await findingOf('photos', 'stray.txt'))!)
    await runJanitor(payload, 'purge')

    expect(await findingOf('photos', 'stray.txt')).toMatchObject({ status: 'deleted' })

    await payload.update({
      collection: options.findingsSlug as never,
      data: { error: 'stale' } as never,
      id: (await findingOf('photos', 'stray.txt'))!.id,
      overrideAccess: true,
    })
    shared.put('stray.txt')
    await scanStorage(payload, options)

    expect(await findingOf('photos', 'stray.txt')).toMatchObject({
      error: null,
      purgedAt: null,
      purgedBy: null,
      status: 'found',
    })
  })

  it('marks an approved orphan deleted when the object is already gone', async () => {
    shared.put('stray.txt')
    await scanStorage(payload, options)
    await approve((await findingOf('photos', 'stray.txt'))!)
    shared.objects.delete('stray.txt')

    const report = await purgeApproved(payload, options)

    expect(report).toMatchObject({ deleted: 1, failed: [], freedBytes: 0, skipped: [] })
    expect(await noteOf('photos', 'stray.txt')).toMatchObject({
      note: 'the object was already gone',
      status: 'deleted',
    })
    expect(shared.deletes).toEqual([])
  })

  it('keeps an approved orphan that was written again within minAge', async () => {
    shared.put('stray.txt')
    await scanStorage(payload, options)
    await approve((await findingOf('photos', 'stray.txt'))!)
    shared.put('stray.txt', { lastModified: new Date() })

    const report = await purgeApproved(payload, { ...options, minAge: 3600 })

    expect(report.skipped).toEqual([{ key: 'stray.txt', reason: 'the object was written again recently' }])
    expect(shared.objects.has('stray.txt')).toBe(true)
  })

  it('looks each orphan up again right before deleting it, so a rewrite during the purge keeps it', async () => {
    const racing = memoryAdapter(shared.objects, {
      delete: async ({ key }) => {
        shared.objects.delete(key)
        if (key === 'a.txt') shared.put('b.txt', { lastModified: new Date() })
      },
    })

    shared.put('a.txt')
    shared.put('b.txt')
    await scanStorage(payload, options)
    await approve((await findingOf('photos', 'a.txt'))!)
    await approve((await findingOf('photos', 'b.txt'))!)

    const report = await purgeApproved(payload, {
      ...withStorage(['photos', 'docs', 'sheets'], racing),
      minAge: 3600,
    })

    expect(report.skipped).toEqual([{ key: 'b.txt', reason: 'the object was written again recently' }])
    expect([shared.objects.has('a.txt'), shared.objects.has('b.txt')]).toEqual([false, true])
  })

  it('asks storage for the approved keys only', async () => {
    shared.put('stray.txt')
    shared.put('other.txt')
    await scanStorage(payload, options)
    await approve((await findingOf('photos', 'stray.txt'))!)
    shared.lists.length = 0

    await purgeApproved(payload, options)

    expect(shared.lists).toEqual([{ collection: 'photos', keys: ['stray.txt'], prefix: '' }])
    expect([...shared.objects.keys()]).toEqual(['other.txt'])
  })

  it('tags every finding a purge run touched with that run, and keeps the scan that found it', async () => {
    const doomed = await create('tags', { name: 'doomed' })
    const saved = await create('tags', { name: 'saved' })

    const latest = async () =>
      (
        await payload.find({
          collection: options.runsSlug as never,
          limit: 1,
          sort: '-startedAt',
          overrideAccess: true,
        })
      ).docs[0] as unknown as { id: number | string }

    await runJanitor(payload, 'scan')

    const scan = await latest()

    await approve((await findingOf('tags', `tags/${doomed.id}`))!)
    await approve((await findingOf('tags', `tags/${saved.id}`))!)
    await create('posts', { tag: saved.id, title: 'saves it' })
    await later()
    await runJanitor(payload, 'purge')

    const purge = await latest()
    const idOf = (value: unknown) => (value && typeof value === 'object' ? (value as { id: unknown }).id : value)
    const runsOf = async (key: string) => {
      const finding = (await noteOf('tags', key)) as Finding & { purgedBy?: unknown; run?: unknown }

      return [idOf(finding.run), idOf(finding.purgedBy)]
    }

    expect(purge.id).not.toEqual(scan.id)
    expect(await runsOf(`tags/${doomed.id}`)).toEqual([scan.id, purge.id])
    expect(await runsOf(`tags/${saved.id}`)).toEqual([scan.id, purge.id])
    expect((await noteOf('tags', `tags/${saved.id}`))?.note).toBe('the document is referenced again')
  })
})

describe(`heartbeat on ${label}`, () => {
  it('writes heartbeatAt while the usage index is being built', async () => {
    await create('tags', { name: 'idle' })

    const run = (await payload.create({
      collection: options.runsSlug as never,
      data: {
        heartbeatAt: new Date(0).toISOString(),
        mode: 'scan',
        startedAt: new Date().toISOString(),
        status: 'running',
      } as never,
      overrideAccess: true,
    })) as unknown as { id: number | string }
    const ahead = Date.now() + 5 * 60_000
    const seen: (null | string | undefined)[] = []
    const clock = vi.spyOn(Date, 'now')

    indexing.value = {
      progress: async () => {
        const doc = (await payload.findByID({
          collection: options.runsSlug as never,
          id: run.id,
          overrideAccess: true,
        })) as unknown as {
          heartbeatAt?: null | string
        }

        seen.push(doc.heartbeatAt)
      },
      start: () => {
        clock.mockReturnValue(ahead)
      },
    }

    try {
      await scanStorage(payload, withChecks({ tags: ['unused'] }), run.id)
    } finally {
      indexing.value = undefined
      clock.mockRestore()
      await payload.delete({ collection: options.runsSlug as never, id: run.id, overrideAccess: true })
    }

    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toBe(new Date(ahead).toISOString())
  })

  it('writes heartbeatAt while it purges approved findings', async () => {
    const tag = await create('tags', { name: 'loose' })

    await scanStorage(payload, withChecks({ tags: ['unused'] }))
    await approve((await findingOf('tags', `tags/${tag.id}`))!)

    const run = (await payload.create({
      collection: options.runsSlug as never,
      data: {
        heartbeatAt: new Date(0).toISOString(),
        mode: 'purge',
        startedAt: new Date().toISOString(),
        status: 'running',
      } as never,
      overrideAccess: true,
    })) as unknown as { id: number | string }
    const start = Date.now()
    const ahead = start + 5 * 60_000
    let calls = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (calls++ ? ahead : start))

    try {
      await purgeApproved(payload, options, run.id)
    } finally {
      clock.mockRestore()
    }

    const doc = (await payload.findByID({
      collection: options.runsSlug as never,
      id: run.id,
      overrideAccess: true,
    })) as unknown as { heartbeatAt?: null | string }

    await payload.delete({ collection: options.runsSlug as never, id: run.id, overrideAccess: true })

    expect(doc.heartbeatAt).toBe(new Date(ahead).toISOString())
  })
})

describe(`young objects on ${label}`, () => {
  it('writes no orphan for a young object and keeps its earlier finding', async () => {
    shared.put('stray.txt')
    shared.put('fresh.txt', { lastModified: new Date() })
    await scanStorage(payload, options)

    expect(await findingOf('photos', 'fresh.txt')).toMatchObject({ kind: 'orphan' })

    const report = await scanStorage(payload, { ...options, minAge: 3600 })

    expect(report.orphans).toBe(1)
    expect(await findingOf('photos', 'fresh.txt')).toMatchObject({ kind: 'orphan', status: 'found' })

    await payload.delete({ collection: options.findingsSlug as never, where: {}, overrideAccess: true })
    await scanStorage(payload, { ...options, minAge: 3600 })

    expect((await findings()).map((item) => item.objectKey)).toEqual(['stray.txt'])
  })
})

describe(`storage kept apart per collection on ${label}`, () => {
  it('lists, counts and purges each collection on its own when the adapter says so', async () => {
    const dirs: Record<string, ReturnType<typeof memoryAdapter>> = { docs: memoryAdapter(), photos: memoryAdapter() }
    const split: StorageAdapter = {
      delete: (args) => dirs[args.collection]!.delete(args),
      list: (args) => dirs[args.collection]!.list(args),
      perCollection: true,
    }
    const apart = withStorage(['photos', 'docs'], split)

    dirs.photos!.put('stray.txt')
    dirs.docs!.put('stray.txt')

    const report = await scanStorage(payload, {
      ...apart,
      collections: apart.collections.map((target) => ({
        ...target,
        checks: ['docs', 'photos'].includes(target.slug) ? (['orphans'] as Check[]) : [],
      })),
    })

    expect([report.scanned, report.orphans]).toEqual([2, 2])

    await approve((await findingOf('docs', 'stray.txt'))!)

    const purged = await purgeApproved(payload, apart)

    expect(purged.deleted).toBe(1)
    expect([dirs.docs!.objects.has('stray.txt'), dirs.photos!.objects.has('stray.txt')]).toEqual([false, true])
  })
})

describe(`storage plugin with composite prefixes and object keys on ${label}`, () => {
  const bucket = memoryAdapter()

  type Stored = { _objectKey?: null | string; prefix?: null | string }

  const keyFor = (prefix: string | undefined, doc: Stored, filename: string): string =>
    getFileKey({
      collectionPrefix: prefix,
      docPrefix: [doc.prefix, doc._objectKey].filter(Boolean).join('/'),
      filename,
      useCompositePrefixes: true,
    }).fileKey

  const memoryStorage: Adapter = ({ prefix }) => ({
    name: 'memory',
    handleDelete: ({ doc, filename, storageFilePath }) => {
      bucket.objects.delete(storageFilePath ?? keyFor(prefix, doc as Stored, filename))
    },
    handleUpload: ({ data, file: incoming, storageFilePath }) => {
      bucket.put(storageFilePath ?? keyFor(prefix, data as Stored, incoming.filename))
    },
    staticHandler: () => new Response(null, { status: 404 }),
  })

  let app: Payload
  let appOptions: ResolvedOptions
  let stop = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload: app, teardown: stop } = await boot({
      collections: [
        { slug: 'users', auth: true, fields: [] },
        {
          slug: 'media',
          fields: [{ name: '_objectKey', type: 'text' }],
          upload: { imageSizes: [{ name: 'thumb', height: 10, width: 10 }] },
        },
        { slug: 'notes', fields: [{ name: 'media', type: 'relationship', relationTo: 'media' }] },
      ],
      plugins: [
        cloudStoragePlugin({
          collections: { media: { adapter: memoryStorage, prefix: 'media' } },
          useCompositePrefixes: true,
        }),
        janitor({
          collections: { media: { compositePrefixes: true, prefix: 'media' } },
          minAge: 0,
          storage: bucket,
        }),
      ],
    }))

    appOptions = (app.config.custom as Record<string, ResolvedOptions>)[PLUGIN_NAME]!
  })

  afterAll(async () => {
    await stop()
  })

  const uploadMedia = async (name: string, data: Record<string, unknown> = {}): Promise<Doc> =>
    (await app.create({
      collection: 'media' as never,
      data: data as never,
      file: fileOf(name),
      overrideAccess: true,
      showHiddenFields: true,
    })) as unknown as Doc

  it('reads keys the storage plugin wrote, and purge deletes only what was approved', async () => {
    const held = await uploadMedia('a.txt', { prefix: 'user-1' })

    await app.update({
      collection: 'media' as never,
      data: { sizes: { thumb: { filename: 'a-10x10.txt' } } } as never,
      id: held.id,
      overrideAccess: true,
    })
    bucket.put('media/user-1/a-10x10.txt')

    const loose = await uploadMedia('b.txt', { _objectKey: 'k1' })
    const plain = await uploadMedia('c.txt')

    await app.create({ collection: 'notes' as never, data: { media: held.id } as never, overrideAccess: true })
    await app.create({ collection: 'notes' as never, data: { media: plain.id } as never, overrideAccess: true })
    bucket.put('media/b.txt')
    bucket.put('media/user-1/stray.txt')

    expect([...bucket.objects.keys()].toSorted()).toEqual([
      'media/b.txt',
      'media/c.txt',
      'media/k1/b.txt',
      'media/user-1/a-10x10.txt',
      'media/user-1/a.txt',
      'media/user-1/stray.txt',
    ])

    const report = await scanStorage(app, appOptions)
    const all = (
      await app.find({ collection: appOptions.findingsSlug as never, pagination: false, overrideAccess: true })
    ).docs as unknown as Finding[]

    expect(report.missing).toBe(0)
    expect(all.map((item) => `${item.kind}:${item.objectKey}`).toSorted()).toEqual([
      'orphan:media/b.txt',
      'orphan:media/user-1/stray.txt',
      'unused:media/k1/b.txt',
    ])

    for (const finding of all) {
      await app.update({
        collection: appOptions.findingsSlug as never,
        data: { status: 'delete' } as never,
        id: finding.id,
        overrideAccess: true,
      })
    }

    const purged = await purgeApproved(app, appOptions)

    expect(purged).toMatchObject({ deleted: 3, failed: [] })
    expect([...bucket.objects.keys()].toSorted()).toEqual([
      'media/c.txt',
      'media/user-1/a-10x10.txt',
      'media/user-1/a.txt',
    ])
    expect(
      (await app.find({ collection: 'media' as never, pagination: false, overrideAccess: true })).docs
        .map((doc) => doc.id)
        .toSorted(),
    ).toEqual([held.id, plain.id].toSorted())
    expect(loose.id).toBeDefined()
  })
})

describe(`storage plugin with a document prefix it rewrites on ${label}`, () => {
  const bucket = memoryAdapter()

  const keyFor = (prefix: string | undefined, doc: { prefix?: null | string }, filename: string): string =>
    getFileKey({ collectionPrefix: prefix, docPrefix: doc.prefix ?? '', filename, useCompositePrefixes: false }).fileKey

  const memoryStorage: Adapter = ({ prefix }) => ({
    name: 'memory',
    handleDelete: ({ doc, filename, storageFilePath }) => {
      bucket.objects.delete(storageFilePath ?? keyFor(prefix, doc as { prefix?: string }, filename))
    },
    handleUpload: ({ data, file: incoming, storageFilePath }) => {
      bucket.put(storageFilePath ?? keyFor(prefix, data as { prefix?: string }, incoming.filename))
    },
    staticHandler: () => new Response(null, { status: 404 }),
  })

  let app: Payload
  let appOptions: ResolvedOptions
  let stop = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload: app, teardown: stop } = await boot({
      collections: [
        { slug: 'users', auth: true, fields: [] },
        { slug: 'media', fields: [], upload: true },
        { slug: 'notes', fields: [{ name: 'media', type: 'relationship', relationTo: 'media' }] },
      ],
      plugins: [
        cloudStoragePlugin({ collections: { media: { adapter: memoryStorage, prefix: 'media' } } }),
        janitor({ collections: { media: true }, minAge: 0, storage: bucket }),
      ],
    }))

    appOptions = (app.config.custom as Record<string, ResolvedOptions>)[PLUGIN_NAME]!
  })

  afterAll(async () => {
    await stop()
  })

  it('takes the key of a document with a control character in its prefix as unknown, and never deletes its file', async () => {
    const doc = (await app.create({
      collection: 'media' as never,
      data: { prefix: 'media/x/.\u0001./y' } as never,
      file: fileOf('a.txt'),
      overrideAccess: true,
    })) as unknown as Doc

    await app.create({ collection: 'notes' as never, data: { media: doc.id } as never, overrideAccess: true })

    const [key] = [...bucket.objects.keys()]

    expect([...bucket.objects.keys()]).toEqual([expect.stringMatching(/^media\/(x\/)?y\/a\.txt$/)])

    await scanStorage(app, appOptions)

    expect(
      (
        (await app.find({ collection: appOptions.findingsSlug as never, pagination: false, overrideAccess: true }))
          .docs as unknown as Finding[]
      ).map((item) => `${item.kind}:${item.objectKey}`),
    ).toEqual([])

    await app.create({
      collection: appOptions.findingsSlug as never,
      data: { collectionSlug: 'media', kind: 'orphan', objectKey: key, status: 'delete' } as never,
      overrideAccess: true,
    })

    const report = await purgeApproved(app, appOptions)

    expect(report.skipped).toEqual([{ key, reason: 'the file is referenced by a document again' }])
    expect(bucket.objects.has(key!)).toBe(true)
  })
})

describe(`storage plugin with drafts on ${label}`, () => {
  const bucket = memoryAdapter()

  const memoryStorage: Adapter = () => ({
    name: 'memory',
    handleDelete: ({ storageFilePath }) => {
      bucket.objects.delete(storageFilePath)
    },
    handleUpload: ({ storageFilePath }) => {
      bucket.put(storageFilePath)
    },
    staticHandler: () => new Response(null, { status: 404 }),
  })

  let app: Payload
  let appOptions: ResolvedOptions
  let stop = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload: app, teardown: stop } = await boot({
      collections: [
        { slug: 'users', auth: true, fields: [] },
        { slug: 'drafts', fields: [], upload: true, versions: { drafts: true } },
      ],
      plugins: [
        cloudStoragePlugin({ collections: { drafts: { adapter: memoryStorage, prefix: 'drafts' } } }),
        janitor({ collections: { drafts: { report: ['orphans', 'missing'] } }, minAge: 0, storage: bucket }),
      ],
    }))

    appOptions = (app.config.custom as Record<string, ResolvedOptions>)[PLUGIN_NAME]!
  })

  afterAll(async () => {
    await stop()
  })

  const save = (id: number | string | undefined, name: null | string, draft: boolean): Promise<Doc> => {
    const args = {
      collection: 'drafts' as never,
      data: (draft ? {} : { _status: 'published' }) as never,
      draft,
      ...(name ? { file: fileOf(name) } : {}),
      overrideAccess: true,
    }

    return (id === undefined ? app.create(args) : app.update({ ...args, id })) as unknown as Promise<Doc>
  }

  const scan = async (): Promise<Finding[]> => {
    await scanStorage(app, appOptions)

    return (await app.find({ collection: appOptions.findingsSlug as never, overrideAccess: true, pagination: false }))
      .docs as unknown as Finding[]
  }

  it('keeps a replaced file while an old version holds it, then reports it as an orphan', async () => {
    const doc = await save(undefined, 'old.txt', false)

    await save(doc.id, 'new.txt', true)
    await save(doc.id, null, false)

    expect(bucket.objects.has('drafts/old.txt')).toBe(true)
    expect(await scan()).toEqual([])

    await app.db.deleteVersions({ collection: 'drafts', where: { parent: { equals: doc.id } } })

    const [orphan] = await scan()

    expect([orphan?.kind, orphan?.objectKey]).toEqual(['orphan', 'drafts/old.txt'])

    await app.update({
      collection: appOptions.findingsSlug as never,
      data: { status: 'delete' } as never,
      id: orphan!.id,
      overrideAccess: true,
    })
    await purgeApproved(app, appOptions)

    expect([bucket.objects.has('drafts/old.txt'), bucket.objects.has('drafts/new.txt')]).toEqual([false, true])
  })

  it('reports no missing file when an unpublished draft replaced its file', async () => {
    const doc = await save(undefined, 'first.txt', true)

    await save(doc.id, 'second.txt', true)

    expect(bucket.objects.has('drafts/first.txt')).toBe(false)
    expect(
      (await app.db.findOne<Doc & { filename: string }>({ collection: 'drafts', where: { id: { equals: doc.id } } }))
        ?.filename,
    ).toBe('first.txt')
    expect((await scan()).filter((finding) => finding.kind === 'missing')).toEqual([])

    bucket.objects.delete('drafts/second.txt')

    expect((await scan()).filter((finding) => finding.kind === 'missing').map((finding) => finding.objectKey)).toEqual([
      'drafts/first.txt',
    ])
  })

  it('looks up the latest drafts of a page in one query', async () => {
    const first = await save(undefined, 'alpha.txt', true)
    const second = await save(undefined, 'beta.txt', true)

    await save(first.id, 'alpha-new.txt', true)
    await save(second.id, 'beta-new.txt', true)

    const lookups = vi.spyOn(app, 'findVersions')

    onTestFinished(() => lookups.mockRestore())
    expect(
      (await scan()).filter((finding) => ['drafts/alpha.txt', 'drafts/beta.txt'].includes(finding.objectKey)),
    ).toEqual([])
    expect(lookups.mock.calls.filter(([args]) => JSON.stringify(args.where ?? null).includes('parent'))).toHaveLength(1)
  })
})
