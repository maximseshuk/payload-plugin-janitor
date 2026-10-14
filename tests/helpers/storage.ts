import { expect, it } from 'vitest'

import { azureAdapter } from '@/adapters/azure.js'
import { gcsAdapter } from '@/adapters/gcs.js'
import { r2Adapter } from '@/adapters/r2.js'
import { s3Adapter } from '@/adapters/s3.js'
import { vercelBlobAdapter } from '@/adapters/vercelBlob.js'
import type { StorageAdapter, StorageListArgs, StorageObject } from '@/shared/types/storage.js'

export const KEYS = [
  'media/a b.png',
  'media/photo#1.jpg',
  'media/what?.png',
  'media/фото.png',
  'media/100%.png',
  'media/nested/deep.png',
  'media-other/x.png',
  'root.png',
]

export const INSIDE = KEYS.filter((key) => key.startsWith('media/'))

const PAGE = 2

export const when = new Date('2024-01-01T00:00:00Z')

export const collect = async (
  adapter: StorageAdapter,
  args: Partial<StorageListArgs> = {},
): Promise<StorageObject[]> => {
  const seen: StorageObject[] = []

  for await (const page of adapter.list({ collection: 'media', prefix: 'media', ...args })) seen.push(...page)

  return seen
}

export const keysOf = (objects: StorageObject[]): string[] => objects.map((object) => object.key).toSorted()

export const failing = (err: Error, after = 1) => {
  let calls = 0

  return () => {
    calls += 1
    if (calls > after) throw err
  }
}

type Fake = (store: Set<string>, fail?: () => void) => StorageAdapter

const pageOf = (store: Set<string>, prefix: string | undefined, start: number) => {
  const matching = [...store].filter((key) => !prefix || key.startsWith(prefix)).toSorted()
  const slice = matching.slice(start, start + PAGE)
  const next = start + PAGE < matching.length ? start + PAGE : undefined

  return { next, slice }
}

export class ListObjectsV2Command {
  constructor(readonly input: { Bucket: string; ContinuationToken?: string; Prefix?: string }) {}
}

export class DeleteObjectCommand {
  constructor(readonly input: { Bucket: string; Key: string }) {}
}

export const s3 = (store: Set<string>, fail = () => {}): StorageAdapter => {
  return s3Adapter({
    bucket: 'b',
    client: {
      send: async (command: unknown) => {
        if (command instanceof DeleteObjectCommand) {
          if (command.input.Key === 'boom') throw Object.assign(new Error('denied'), { name: 'AccessDenied' })
          if (!store.delete(command.input.Key)) {
            throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 }, name: 'NoSuchKey' })
          }

          return {}
        }

        fail()

        const { input } = command as ListObjectsV2Command
        const { next, slice } = pageOf(store, input.Prefix, Number(input.ContinuationToken ?? 0))

        return {
          Contents: slice.map((Key) => ({ Key, LastModified: when, Size: Key.length })),
          IsTruncated: next !== undefined,
          NextContinuationToken: next === undefined ? undefined : String(next),
        }
      },
    },
    commands: { DeleteObjectCommand, ListObjectsV2Command },
  })
}

export const r2 = (store: Set<string>, fail = () => {}): StorageAdapter =>
  r2Adapter({
    delete: async (key) => {
      if (key === 'boom') throw new Error('denied')
      store.delete(key as string)
    },
    list: async ({ cursor, prefix } = {}) => {
      fail()

      const { next, slice } = pageOf(store, prefix, Number(cursor ?? 0))

      return {
        cursor: next === undefined ? undefined : String(next),
        objects: slice.map((key) => ({ key, size: key.length, uploaded: when })),
        truncated: next !== undefined,
      }
    },
  })

