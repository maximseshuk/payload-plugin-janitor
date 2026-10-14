import { initI18n } from '@payloadcms/translations'
import { en as payloadEnglish } from '@payloadcms/translations/languages/en'
import { ru as payloadRussian } from '@payloadcms/translations/languages/ru'
import { formatDocTitle } from '@payloadcms/ui/shared'
import { type ClientField, createClientCollectionConfig, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { janitor } from '@/index.js'
import { PLUGIN_NAME } from '@/shared/constants.js'

import { boot } from '../helpers/boot.js'

describe(`delete guard and findings on ${process.env.TEST_DB ?? 'sqlite'}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      i18n: { supportedLanguages: { en: payloadEnglish, ru: payloadRussian } },
      collections: [
        { slug: 'tags', admin: { useAsTitle: 'name' }, fields: [{ name: 'name', type: 'text' }] },
        {
          slug: 'posts',
          admin: { useAsTitle: 'title' },
          fields: [
            { name: 'title', type: 'text' },
            { name: 'tag', type: 'relationship', relationTo: 'tags' },
          ],
          versions: true,
        },
        {
          slug: 'blog-posts',
          fields: [
            { name: 'title', type: 'text' },
            { name: 'tag', type: 'relationship', relationTo: 'tags' },
          ],
        },
      ],
      plugins: [
        janitor({
          admin: false,
          collections: { tags: { usagePanel: false } },
          endpoints: false,
          references: { versions: 'unused' },
        }),
      ],
    }))
  })

  afterAll(async () => {
    await teardown()
  })

  it('refuses to delete a referenced document and names the referencing one', async () => {
    const tag = await payload.create({
      collection: 'tags' as never,
      data: { name: 'news' } as never,
      overrideAccess: true,
    })

    await payload.create({
      collection: 'posts' as never,
      data: { tag: tag.id, title: 'Launch day' } as never,
      overrideAccess: true,
    })

    await expect(payload.delete({ collection: 'tags' as never, id: tag.id, overrideAccess: true })).rejects.toThrow(
      /still used in .*Launch day/,
    )
  })

  it('lets a document go that only an old version references, with references.versions unused', async () => {
    const tag = await payload.create({
      collection: 'tags' as never,
      data: { name: 'archive' } as never,
      overrideAccess: true,
    })
    const post = await payload.create({
      collection: 'posts' as never,
      data: { tag: tag.id, title: 'Old news' } as never,
      overrideAccess: true,
    })

    await payload.update({
      collection: 'posts' as never,
      data: { tag: null } as never,
      id: post.id,
      overrideAccess: true,
    })

    await payload.delete({ collection: 'tags' as never, id: tag.id, overrideAccess: true })

    expect(
      (await payload.find({ collection: 'tags' as never, overrideAccess: true, where: { id: { equals: tag.id } } }))
        .docs,
    ).toHaveLength(0)
  })

  it('names only the places that block the delete, with references.versions unused', async () => {
    const tag = await payload.create({
      collection: 'tags' as never,
      data: { name: 'kept' } as never,
      overrideAccess: true,
    })
    const old = await payload.create({
      collection: 'posts' as never,
      data: { tag: tag.id, title: 'Old story' } as never,
      overrideAccess: true,
    })

    await payload.update({
      collection: 'posts' as never,
      data: { tag: null } as never,
      id: old.id,
      overrideAccess: true,
    })
    await payload.create({
      collection: 'posts' as never,
      data: { tag: tag.id, title: 'Live story' } as never,
      overrideAccess: true,
    })

    const error = await payload
      .delete({ collection: 'tags' as never, id: tag.id, overrideAccess: true })
      .catch((caught: unknown) => caught)

    expect(String(error)).toMatch(/still used in 1 place: Live story/)
    expect(String(error)).not.toMatch(/Old story/)
  })

  it('lets purge delete only the document its context names', async () => {
    const tag = await payload.create({
      collection: 'tags' as never,
      data: { name: 'purged' } as never,
      overrideAccess: true,
    })
    const other = await payload.create({
      collection: 'tags' as never,
      data: { name: 'kept' } as never,
      overrideAccess: true,
    })

    for (const target of [tag, other]) {
      await payload.create({
        collection: 'posts' as never,
        data: { tag: target.id, title: 'Holder' } as never,
        overrideAccess: true,
      })
    }

    const attempt = (context: unknown) =>
      payload.delete({
        collection: 'tags' as never,
        context: { [PLUGIN_NAME]: context },
        id: other.id,
        overrideAccess: true,
      })

    await expect(attempt({ collection: 'tags', id: String(tag.id) })).rejects.toThrow(/still used/)
    await expect(attempt({ collection: 'posts', id: String(other.id) })).rejects.toThrow(/still used/)
    await expect(attempt('purge')).rejects.toThrow(/still used/)

    await payload.delete({
      collection: 'tags' as never,
      context: { [PLUGIN_NAME]: { collection: 'tags', id: String(tag.id) } },
      id: tag.id,
      overrideAccess: true,
    })

    expect(
      (await payload.count({ collection: 'tags' as never, where: { id: { equals: tag.id } }, overrideAccess: true }))
        .totalDocs,
    ).toBe(0)
  })

  it('refuses with its message when a hyphenated collection references the document', async () => {
    const tag = await payload.create({
      collection: 'tags' as never,
      data: { name: 'hyphen' } as never,
      overrideAccess: true,
    })

    await payload.create({
      collection: 'blog-posts' as never,
      data: { tag: tag.id, title: 'Dash' } as never,
      overrideAccess: true,
    })

    await expect(payload.delete({ collection: 'tags' as never, id: tag.id, overrideAccess: true })).rejects.toThrow(
      /still used/,
    )
  })

  it('hands the admin plain labels in the request language, so sort buttons can read them', async () => {
    const i18n = await initI18n({ config: payload.config.i18n as never, context: 'client', language: 'ru' })
    const client = (slug: string) =>
      createClientCollectionConfig({
        collection: payload.collections[slug as never]!.config,
        defaultIDType: payload.db.defaultIDType,
        i18n,
        importMap: {},
      })
    const labels = (fields: ClientField[]): unknown[] =>
      fields.flatMap((field) => [
        ...('label' in field ? [field.label] : []),
        ...('options' in field ? field.options.map((option) => (option as { label: unknown }).label) : []),
        ...('fields' in field ? labels(field.fields) : []),
      ])
    const findings = labels(client('janitor-findings').fields)
    const runs = labels(client('janitor-runs').fields)

    expect(findings).toContain('Ключ')
    expect(findings).toContain('Коллекция')
    expect(runs).toContain('Начат')
    for (const text of [...findings, ...runs]) {
      if (text !== undefined) expect(typeof text).toBe('string')
    }
  })

  it('titles a run by its id, so a relationship select can name it without a date in another time zone', async () => {
    const startedAt = '2026-10-01T06:33:12.345Z'
    const run = await payload.create({
      collection: 'janitor-runs' as never,
      data: { mode: 'scan', startedAt, status: 'done' } as never,
      overrideAccess: true,
    })
    const i18n = await initI18n({ config: payload.config.i18n as never, context: 'client', language: 'en' })
    const collection = createClientCollectionConfig({
      collection: payload.collections['janitor-runs' as never]!.config,
      defaultIDType: payload.db.defaultIDType,
      i18n,
      importMap: {},
    })
    const useAsTitle = String(collection.admin.useAsTitle)
    const { docs } = await payload.find({
      collection: 'janitor-runs' as never,
      select: { [useAsTitle]: true } as never,
      where: { id: { equals: run.id } },
      overrideAccess: true,
    })
    const label = formatDocTitle({
      collectionConfig: collection,
      data: docs[0] as never,
      dateFormat: payload.config.admin.dateFormat,
      fallback: 'untitled',
      i18n: { ...i18n, dateFNS: undefined } as never,
    })

    expect(label).toBe(`#${run.id}`)
    expect((run as { title?: string }).title).toBe(`#${run.id}`)
  })

  it('lets a user change only the status and note of a finding', async () => {
    const user = await payload.create({
      collection: 'users' as never,
      data: { email: 'janitor@example.com', password: 'janitor' } as never,
      overrideAccess: true,
    })
    const finding = await payload.create({
      collection: 'janitor-findings' as never,
      data: { collectionSlug: 'tags', kind: 'unused', objectKey: 'tags/200' } as never,
      overrideAccess: true,
    })
    const forged = { collectionSlug: 'posts', documentId: '1', kind: 'orphan', objectKey: 'media/other.png' }
    const kept = { collectionSlug: 'tags', kind: 'unused', objectKey: 'tags/200' }

    const updated = await payload.update({
      collection: 'janitor-findings' as never,
      data: { ...forged, note: 'approved', error: 'forged', status: 'delete' } as never,
      id: finding.id,
      overrideAccess: false,
      user: user as never,
    })

    expect(updated).toMatchObject({ ...kept, note: 'approved', status: 'delete' })
    expect((updated as { documentId?: unknown }).documentId ?? null).toBeNull()
    expect((updated as { error?: unknown }).error ?? null).toBeNull()

    await expect(
      payload.create({
        collection: 'janitor-findings' as never,
        data: { ...forged, status: 'delete' } as never,
        overrideAccess: false,
        user: user as never,
      }),
    ).rejects.toThrow()
  })

  it('keeps a running run from being deleted, so the scan or purge behind it is not cut short', async () => {
    const user = await payload.create({
      collection: 'users' as never,
      data: { email: 'runs@example.com', password: 'runs' } as never,
      overrideAccess: true,
    })
    const create = (status: string) =>
      payload.create({
        collection: 'janitor-runs' as never,
        data: { mode: 'scan', startedAt: new Date().toISOString(), status } as never,
        overrideAccess: true,
      })
    const running = await create('running')
    const done = await create('done')
    const remove = (id: number | string) =>
      payload.delete({ collection: 'janitor-runs' as never, id, overrideAccess: false, user: user as never })

    await expect(remove(running.id)).rejects.toThrow()
    await expect(remove(done.id)).resolves.toMatchObject({ id: done.id })
    await payload.delete({ collection: 'janitor-runs' as never, id: running.id, overrideAccess: true })
  })

  it('lets an unreferenced document go', async () => {
    const tag = await payload.create({
      collection: 'tags' as never,
      data: { name: 'loose' } as never,
      overrideAccess: true,
    })

    await payload.delete({ collection: 'tags' as never, id: tag.id, overrideAccess: true })

    expect(
      (await payload.count({ collection: 'tags' as never, where: { id: { equals: tag.id } }, overrideAccess: true }))
        .totalDocs,
    ).toBe(0)
  })

  it('marks an unused finding held only by old versions', async () => {
    const finding = (objectKey: string, usage: unknown[]) =>
      payload.create({
        collection: 'janitor-findings' as never,
        data: { collectionSlug: 'tags', kind: 'unused', objectKey, usage } as never,
        overrideAccess: true,
      })

    const held = (await finding('tags/100', [
      { column: 'tag_id', count: 1, table: '_posts_v', versions: true },
    ])) as unknown as { onlyVersions: boolean }
    const free = (await finding('tags/101', [])) as unknown as { onlyVersions: boolean }

    expect(held.onlyVersions).toBe(true)
    expect(free.onlyVersions).toBe(false)
  })
})
