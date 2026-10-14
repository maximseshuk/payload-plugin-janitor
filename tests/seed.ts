import type { Payload } from 'payload'

import type { ResolvedOptions } from '@/shared/types/resolved.js'

export const FIXTURES = {
  attachment: 'an array row',
  banner: 'a localized field',
  block: 'a block inside an unnamed tab',
  blockGroup: 'a group inside a block',
  cover: 'a group',
  deep: 'array › group › blocks › array',
  draftOnly: 'an unpublished draft',
  gallery: 'a hasMany list',
  hero: 'a row',
  icon: 'an array inside a group of a global',
  json: 'a json field',
  lexical: 'a lexical-shaped tree in a json field',
  localized: 'a non-default locale',
  logo: 'a global',
  mentions: 'a hasMany relationship',
  polymorphic: 'a polymorphic relationship',
  richText: 'an upload node in rich text',
  seo: 'a named tab',
  sidebar: 'a collapsible',
  simple: 'a flat document',
  thumbnail: 'a self-relation on the upload collection itself',
  unused: 'nothing at all',
} as const

export const FILES = {
  manual: 'an upload field pointing at a second collection',
  spare: 'nothing at all',
} as const

export type Fixture = keyof typeof FIXTURES
type FileFixture = keyof typeof FILES

export const REFERENCED = (Object.keys(FIXTURES) as Fixture[]).filter((fixture) => fixture !== 'unused')

export type Seeded = {
  fileIds: Record<FileFixture, number | string>
  filenames: Record<Fixture | FileFixture, string>
  ids: Record<Fixture, number | string>
  unusedFilename: string
}

const filenameOf = (fixture: Fixture | FileFixture): string => `${fixture}.txt`

const upload = async (
  payload: Payload,
  filename: string,
  collection = 'media',
): Promise<{ filename: string; id: number | string }> => {
  const doc = await payload.create({
    collection: collection as 'media',
    data: { alt: filename },
    file: { data: Buffer.from(filename), mimetype: 'text/plain', name: filename, size: filename.length },
    overrideAccess: true,
  })

  return { filename: doc.filename!, id: doc.id }
}

const richTextWith = (id: number | string) => ({
  root: {
    type: 'root',
    children: [
      {
        type: 'upload',
        fields: null,
        format: '',
        relationTo: 'media',
        value: id,
        version: 3,
      },
    ],
    direction: null,
    format: '',
    indent: 0,
    version: 1,
  },
})

export const clear = async (payload: Payload, options: ResolvedOptions): Promise<void> => {
  await payload.updateGlobal({
    data: { branding: { icons: [] }, logo: null },
    slug: 'settings' as never,
    overrideAccess: true,
  })

  const collections = [
    'simple',
    'locked',
    'notices',
    'posts',
    'deep',
    'tags',
    'media',
    'files',
    options.findingsSlug,
    options.runsSlug,
  ]

  for (const collection of collections) {
    await payload.delete({ collection: collection as 'media', trash: true, where: {}, overrideAccess: true })
  }
}

export const seed = async (payload: Payload): Promise<Seeded> => {
  const ids = {} as Record<Fixture, number | string>
  const filenames = {} as Record<Fixture | FileFixture, string>

  for (const fixture of Object.keys(FIXTURES) as Fixture[]) {
    ;({ filename: filenames[fixture], id: ids[fixture] } = await upload(payload, filenameOf(fixture)))
  }

  const fileIds = {} as Record<FileFixture, number | string>

  for (const fixture of Object.keys(FILES) as FileFixture[]) {
    ;({ filename: filenames[fixture], id: fileIds[fixture] } = await upload(payload, filenameOf(fixture), 'files'))
  }

  await payload.update({
    collection: 'media',
    data: { thumbnail: ids.thumbnail },
    id: ids.simple,
    overrideAccess: true,
  })

  await payload.create({
    collection: 'simple',
    data: {
      contact: 'editor@example.com',
      featured: true,
      image: ids.simple,
      publishedOn: new Date().toISOString(),
      size: 'm',
      snippet: 'const a = 1',
      status: 'live',
      summary: 'a flat document',
      title: 'simple',
      weight: 3,
    },
    overrideAccess: true,
  })

  await payload.create({
    collection: 'posts',
    data: {
      attachments: [{ file: ids.attachment, label: 'sheet' }],
      body: {
        root: {
          children: [
            { children: [{ text: 'text' }], type: 'paragraph' },
            { relationTo: 'media', type: 'upload', value: { id: ids.lexical } },
          ],
        },
        note: { image: ids.json },
      },
      gallery: [ids.gallery],
      hero: ids.hero,
      layout: [
        {
          blockType: 'gallery',
          caption: 'shown',
          credit: { author: 'ada', portrait: ids.blockGroup },
          image: ids.block,
        },
      ],
      manual: fileIds.manual,
      mentions: [ids.mentions],
      meta: { cover: ids.cover, note: 'grouped' },
      related: { relationTo: 'media', value: ids.polymorphic },
      seo: { image: ids.seo },
      sidebar: ids.sidebar,
      title: 'seeded post',
    },
    overrideAccess: true,
  })

  const deep = await payload.create({
    collection: 'deep',
    data: {
      _status: 'published',
      article: richTextWith(ids.richText),
      banner: ids.banner,
      sections: [{ panel: { content: [{ blockType: 'slideshow', slides: [{ image: ids.deep }] }] } }],
      title: 'deep',
    },
    overrideAccess: true,
  })

  await payload.update({
    collection: 'deep',
    data: { _status: 'published', banner: ids.localized, title: 'tief' },
    id: deep.id,
    locale: 'de',
    overrideAccess: true,
  })

  await payload.update({
    collection: 'deep',
    data: {
      _status: 'draft',
      sections: [
        { panel: { content: [{ blockType: 'slideshow', slides: [{ image: ids.deep }] }] } },
        { panel: { content: [{ blockType: 'slideshow', slides: [{ image: ids.draftOnly }] }] } },
      ],
    },
    draft: true,
    id: deep.id,
    overrideAccess: true,
  })

  await payload.create({
    collection: 'tags',
    data: { name: 'unrelated', notes: String(ids.unused) },
    overrideAccess: true,
  })

  await payload.updateGlobal({
    data: { branding: { icons: [{ icon: ids.icon }] }, logo: ids.logo },
    slug: 'settings' as never,
    overrideAccess: true,
  })

  return { fileIds, filenames, ids, unusedFilename: filenames.unused }
}