export const gcs = (store: Set<string>, fail = () => {}): StorageAdapter =>
  gcsAdapter({
    file: (name) => ({
      delete: async () => {
        if (name === 'boom') throw Object.assign(new Error('denied'), { code: 403 })
        if (!store.delete(name)) throw Object.assign(new Error('missing'), { code: 404 })
      },
      metadata: {},
      name,
    }),
    getFiles: async (query = {}) => {
      fail()

      const { next, slice } = pageOf(store, query.prefix, Number(query.pageToken ?? 0))
      const files = slice.map((name) => ({
        delete: async () => {},
        metadata: { size: String(name.length), updated: when.toISOString() },
        name,
      }))

      return [files, next === undefined ? null : { ...query, pageToken: String(next) }] as const
    },
  })

export const azure = (store: Set<string>, fail = () => {}): StorageAdapter =>
  azureAdapter({
    deleteBlob: async (name) => {
      if (name === 'boom') throw Object.assign(new Error('denied'), { statusCode: 403 })
      if (!store.delete(name)) throw Object.assign(new Error('missing'), { statusCode: 404 })
    },
    listBlobsFlat: async function* ({ prefix } = {}) {
      for (const name of [...store].filter((key) => !prefix || key.startsWith(prefix)).toSorted()) {
        fail()
        yield { name, properties: { contentLength: name.length, lastModified: when } }
      }
    },
  })

export const vercel = (store: Set<string>, fail = () => {}): StorageAdapter =>
  vercelBlobAdapter({
    del: async (url) => {
      if (url === 'boom') throw new Error('denied')
      const target = url as string

      store.delete(target.startsWith('https://') ? decodeURIComponent(new URL(target).pathname.slice(1)) : target)
    },
    list: async ({ cursor, prefix }) => {
      fail()

      const { next, slice } = pageOf(store, prefix, Number(cursor ?? 0))

      return {
        blobs: slice.map((pathname) => ({
          pathname,
          size: pathname.length,
          uploadedAt: when,
          url: `https://store.public.blob.vercel-storage.com/${encodeURIComponent(pathname)}`,
        })),
        cursor: next === undefined ? undefined : String(next),
        hasMore: next !== undefined,
      }
    },
  })

export const contract = (adapter: Fake) => {
  it('walks every page of the prefix and keeps keys exactly as stored', async () => {
    const seen = await collect(adapter(new Set(KEYS)))

    expect(keysOf(seen)).toEqual(INSIDE.toSorted())
    expect(seen.every((object) => object.lastModified?.getTime() === when.getTime())).toBe(true)
    expect(seen.every((object) => object.size === object.key.length)).toBe(true)
  })

  it('walks the whole bucket for an empty prefix', async () => {
    expect(keysOf(await collect(adapter(new Set(KEYS)), { prefix: '' }))).toEqual(KEYS.toSorted())
  })

  it('throws when the listing fails midway instead of stopping short', async () => {
    const pages = collect(adapter(new Set(KEYS), failing(new Error('network down'))))

    await expect(pages).rejects.toThrow('network down')
  })

  it('returns only the requested keys that exist', async () => {
    const seen = await collect(adapter(new Set(KEYS)), {
      keys: ['media/photo#1.jpg', 'media/фото.png', 'media/gone.png', 'media/a b.png', 'media/photo#1.jpg'],
    })

    expect(keysOf(seen)).toEqual(['media/a b.png', 'media/photo#1.jpg', 'media/фото.png'])
  })

  it('finds a requested key among longer keys that share it as a prefix', async () => {
    const store = new Set(['media/a.png.bak', 'media/a.png-1', 'media/a.png.old', 'media/a.png'])

    expect(keysOf(await collect(adapter(store), { keys: ['media/a.png'] }))).toEqual(['media/a.png'])
  })

  it('resolves a delete of an object that is already gone', async () => {
    const store = new Set(KEYS)
    const storage = adapter(store)

    await storage.delete({ collection: 'media', key: 'media/what?.png', prefix: 'media' })
    expect(store.has('media/what?.png')).toBe(false)
    await expect(
      storage.delete({ collection: 'media', key: 'media/what?.png', prefix: 'media' }),
    ).resolves.toBeUndefined()
  })

  it('throws any other delete error', async () => {
    await expect(
      adapter(new Set(KEYS)).delete({ collection: 'media', key: 'boom', prefix: '', ref: 'boom' }),
    ).rejects.toThrow('denied')
  })
}
