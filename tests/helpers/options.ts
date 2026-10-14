import type { Config } from 'payload'

import type { StorageAdapter } from '@/shared/types/storage.js'

const media = {
  slug: 'media',
  fields: [
    { name: 'prefix', type: 'text', defaultValue: '/uploads/media/' },
    { name: 'alt', type: 'text' },
  ],
  upload: true,
}

export const config = {
  collections: [
    media,
    { slug: 'files', fields: [], trash: true, upload: true },
    { slug: 'tags', fields: [{ name: 'name', type: 'text' }] },
    { slug: 'tenants', fields: [{ name: 'name', type: 'text' }] },
  ],
} as unknown as Config

export const store = (): StorageAdapter => ({ delete: async () => {}, list: async function* () {} })
