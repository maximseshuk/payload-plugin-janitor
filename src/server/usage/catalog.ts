import type { Payload } from 'payload'

import type { SchemaCandidates } from './candidates.js'
import type { Context, Dialect } from './sql.js'
import { run, schemaOf } from './sql.js'

export type Column = { column: string; table: string; type?: string }
export type Owner = { nested: boolean; slug: string }
export type Key = Column & { key: null | string; parent: string }
export type Catalog = { columns: Column[]; keys: Key[]; types: Map<string, Map<string, string>> }

const separated = /[\W_]+(.|$)/g

const spaced = (text: string): string => text.replace(separated, (_match, next: string) => (next ? ` ${next}` : ''))

const snake = (slug: string): string => {
  const plain = /\s/.test(slug)
    ? slug
    : /[_\-.:]/.test(slug)
      ? spaced(slug) || slug
      : /[a-z][A-Z]|[A-Z][a-z]/.test(slug)
        ? slug.replace(/(.)([A-Z]+)/g, (_match, previous: string, uppers: string) =>
            [previous, ...uppers.toLowerCase()].join(' '),
          )
        : slug

  return spaced(plain.toLowerCase()).trim().replace(/\s/g, '_')
}

const tableNames = (payload: Payload): Map<string, string> =>
  (payload.db as unknown as { tableNameMap?: Map<string, string> }).tableNameMap ?? new Map<string, string>()

export const tableFor = (payload: Payload, slug: string): string => tableNames(payload).get(snake(slug)) ?? snake(slug)

export type Suffixes = { locales: string; relationships: string; versions: string }

export type Tables = {
  aliases: Map<string, string>
  entities: Map<string, string>
  fields: Map<string, string[]>
  suffixes: Suffixes
}

const suffixesOf = (payload: Payload): Suffixes => {
  const db = payload.db as unknown as Partial<Record<`${keyof Suffixes}Suffix`, string>>

  return {
    locales: db.localesSuffix || '_locales',
    relationships: db.relationshipsSuffix || '_rels',
    versions: db.versionsSuffix || '_v',
  }
}

export const isVersionTable = (table: string, suffixes: Suffixes): boolean =>
  table.startsWith('_') && table.endsWith(suffixes.versions) && table.length > suffixes.versions.length + 1

const strip = (table: string, suffix: string): string =>
  table.endsWith(suffix) && table.length > suffix.length ? table.slice(0, -suffix.length) : table

export const tablesOf = (payload: Payload): Tables => {
  const entities = [...payload.config.collections, ...payload.config.globals]

  return {
    aliases: new Map([...tableNames(payload)].map(([name, table]) => [table, name])),
    entities: new Map(entities.map((entity) => [tableFor(payload, entity.slug), entity.slug])),
    fields: new Map(
      entities.map((entity) => [
        entity.slug,
        entity.flattenedFields.flatMap((field) => ('name' in field ? [columnOf(field.name)] : [])),
      ]),
    ),
    suffixes: suffixesOf(payload),
  }
}

const POSTGRES_COLUMNS = `SELECT c.relname AS "table", a.attname AS "column",
  CASE WHEN t.typtype = 'e' THEN 'enum' ELSE format_type(a.atttypid, NULL) END AS "type"
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid
  WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY 1, 2`

const POSTGRES_KEYS = `SELECT c.relname AS "table", a.attname AS "column", p.relname AS "parent", pa.attname AS "key"
  FROM pg_constraint k
  JOIN pg_class c ON c.oid = k.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_class p ON p.oid = k.confrelid
  JOIN pg_namespace pn ON pn.oid = p.relnamespace
  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
  JOIN pg_attribute pa ON pa.attrelid = k.confrelid AND pa.attnum = k.confkey[1]
  WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1 AND n.nspname = $1 AND pn.nspname = $1
  ORDER BY 1, 2`

