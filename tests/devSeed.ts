import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Payload } from 'payload'
import { getPayload } from 'payload'

import { janitorOptions } from '@/server/run.js'

import config, { devMedia } from './payload.config.js'
import { clear } from './seed.js'

const PUBLISHED = 24
const DRAFTS = 4
const REVISIONS = 6

const upload = async (payload: Payload, name: string, collection = 'media'): Promise<number | string> => {
  const doc = await payload.create({
    collection: collection as 'media',
    data: { alt: name },
    file: { data: Buffer.from(name), mimetype: 'text/plain', name, size: name.length },
    overrideAccess: true,
  })

  return doc.id
}

const title = (index: number): string =>
  [
    'Autumn lookbook',
    'Spring drop',
    'Repair guide',
    'Winter teaser',
    'Care instructions',
    'Studio visit',
    'Behind the bench',
    'Stone sourcing',
  ][index % 8] + ` ${Math.floor(index / 8) + 1}`

const ORPHANS = { files: ['forgotten-manual.txt'], media: ['stray-banner.txt', 'old-export.txt'] }

const writeOrphans = async (): Promise<void> => {
  for (const [slug, names] of Object.entries(ORPHANS)) {
    await mkdir(path.join(devMedia, slug), { recursive: true })

    for (const name of names) await writeFile(path.join(devMedia, slug, name), `${name}, no document holds it`)
  }
}

const run = async (): Promise<void> => {
  const payload = await getPayload({ config })

  await clear(payload, janitorOptions(payload)!)
  await payload.delete({ collection: 'users', where: {}, overrideAccess: true })

  await payload.create({
    collection: 'users',
    data: { email: 'dev@example.com', password: 'dev' },
    overrideAccess: true,
  })

  const shared = await upload(payload, 'shared.txt')
  const lonely = await upload(payload, 'lonely.txt')
  const manual = await upload(payload, 'manual.txt', 'files')
  const featured = await payload.create({ collection: 'tags', data: { name: 'Featured' }, overrideAccess: true })

  await payload.create({
    collection: 'tags',
    data: { name: 'Forgotten tag', notes: 'Nothing points here' },
    overrideAccess: true,
  })

  for (let index = 0; index < PUBLISHED; index++) {
    await payload.create({
      collection: 'posts',
      data: {
        gallery: index % 3 === 0 ? [shared] : [],
        hero: shared,
        layout:
          index % 2 === 0
            ? []
            : [
                {
                  blockType: 'gallery',
                  caption: 'Inside a block',
                  credit: { author: 'Studio', portrait: shared },
                  image: shared,
                },
              ],
        manual: index % 5 === 0 ? manual : undefined,
        meta: index % 4 === 0 ? { cover: shared, note: 'cover too' } : {},
        related: index % 6 === 0 ? { relationTo: 'tags', value: featured.id } : undefined,
        title: title(index),
      },
      overrideAccess: true,
    })
  }

  for (let index = 0; index < DRAFTS; index++) {
    const draft = await payload.create({
      collection: 'deep',
      data: { title: `Unpublished story ${index + 1}` },
      draft: true,
      overrideAccess: true,
    })

    await payload.update({
      collection: 'deep',
      data: { banner: shared, title: `Unpublished story ${index + 1}` },
      draft: true,
      id: draft.id,
      overrideAccess: true,
    })
  }

  const historic = await payload.create({
    collection: 'deep',
    data: { banner: shared, title: 'Archived campaign' },
    overrideAccess: true,
  })

  for (let revision = 0; revision < REVISIONS; revision++) {
    await payload.update({
      collection: 'deep',
      data: { banner: shared, title: `Archived campaign v${revision + 2}` },
      id: historic.id,
      overrideAccess: true,
    })

    await new Promise((resolve) => setTimeout(resolve, 1100))
  }

  await payload.update({
    collection: 'deep',
    data: { banner: null, title: 'Archived campaign, cleaned up' },
    id: historic.id,
    overrideAccess: true,
  })

  await payload.update({
    collection: 'deep',
    data: { banner: shared, title: 'Archivierte Kampagne' },
    id: historic.id,
    locale: 'de',
    overrideAccess: true,
  })

  const trashed = await payload.create({
    collection: 'posts',
    data: { hero: shared, title: 'Old campaign' },
    overrideAccess: true,
  })

  await payload.update({
    collection: 'posts',
    data: { deletedAt: new Date().toISOString() },
    id: trashed.id,
    overrideAccess: true,
  })

  await payload.updateGlobal({
    data: { branding: { icons: [{ icon: shared }, { icon: shared }] }, logo: shared },
    slug: 'settings' as never,
    overrideAccess: true,
  })

  await writeOrphans()

  payload.logger.info(
    `dev data ready — log in as dev@example.com / dev, open media/${shared} (used everywhere) or media/${lonely} (used nowhere)`,
  )

  process.exit(0)
}

void run()
