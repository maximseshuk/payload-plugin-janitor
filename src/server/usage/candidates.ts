import type { Field } from 'payload'

export type SchemaCandidates = {
  fields: Set<string>
  kind: 'collection' | 'global'
  slug: string
}

type FieldList = Field[]

type Block = { fields: FieldList; slug: string }

export type Library = Map<string, Block>

type SchemaSource = {
  blocks?: Block[]
  collections?: { fields: FieldList; slug: string }[]
  globals?: { fields: FieldList; slug: string }[]
}

const relatesTo = (field: Field, target: string): boolean => {
  if (field.type !== 'relationship' && field.type !== 'upload') return false

  const relationTo = (field as { relationTo: string | string[] }).relationTo

  return Array.isArray(relationTo) ? relationTo.includes(target) : relationTo === target
}

export const blocksOf = (field: Field, library: Library): (Block | undefined)[] => {
  if (field.type !== 'blocks') return []

  const blocks = (field.blocks ?? []) as (Block | string)[]

  return blocks.map((block) => (typeof block === 'string' ? library.get(block) : block))
}

export const libraryOf = (config: Pick<SchemaSource, 'blocks'>): Library =>
  new Map((config.blocks ?? []).map((block) => [block.slug, block]))

const childFields = (field: Field, library: Library): FieldList | undefined => {
  if (field.type === 'blocks') {
    const blocks = blocksOf(field, library)

    return blocks.every(Boolean) ? blocks.flatMap((block) => block!.fields) : undefined
  }

  if (field.type === 'tabs') return field.tabs.flatMap((tab) => tab.fields)
  if ('fields' in field && Array.isArray(field.fields)) return field.fields

  return []
}

const isDocumentLike = (field: Field): boolean => field.type === 'json' || field.type === 'richText'

const nameOf = (field: Field): string | undefined => ('name' in field ? field.name : undefined)

const collect = (fields: FieldList, target: string, into: Set<string>, library: Library, top?: string): boolean => {
  let referencing = false

  for (const field of fields) {
    const name = nameOf(field) ?? top
    const key = top ?? nameOf(field)

    if (relatesTo(field, target)) {
      referencing = true
      if (key) into.add(key)
      continue
    }

    if (isDocumentLike(field)) {
      referencing = true
      if (key) into.add(key)
      continue
    }

    if (field.type === 'tabs') {
      for (const tab of field.tabs) {
        const scope = top ?? ('name' in tab ? tab.name : undefined)

        if (collect(tab.fields, target, into, library, scope)) referencing = true
      }

      continue
    }

    const children = childFields(field, library)

    if (!children) {
      referencing = true
      if (key) into.add(key)
      continue
    }

    if (children.length && collect(children, target, into, library, key ?? name)) referencing = true
  }

  return referencing
}

const hasKey = (fields: FieldList, target: string, library: Library, blocksAsJSON: boolean): boolean =>
  fields.some((field) => {
    if (relatesTo(field, target)) return !(field as { virtual?: unknown }).virtual
    if (field.type === 'blocks' && blocksAsJSON) return false

    return hasKey(childFields(field, library) ?? [], target, library, blocksAsJSON)
  })

export const expectsKeys = (config: SchemaSource, target: string, blocksAsJSON: boolean): boolean => {
  const library = libraryOf(config)

  return [...(config.collections ?? []), ...(config.globals ?? [])].some((entity) =>
    hasKey(entity.fields, target, library, blocksAsJSON),
  )
}

export const schemaCandidates = (config: SchemaSource, target: string): Map<string, SchemaCandidates> => {
  const result = new Map<string, SchemaCandidates>()
  const library = libraryOf(config)

  const add = (slug: string, fields: FieldList, kind: 'collection' | 'global'): void => {
    const names = new Set<string>()
    const referencing = collect(fields, target, names, library)

    if (!referencing) return

    result.set(slug, { fields: names, kind, slug })
  }

  for (const collection of config.collections ?? []) add(collection.slug, collection.fields, 'collection')
  for (const global of config.globals ?? []) add(global.slug, global.fields, 'global')

  return result
}
