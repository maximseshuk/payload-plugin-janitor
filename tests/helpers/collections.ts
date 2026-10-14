import type { CollectionConfig, Config, Field } from 'payload'

export const media: CollectionConfig = {
  slug: 'media',
  fields: [{ name: 'alt', type: 'text' }],
  upload: true,
  versions: false,
}
const tags: CollectionConfig = { slug: 'tags', fields: [{ name: 'name', type: 'text' }], versions: false }
const tenants: CollectionConfig = { slug: 'tenants', fields: [{ name: 'name', type: 'text' }], versions: false }
export const config = { collections: [media, tags, tenants] } as unknown as Config

const flat = (fields: Field[]): Field[] =>
  fields.flatMap((field) => ('fields' in field && !('name' in field) ? flat(field.fields) : [field]))
export const fieldOf = (collection: CollectionConfig, name: string) =>
  flat(collection.fields).find((field) => 'name' in field && field.name === name) as Record<string, unknown>
