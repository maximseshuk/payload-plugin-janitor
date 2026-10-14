import type { Payload } from 'payload'

import type { UsageRef } from '@/shared/types/index.js'

import type { SchemaCandidates } from './candidates.js'
import {
  type Catalog,
  catalogOf,
  type Column,
  entityOf,
  isDocument,
  isText,
  isVersionTable,
  type Key,
  mayHold,
  type Suffixes,
  type Tables,
} from './catalog.js'
import type { RawHit } from './hits.js'
import { type EntityPaths, type Place, placeOf } from './paths.js'
import { type Context, type Dialect, placeholder, quote, type Row, run, tableName } from './sql.js'
import { parseJson, UNREADABLE, walkIds } from './walk.js'

const PAGE_SIZE = 500

const MAX_CHAIN = 8

const OWNED = ['_texts', '_numbers']

const POSTGRES_IDS: Record<string, RegExp> = {
  bigint: /^-?\d{1,18}$/,
  'character varying': /^/,
  integer: /^-?\d{1,9}$/,
  numeric: /^-?\d{1,30}(\.\d{1,30})?$/,
  text: /^/,
  uuid: /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i,
}

type Chain = { joins: Column[]; root: string; versioned: boolean }

type Layout = { links: Map<string, Column>; own: string; suffixes: Suffixes; types: Catalog['types'] }

type Source = { chain: Chain; from: string; live: string; self?: string }

type Versions = 'unused' | 'used'

export type Lookup = {
  candidates: Map<string, SchemaCandidates>
  context?: Context
  dialect: Dialect
  expectsKeys: boolean
  ignored: string[]
  table: string
  tables: Tables
  text: boolean
}

type Progress = () => Promise<void> | void

type Scan = Lookup & { detail?: boolean; id?: string; ids?: Set<string>; onProgress?: Progress }

type Match = { chain: Chain; count: number; id: string; live: boolean; path?: string; row: Row; target: Column }

const isStructural = (key: Key, suffixes: Suffixes): boolean =>
  key.column === '_parent_id' ||
  (key.column === 'parent_id' &&
    (key.table === `_${key.parent}${suffixes.versions}` ||
      [suffixes.relationships, ...OWNED].some((suffix) => key.table === `${key.parent}${suffix}`)))

const chainOf = (table: string, { links, suffixes }: Layout): Chain => {
  const joins: Column[] = []
  let current = table

  while (joins.length < MAX_CHAIN && !isVersionTable(current, suffixes)) {
    const link = links.get(current)

    if (!link) break

    joins.push(link)
    current = link.table
  }

  return { joins, root: current, versioned: isVersionTable(current, suffixes) }
}

const rootAlias = (chain: Chain): string => (chain.joins.length ? 'r' : 't0')

const joinClause = (payload: Payload, dialect: Dialect, chain: Chain): string =>
  chain.joins
    .map((link, index) => {
      const alias = index === chain.joins.length - 1 ? 'r' : `t${index + 1}`

      return `LEFT JOIN ${tableName(payload, dialect, link.table)} ${alias} ON t${index}.${quote(link.column)} = ${alias}.${quote('id')}`
    })
    .join(' ')

const isOwnVersion = (chain: Chain, layout: Layout): boolean =>
  chain.versioned && layout.links.get(chain.root)?.table === layout.own

const sourceOf = (payload: Payload, dialect: Dialect, target: Column, layout: Layout): Source => {
  const chain = chainOf(target.table, layout)
  const root = rootAlias(chain)
  const latest = layout.types.get(chain.root)?.has('latest') ? ` OR ${root}.${quote('latest')}` : ''
  const live = chain.versioned ? `CASE WHEN ${root}.${quote('id')} IS NULL${latest} THEN 1 ELSE 0 END` : '1'
  const self =
    chain.root === layout.own
      ? `${root}.${quote('id')}`
      : isOwnVersion(chain, layout)
        ? `${root}.${quote('parent_id')}`
        : undefined

  return {
    chain,
    from: `${tableName(payload, dialect, target.table)} t0 ${joinClause(payload, dialect, chain)}`,
    live,
    self,
  }
}

const notSelf = (source: Source, column: string): string =>
  source.self
    ? ` AND (${source.self} IS NULL OR CAST(t0.${quote(column)} AS TEXT) <> CAST(${source.self} AS TEXT))`
    : ''

const keyOf = (column: Column): string => `${column.table}|${column.column}`

const isLive = (row: Row): boolean => Number(row.live) === 1

