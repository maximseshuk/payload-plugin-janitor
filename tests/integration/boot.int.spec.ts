import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { janitor } from '@/index.js'
import { findUsageDetail } from '@/server/usage/index.js'

import { boot } from '../helpers/boot.js'

describe(`findUsageDetail on ${process.env.TEST_DB ?? 'sqlite'}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      collections: [
        {
          slug: 'media',
          fields: [{ name: 'thumbnail', type: 'upload', relationTo: 'media' }],
          upload: { disableLocalStorage: true },
        },
      ],
    }))
  })

  afterAll(async () => {
    await teardown()
  })

  it('names the sibling upload pointing at a self-related one, never the document itself', async () => {
    const file = (name: string) => ({ data: Buffer.from(name), mimetype: 'text/plain', name, size: name.length })
    const target = await payload.create({
      collection: 'media' as never,
      data: {},
      file: file('target.txt'),
      overrideAccess: true,
    })
    const sibling = await payload.create({
      collection: 'media' as never,
      data: { thumbnail: target.id },
      file: file('sibling.txt'),
      overrideAccess: true,
    })

    await payload.update({
      collection: 'media' as never,
      data: { thumbnail: target.id },
      id: target.id,
      overrideAccess: true,
    })

    const hits = await findUsageDetail(payload, {
      collection: 'media',
      id: String(target.id),
      ignoreTables: [],
      text: false,
      versions: 'used',
    })

    expect(hits?.map((hit) => [hit.collection, String(hit.id), hit.fields])).toEqual([
      ['media', String(sibling.id), ['Thumbnail']],
    ])
  })
})

describe(`boot on ${process.env.TEST_DB ?? 'sqlite'}`, () => {
  it('boots a private Payload, writes a document and tears it down', async () => {
    const { payload, teardown } = await boot({
      collections: [{ slug: 'notes', fields: [{ name: 'text', type: 'text' }] }],
    })

    try {
      await payload.create({ collection: 'notes' as never, data: { text: 'hello' } as never, overrideAccess: true })

      expect((await payload.count({ collection: 'notes' as never, overrideAccess: true })).totalDocs).toBe(1)
    } finally {
      await teardown()
    }
  })

  it('keeps findings unique per collection and object key', async () => {
    const { payload, teardown } = await boot({
      collections: [
        { slug: 'a', fields: [], upload: { disableLocalStorage: true } },
        { slug: 'b', fields: [], upload: { disableLocalStorage: true } },
      ],
      plugins: [
        janitor({
          admin: false,
          collections: { a: { usagePanel: false }, b: { usagePanel: false } },
          endpoints: false,
        }),
      ],
    })
    const finding = (collectionSlug: string) =>
      payload.create({
        collection: 'janitor-findings' as never,
        data: { collectionSlug, kind: 'orphan', objectKey: 'shared.png' } as never,
        overrideAccess: true,
      })

    try {
      await finding('a')
      await finding('b')

      await expect(finding('a')).rejects.toThrow()
      expect(payload.config.endpoints.some((endpoint) => endpoint.path.startsWith('/janitor'))).toBe(false)
    } finally {
      await teardown()
    }
  })
})