const SQLITE_COLUMNS = `SELECT m.name AS "table", c.name AS "column", LOWER(c.type) AS "type"
  FROM sqlite_master m JOIN pragma_table_info(m.name) c
  WHERE m.type = 'table'
  ORDER BY 1, 2`

const SQLITE_KEYS = `SELECT m.name AS "table", f."from" AS "column", f."table" AS "parent", f."to" AS "key"
  FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
  WHERE m.type = 'table'
  ORDER BY 1, 2`

const catalogs = new WeakMap<object, Catalog>()

export const catalogOf = async (payload: Payload, dialect: Dialect, context?: Context): Promise<Catalog> => {
  const cached = catalogs.get(payload.config)

  if (cached) return cached

  const args = dialect === 'postgres' ? [schemaOf(payload)] : []
  const postgres = dialect === 'postgres'
  const columns = (await run(payload, postgres ? POSTGRES_COLUMNS : SQLITE_COLUMNS, args, context)) as Column[]
  const keys = (await run(payload, postgres ? POSTGRES_KEYS : SQLITE_KEYS, args, context)) as Key[]
  const types = new Map<string, Map<string, string>>()

  for (const { column, table, type } of columns) {
    const map = types.get(table) ?? new Map<string, string>()

    map.set(column, type ?? '')
    types.set(table, map)
  }

  const catalog = { columns, keys, types }

  catalogs.set(payload.config, catalog)

  return catalog
}

export const isDocument = (dialect: Dialect, { type = '' }: Column): boolean =>
  dialect === 'postgres' ? type === 'json' || type === 'jsonb' : ['blob', 'json', 'text'].includes(type)

export const isText = (dialect: Dialect, { column, type = '' }: Column): boolean =>
  column !== 'id' && (dialect === 'postgres' ? ['character varying', 'enum', 'text'].includes(type) : type === 'text')

const ownerOf = (table: string, tables: Tables): Owner | undefined => {
  const { entities, suffixes } = tables
  const local = strip(table, suffixes.locales)
  const bare = (isVersionTable(local, suffixes) ? strip(local, suffixes.versions) : local).replace(/^_/, '')
  let best: string | undefined

  for (const name of entities.keys()) {
    if (bare !== name && !bare.startsWith(`${name}_`)) continue
    if (!best || name.length > best.length) best = name
  }

  const slug = best && entities.get(best)

  return slug ? { nested: bare !== best, slug } : undefined
}

export const entityOf = (table: string, tables: Tables): Owner | undefined => {
  const alias = tables.aliases.get(table)

  return ownerOf(table, tables) ?? (alias ? ownerOf(alias, tables) : undefined)
}

const columnOf = (field: string): string => `${field.startsWith('_') ? '_' : ''}${snake(field)}`

const producedBy = (name: string, field: string): boolean => name === field || name.startsWith(`${field}_`)

const holds = (owner: Owner, column: Column, candidates: Map<string, SchemaCandidates>, tables: Tables): boolean => {
  const name = column.column.replace(/^version_/, '')

  if (!owner.nested && !(tables.fields.get(owner.slug) ?? []).some((field) => producedBy(name, field))) return true

  const candidate = candidates.get(owner.slug)

  if (!candidate) return false
  if (owner.nested) return true

  return [...candidate.fields].some((field) => producedBy(name, columnOf(field)))
}

const known = (table: string, tables: Tables): boolean =>
  tables.aliases.has(table) ||
  tables.aliases.has(strip(table, tables.suffixes.relationships)) ||
  tables.aliases.has(strip(table, tables.suffixes.locales))

export const mayHold = (column: Column, candidates: Map<string, SchemaCandidates>, tables: Tables): boolean => {
  if (!known(column.table, tables)) return true

  const owner = ownerOf(column.table, tables)
  const alias = tables.aliases.get(column.table)
  const aliased = alias ? ownerOf(alias, tables) : undefined

  return (
    !owner || holds(owner, column, candidates, tables) || Boolean(aliased && holds(aliased, column, candidates, tables))
  )
}