const EXTRAS = ['parent_id', 'latest', 'autosave', 'version__status', '_status', 'deleted_at', 'updated_at']

const detailList = (
  payload: Payload,
  dialect: Dialect,
  chain: Chain,
  target: Column,
  { suffixes, types }: Layout,
): string => {
  const root = types.get(chain.root) ?? new Map<string, string>()
  const own = types.get(target.table) ?? new Map<string, string>()
  const alias = rootAlias(chain)
  const list: [string, string][] = []

  for (const column of ['id', ...EXTRAS]) {
    if (root.has(column)) list.push([column === 'id' ? 'doc_id' : column, `${alias}.${quote(column)}`])
  }

  const locales = `${chain.root}${suffixes.locales}`
  const status = ['version__status', '_status'].find((column) => !root.has(column) && types.get(locales)?.has(column))

  if (status) {
    list.push([
      status,
      `(SELECT MIN(l.${quote(status)}) FROM ${tableName(payload, dialect, locales)} l WHERE l.${quote('_parent_id')} = ${alias}.${quote('id')})`,
    ])
  }

  const path = ['_path', 'path'].find((column) => own.has(column))

  if (path) list.push(['field_path', `t0.${quote(path)}`])
  const locale = own.has('_locale')
    ? '_locale'
    : target.table.endsWith(suffixes.relationships) && own.has('locale')
      ? 'locale'
      : ''

  if (locale) list.push(['locale', `t0.${quote(locale)}`])

  return list.map(([name, expression]) => `, ${expression} AS ${quote(name)}`).join('')
}

const compare = (dialect: Dialect, target: Column, id: string): string => {
  const column = `t0.${quote(target.column)}`
  const direct = dialect === 'sqlite' || POSTGRES_IDS[target.type ?? '']?.test(id)

  return `${direct ? column : `CAST(${column} AS TEXT)`} = ${placeholder(dialect, 1)}`
}

const LONG = '[0-9]'.repeat(7)

const isEscaped = (char: string): boolean => char === '"' || char === '\\' || char < ' '

const verbatim = (id: string): boolean => {
  const number = Number(id)

  if (id.trim() && String(number) === id) return Number.isSafeInteger(number)

  return ![...id].some(isEscaped)
}

const prefilter = (dialect: Dialect, target: Column, index: number): string => {
  const text = `CAST(t0.${quote(target.column)} AS TEXT)`
  const at = placeholder(dialect, index)

  return dialect === 'postgres'
    ? ` AND (strpos(${text}, ${at}) > 0 OR ${text} ~ '[0-9]{7}\\.|\\.[0-9]{7}')`
    : ` AND (instr(${text}, ${at}) > 0 OR instr(${text}, '\\') > 0 OR ${text} GLOB '*[0-9][eE]*' OR ${text} GLOB '*${LONG}.*' OR ${text} GLOB '*.${LONG}*' OR typeof(t0.${quote(target.column)}) = 'blob')`
}

const eachDocumentRow = async (
  payload: Payload,
  args: Scan,
  target: Column,
  source: Source,
  layout: Layout,
  handle: (row: Row) => void,
): Promise<void> => {
  const { dialect } = args
  const column = `t0.${quote(target.column)}`
  const key =
    dialect === 'sqlite' ? 't0.rowid' : layout.types.get(target.table)?.has('id') ? `t0.${quote('id')}` : undefined
  const value =
    dialect === 'postgres'
      ? `${column}::text`
      : `CASE WHEN typeof(${column}) = 'blob' THEN ${column} ELSE CAST(${column} AS TEXT) END`
  const self = source.self ? `, ${source.self} AS self` : ''
  const detail = args.detail ? detailList(payload, dialect, source.chain, target, layout) : ''
  const needle =
    args.id !== undefined && (dialect === 'sqlite' || target.type === 'jsonb') && verbatim(args.id)
      ? args.id
      : undefined
  const filter = needle === undefined ? '' : prefilter(dialect, target, 1)
  let last: unknown

  for (;;) {
    const values = [...(needle === undefined ? [] : [needle]), ...(last === undefined ? [] : [last])]
    const after = last === undefined ? '' : ` AND ${key} > ${placeholder(dialect, values.length)}`
    const rows = await run(
      payload,
      `SELECT ${value} AS value, ${source.live} AS live, ${key ?? 'NULL'} AS k${self}${detail} FROM ${source.from}
       WHERE ${column} IS NOT NULL${filter}${after}${key ? ` ORDER BY ${key} LIMIT ${PAGE_SIZE}` : ''}`,
      values,
      args.context,
    )

    for (const row of rows) handle(row)

    await args.onProgress?.()

    if (!key || rows.length < PAGE_SIZE) return
    last = rows[rows.length - 1]!.k
  }
}

