import { getTranslation } from '@payloadcms/translations'
import type { Field, PayloadRequest } from 'payload'

import { blocksOf, type Library } from './candidates.js'

type FieldPath = {
  anchor: string
  label: string
  path: string
}

export type EntityPaths = {
  columns: Map<string, FieldPath>
  dots: Map<string, FieldPath>
  localized: Set<string>
  rels: Map<string, FieldPath>
}

type FieldList = Field[]

const snake = (name: string): string => name.replace(/([A-Z])/g, '_$1').toLowerCase()

const titleCase = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/^./, (first) => first.toUpperCase())

export type I18n = PayloadRequest['i18n']

type Labelled = { label?: unknown; name?: string }

const textOf = (label: unknown, i18n?: I18n): unknown => {
  if (typeof label === 'string' || !label) return label
  if (i18n) return getTranslation(label as never, i18n)
  if (typeof label !== 'object') return undefined

  const byLanguage = label as Record<string, unknown>

  return byLanguage.en ?? Object.values(byLanguage)[0]
}

export const labelOf = (field: Labelled, i18n?: I18n): string => {
  const text = textOf(field.label, i18n)

  return typeof text === 'string' && text ? text : titleCase(field.name ?? '')
}

type Scope = {
  anchor?: string
  columns: string[]
  labels: string[]
  path: string[]
  table: string
}

const nested = (scope: Scope, part: string, label: string, name: string): Scope => ({
  anchor: scope.anchor ?? [...scope.path, name].join('.'),
  columns: [],
  labels: [...scope.labels, label],
  path: [...scope.path, name],
  table: `${scope.table}_${part}`,
})

const isReference = (field: Field): boolean => field.type === 'relationship' || field.type === 'upload'

const usesRels = (field: Field): boolean => {
  const value = field as { hasMany?: boolean; relationTo?: string | string[] }

  return Boolean(value.hasMany) || Array.isArray(value.relationTo)
}

const walk = (fields: FieldList, scope: Scope, into: EntityPaths, library: Library, i18n?: I18n): void => {
  for (const field of fields) {
    const name = 'name' in field ? field.name : undefined
    const label = labelOf(field as Labelled, i18n)

    if (name && (field as { localized?: boolean }).localized) into.localized.add([...scope.path, name].join('.'))

    if (isReference(field) && name) {
      const path = [...scope.path, name].join('.')
      const entry: FieldPath = {
        anchor: scope.anchor ?? path,
        label: [...scope.labels, label].join(' › '),
        path,
      }

      into.dots.set(entry.path, entry)

      if (usesRels(field)) into.rels.set(entry.path, entry)
      else into.columns.set(`${scope.table}|${[...scope.columns, snake(name)].join('_')}_id`, entry)

      continue
    }

    if ((field.type === 'json' || field.type === 'richText' || field.type === 'blocks') && name) {
      const path = [...scope.path, name].join('.')
      const entry: FieldPath = {
        anchor: scope.anchor ?? path,
        label: [...scope.labels, label].join(' › '),
        path,
      }

      into.columns.set(`${scope.table}|${[...scope.columns, snake(name)].join('_')}`, entry)
      into.dots.set(entry.path, entry)
    }

    if (field.type === 'array' && name) {
      walk(field.fields, nested(scope, [...scope.columns, snake(name)].join('_'), label, name), into, library, i18n)
      continue
    }

    if (field.type === 'blocks' && name) {
      for (const block of blocksOf(field, library)) {
        if (!block) continue

        walk(
          block.fields,
          { ...nested(scope, `blocks_${snake(block.slug)}`, label, name), table: `_blocks_${snake(block.slug)}` },
          into,
          library,
          i18n,
        )
      }

      continue
    }

    if (field.type === 'group' && name) {
      walk(
        field.fields,
        {
          ...scope,
          columns: [...scope.columns, snake(name)],
          labels: [...scope.labels, label],
          path: [...scope.path, name],
        },
        into,
        library,
        i18n,
      )
      continue
    }

    if (field.type === 'tabs') {
      for (const tab of field.tabs) {
        const tabName = 'name' in tab ? tab.name : undefined

        walk(
          tab.fields,
          tabName
            ? {
                ...scope,
                columns: [...scope.columns, snake(tabName)],
                labels: [...scope.labels, labelOf(tab as Labelled, i18n)],
                path: [...scope.path, tabName],
              }
            : scope,
          into,
          library,
          i18n,
        )
      }

      continue
    }

    if ('fields' in field && Array.isArray(field.fields)) walk(field.fields, scope, into, library, i18n)
  }
}

export const entityPaths = (fields: FieldList, library: Library, i18n?: I18n): EntityPaths => {
  const paths: EntityPaths = { columns: new Map(), dots: new Map(), localized: new Set(), rels: new Map() }

  walk(fields, { columns: [], labels: [], path: [], table: '' }, paths, library, i18n)

  return paths
}

export type Place = { anchor?: string; field: string; path?: string }

export const placeOf = (paths: EntityPaths | undefined, parts: string[]): Place => {
  for (let end = parts.length; end > 0; end -= 1) {
    const known = paths?.dots.get(parts.slice(0, end).join('.'))

    if (!known) continue

    const rest = parts.slice(end)
    const tail = rest.length === 1 && rest[0] === 'value' ? [] : rest

    return { anchor: known.anchor, field: tail.length ? `${known.label} › ${tail.join('.')}` : known.label }
  }

  const [first, ...rest] = parts

  return { field: rest.length ? `${first} › ${rest.join('.')}` : (first ?? '') }
}
