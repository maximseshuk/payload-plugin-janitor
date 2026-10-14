import { afterEach, describe, expect, it, vi } from 'vitest'

import { bunnyAdapter } from '@/adapters/bunny.js'

import { collect, failing, INSIDE, KEYS, keysOf } from '../../helpers/storage.js'

describe('bunny adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const serve = (store: Set<string>, fail = () => {}) => {
    const urls: string[] = []

    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      urls.push(url)

      const { pathname } = new URL(url)
      const [, zone, ...rest] = pathname.split('/')
      const path = rest.map(decodeURIComponent).join('/')

      expect(decodeURIComponent(zone!)).toBe('my zone')

      if (init?.method === 'DELETE') {
        if (path === 'boom') return new Response(null, { status: 401 })

        return new Response(null, { status: store.delete(path) ? 200 : 404 })
      }

      fail()

      if (!path.endsWith('/') && path !== '') return new Response('file body', { status: 200 })

      const entries = new Map<string, { IsDirectory: boolean; Length: number; ObjectName: string }>()

      for (const key of store) {
        if (!key.startsWith(path)) continue

        const [name, ...deeper] = key.slice(path.length).split('/')

        entries.set(name!, { IsDirectory: deeper.length > 0, Length: key.length, ObjectName: name! })
      }

      return Response.json(
        [...entries.values()].map((entry) => ({
          ...entry,
          LastChanged: '2024-01-01T00:00:00.000',
          Path: `/my zone/${path}`,
        })),
      )
    })

    return urls
  }

  const storage = () => bunnyAdapter({ apiKey: 'k', region: 'uk', zoneName: 'my zone' })

  it('walks nested directories and keeps raw keys', async () => {
    const urls = serve(new Set(KEYS))
    const seen = await collect(storage())

    expect(keysOf(seen)).toEqual(INSIDE.toSorted())
    expect(urls.every((url) => url.startsWith('https://uk.storage.bunnycdn.com/my%20zone/'))).toBe(true)
  })

  it('takes the storage options of bunnyStorage and sends the default region to the main host', async () => {
    const shared = { apiKey: 'k', hostname: 'example.b-cdn.net', region: 'de', zoneName: 'my zone' }
    const urls = serve(new Set(KEYS))

    await collect(bunnyAdapter(shared))
    await collect(bunnyAdapter({ ...shared, region: undefined }))

    expect(urls.every((url) => url.startsWith('https://storage.bunnycdn.com/my%20zone/'))).toBe(true)
  })

  it('walks the whole zone for an empty prefix', async () => {
    serve(new Set(KEYS))

    expect(keysOf(await collect(storage(), { prefix: '' }))).toEqual(KEYS.toSorted())
  })

  it('throws when a directory listing fails midway', async () => {
    serve(new Set(KEYS), failing(new Error('socket hang up')))

    await expect(collect(storage())).rejects.toThrow('socket hang up')
  })

  it('throws on a failed status', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 500 }))

    await expect(collect(storage())).rejects.toThrow(/500/)
  })

  it('looks up requested keys by listing only their directories', async () => {
    const urls = serve(new Set(KEYS))
    const seen = await collect(storage(), { keys: ['media/photo#1.jpg', 'media/nested/deep.png', 'media/gone.png'] })

    expect(keysOf(seen)).toEqual(['media/nested/deep.png', 'media/photo#1.jpg'])
    expect(urls).toEqual([
      'https://uk.storage.bunnycdn.com/my%20zone/media/',
      'https://uk.storage.bunnycdn.com/my%20zone/media/nested/',
    ])
  })

  it('encodes every path segment on delete, so # and ? reach the right object', async () => {
    const store = new Set(KEYS)
    const urls = serve(store)

    for (const key of ['media/photo#1.jpg', 'media/what?.png', 'media/100%.png', 'media/фото.png']) {
      await storage().delete({ collection: 'media', key, prefix: 'media' })
    }

    expect(urls[0]).toBe('https://uk.storage.bunnycdn.com/my%20zone/media/photo%231.jpg')
    expect(urls[1]).toBe('https://uk.storage.bunnycdn.com/my%20zone/media/what%3F.png')
    expect([...store].toSorted()).toEqual(['media-other/x.png', 'media/a b.png', 'media/nested/deep.png', 'root.png'])
  })

  it('resolves a delete of an object that is already gone and throws other failures', async () => {
    serve(new Set())

    await expect(
      storage().delete({ collection: 'media', key: 'media/x.png', prefix: 'media' }),
    ).resolves.toBeUndefined()
    await expect(storage().delete({ collection: 'media', key: 'boom', prefix: '' })).rejects.toThrow(/401/)
  })

  it('marks a document with a Bunny Stream video as kept outside storage', () => {
    expect(storage().external).toBe('bunnyData.stream.videoId')
  })
})