const eachMatch = async (payload: Payload, args: Scan, visit: (match: Match) => void): Promise<boolean> => {
  const { dialect } = args
  const catalog = await catalogOf(payload, dialect, args.context)
  const links = new Map<string, Column>()
  const structural = new Set<string>()

  for (const key of catalog.keys) {
    if (!isStructural(key, args.tables.suffixes)) continue

    links.set(key.table, { column: key.column, table: key.parent })
    structural.add(keyOf(key))
  }

  const layout: Layout = { links, own: args.table, suffixes: args.tables.suffixes, types: catalog.types }
  const relations = catalog.keys
    .filter((key) => key.parent === args.table && (key.key ?? 'id') === 'id' && !structural.has(keyOf(key)))
    .map((key) => ({ ...key, type: catalog.types.get(key.table)?.get(key.column) }))

  if (args.expectsKeys && !relations.length) {
    throw new Error(
      `janitor: fields point at "${args.table}" but no foreign key to it is visible; refusing to call anything unused`,
    )
  }

  const slugs = new Set(args.ignored)
  const ignored = (column: Column): boolean =>
    column.column === '_parent_id' ||
    slugs.has(column.table) ||
    slugs.has(entityOf(column.table, args.tables)?.slug ?? '')
  const related = new Set(relations.map(keyOf))
  const texts = args.text
    ? catalog.columns.filter(
        (column) => isText(dialect, column) && !related.has(keyOf(column)) && !structural.has(keyOf(column)),
      )
    : []
  const wanted = args.id === undefined ? (args.ids ?? new Set<string>()) : new Set([args.id])
  let complete = true

  for (const target of [...relations, ...texts]) {
    if (ignored(target)) continue

    const source = sourceOf(payload, dialect, target, layout)
    const column = `t0.${quote(target.column)}`
    const detail = args.detail ? detailList(payload, dialect, source.chain, target, layout) : ''
    const point = args.id !== undefined
    const rows = await run(
      payload,
      point
        ? `SELECT ${source.live} AS live, ${detail ? '1' : 'COUNT(*)'} AS count${detail} FROM ${source.from}
           WHERE ${compare(dialect, target, args.id!)}${notSelf(source, target.column)}${detail ? '' : ' GROUP BY 1'}`
        : `SELECT CAST(${column} AS TEXT) AS id, ${source.live} AS live, COUNT(*) AS count FROM ${source.from}
           WHERE ${column} IS NOT NULL${notSelf(source, target.column)} GROUP BY 1, 2`,
      point ? [args.id] : [],
      args.context,
    )
    const keyed = related.has(keyOf(target))

    await args.onProgress?.()

    for (const row of rows) {
      const id = point ? args.id! : String(row.id)

      if (!keyed && !wanted.has(id)) continue

      visit({ chain: source.chain, count: Number(row.count), id, live: isLive(row), row, target })
    }
  }

  for (const target of catalog.columns) {
    if (!isDocument(dialect, target) || ignored(target) || !mayHold(target, args.candidates, args.tables)) continue

    const source = sourceOf(payload, dialect, target, layout)

    await eachDocumentRow(payload, args, target, source, layout, (row) => {
      const parsed = parseJson(row.value)

      if (parsed === undefined) return

      const self = row.self === null || row.self === undefined ? undefined : String(row.self)
      const found = new Map<string, Match>()
      const add = (id: string, path?: string): void => {
        const match = found.get(`${id}|${path ?? ''}`)

        if (match) match.count += 1
        else
          found.set(`${id}|${path ?? ''}`, { chain: source.chain, count: 1, id, live: isLive(row), path, row, target })
      }

      const whole =
        parsed !== UNREADABLE &&
        walkIds(parsed, (id, path) => {
          if (id !== self && wanted.has(id)) add(id, path)
        })

      if (!whole) {
        if (args.id === undefined) complete = false
        else if (args.id !== self) add(args.id)
      }

      for (const match of found.values()) visit(match)
    })
  }

  return complete
}

type Tally = [live: number, old: number]

