import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor, UploadFeature } from '@payloadcms/richtext-lexical'
import { de } from '@payloadcms/translations/languages/de'
import { en } from '@payloadcms/translations/languages/en'
import { ru } from '@payloadcms/translations/languages/ru'
import { buildConfig, type CollectionConfig } from 'payload'

import { localAdapter } from '@/adapters/local.js'
import { janitor } from '@/index.js'

import { Deep, Files, Locked, Media, Notices, Posts, Settings, Simple, Tags, Users } from './collections/index.js'
import { memoryAdapter } from './memoryAdapter.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export const storage = memoryAdapter()

const dev = process.env.JANITOR_DEV === '1'

export const devMedia = path.join(dirname, 'dev-media')

const staticDirOf = (slug: string): string => path.join(devMedia, slug)

const onDisk = (collection: CollectionConfig): CollectionConfig =>
  dev && collection.upload
    ? {
        ...collection,
        upload: {
          ...(collection.upload === true ? {} : collection.upload),
          disableLocalStorage: false,
          staticDir: staticDirOf(collection.slug),
        },
      }
    : collection

const blocksAsJSON = process.env.BLOCKS_AS_JSON === '1'

const sqliteUrl = (url: string | undefined): string => {
  if (!url?.startsWith('file:')) return url ?? ':memory:'

  const file = url.slice('file:'.length)

  return `file:${path.isAbsolute(file) ? file : path.join(dirname, file)}`
}

const databaseAdapter = () => {
  const url = process.env.DATABASE_URI

  if ((process.env.TEST_DB ?? 'sqlite') === 'sqlite') {
    return sqliteAdapter({ blocksAsJSON, client: { url: sqliteUrl(url) }, push: true })
  }

  if (process.env.TEST_DB === 'mongodb') {
    return mongooseAdapter({ ensureIndexes: true, url: url ?? 'mongodb://127.0.0.1/janitor_test' })
  }

  return postgresAdapter({
    blocksAsJSON,
    pool: { connectionString: url ?? 'postgres://postgres:postgres@127.0.0.1:5432/janitor_test' },
    push: true,
  })
}

export default buildConfig({
  admin: {
    importMap: { baseDir: path.resolve(dirname) },
    user: 'users',
    ...(dev
      ? {
          dashboard: {
            defaultLayout: [
              { widgetSlug: 'janitor', width: 'medium' },
              { widgetSlug: 'activity', width: 'medium' },
              { widgetSlug: 'collections', width: 'full' },
            ],
            widgets: [],
          },
        }
      : {}),
  },
  collections: [Users, Media, Files, Simple, Locked, Notices, Posts, Deep, Tags].map(onDisk),
  db: databaseAdapter(),
  editor: lexicalEditor({ features: ({ defaultFeatures }) => [...defaultFeatures, UploadFeature()] }),
  globals: [Settings],
  ...(dev
    ? {
        i18n: { supportedLanguages: { de, en, ru } },
        jobs: { autoRun: [{ cron: '*/10 * * * * *', queue: 'default' }] },
      }
    : {}),
  localization: { defaultLocale: 'en', locales: ['en', 'de'] },
  plugins: [
    janitor({
      collections: dev
        ? { files: true, media: true, tags: true }
        : { files: { prefix: 'files' }, media: { prefix: 'media' } },
      minAge: 0,
      jobs: {},
      storage: dev ? localAdapter({ staticDir: staticDirOf }) : storage,
    }),
  ],
  secret: process.env.PAYLOAD_SECRET ?? 'test-secret',
  telemetry: false,
  typescript: { autoGenerate: false },
})