const refsOf = (table: string, column: string, [live, old]: Tally, versions: Versions): UsageRef[] => {
  if (versions === 'used') return live + old ? [{ column, count: live + old, table }] : []

  const refs: UsageRef[] = []

  if (live) refs.push({ column, count: live, table })
  if (old) refs.push({ column, count: old, table, versions: true })

  return refs
}

const indexOf = async (
  payload: Payload,
  args: Scan & { versions: Versions },
): Promise<Map<string, UsageRef[]> | null> => {
  const tallies = new Map<string, Map<string, [Column, Tally]>>()
  const complete = await eachMatch(payload, args, (match) => {
    const byColumn = tallies.get(match.id) ?? new Map<string, [Column, Tally]>()
    const column = {
      column: match.path ? `${match.target.column}.${match.path}` : match.target.column,
      table: match.target.table,
    }
    const entry = byColumn.get(keyOf(column)) ?? [column, [0, 0]]

    entry[1][match.live ? 0 : 1] += match.count
    byColumn.set(keyOf(column), entry)
    tallies.set(match.id, byColumn)
  })

  if (!complete) return null

  const index = new Map<string, UsageRef[]>()

  for (const [id, byColumn] of tallies) {
    const refs = [...byColumn.values()].flatMap(([column, tally]) =>
      refsOf(column.table, column.column, tally, args.versions),
    )

    if (refs.length) index.set(id, refs)
  }

  return index
}

export const findUsageRelational = async (
  payload: Payload,
  args: Lookup & { id: string; versions: Versions },
): Promise<UsageRef[]> => (await indexOf(payload, args))?.get(args.id) ?? []

export const buildUsageIndexRelational = (
  payload: Payload,
  args: Lookup & { ids: Set<string>; onProgress?: Progress; versions: Versions },
): Promise<Map<string, UsageRef[]> | null> => indexOf(payload, args)

const named = (entry: { anchor: string; label: string; path: string }): Place => ({
  anchor: entry.anchor,
  field: entry.label,
  path: entry.path,
})

const fieldOfColumn = (
  target: Column,
  chain: Chain,
  row: Row,
  paths: EntityPaths | undefined,
  suffixes: Suffixes,
): Place => {
  const rels = typeof row.field_path === 'string' ? row.field_path.replace(/\.\d+/g, '') : undefined
  const known = rels ? paths?.rels.get(rels) : undefined

  if (known) return named(known)

  const nested = (target.table.startsWith(chain.root) ? target.table.slice(chain.root.length) : '').replace(
    /^_version_/,
    '_',
  )
  const suffix = nested.endsWith(suffixes.locales) ? nested.slice(0, -suffixes.locales.length) : nested
  const column = String(target.column).replace(/^version_/, '')
  const entry = paths?.columns.get(`${suffix}|${column}`)

  if (entry) return named(entry)

  return {
    field: [suffix.replace(/^_/, ''), column.replace(/_id$/, '')].filter(Boolean).join(' › ').replaceAll('_', ' '),
  }
}

const flag = (value: unknown): boolean => value === true || value === 1

const hitOf = (row: Row, entity: string, field: Place, versioned: boolean): RawHit => ({
  anchor: field.anchor,
  autosave: flag(row.autosave),
  documentId: (versioned ? (row.parent_id as number | string) : (row.doc_id as number | string)) ?? undefined,
  entity,
  field: field.field,
  latest: flag(row.latest),
  locale: typeof row.locale === 'string' ? row.locale : undefined,
  status: typeof row.version__status === 'string' ? row.version__status : (row._status as string | undefined),
  trashed: Boolean(row.deleted_at),
  updatedAt: typeof row.updated_at === 'string' ? row.updated_at : undefined,
  versionId: versioned ? ((row.doc_id as number | string) ?? undefined) : undefined,
})

export const collectRelational = async (
  payload: Payload,
  args: Lookup & { id: string; paths: Map<string, EntityPaths> },
): Promise<RawHit[]> => {
  const hits: RawHit[] = []

  await eachMatch(payload, { ...args, detail: true }, ({ chain, path, row, target }) => {
    const slug = entityOf(chain.root, args.tables)?.slug
    const found = fieldOfColumn(target, chain, row, slug ? args.paths.get(slug) : undefined, args.tables.suffixes)
    const field = !path
      ? found
      : found.path
        ? placeOf(slug ? args.paths.get(slug) : undefined, [...found.path.split('.'), ...path.split('.')])
        : { anchor: found.anchor, field: `${found.field} › ${path}` }

    hits.push(hitOf(row, slug ?? chain.root, field, chain.versioned))
  })

  return hits
}
