import type { UsageHit } from '@/shared/types/index.js'

export type Place = { revisions?: Place[] } & UsageHit

export type Filter = 'all' | 'draft' | 'live' | 'trashed' | 'version'

export type Group = { first: Place; places: Place[] }

export type Translate = (key: string, options?: Record<string, unknown>) => string

export const BASE = 'janitor-usage'

export const PREVIEW = 3

export const previewSize = (limit: number): number => (limit > 0 ? limit : PREVIEW)

export const readUsage = (
  ok: boolean,
  body: unknown,
): { error: 'failed' | 'unsupported' } | { usage: UsageHit[]; used?: boolean } => {
  const { supported, usage, used } = (body ?? {}) as { supported?: boolean; usage?: unknown; used?: unknown }

  if (!ok) return { error: 'failed' }
  if (supported === false) return { error: 'unsupported' }
  if (!Array.isArray(usage)) return { error: 'failed' }

  return typeof used === 'boolean' ? { usage: usage as UsageHit[], used } : { usage: usage as UsageHit[] }
}

export const isLive = (hit: UsageHit): boolean => hit.status === 'published'

export type Verdict = { count: number; kind: 'current' | 'held' | 'history' | 'live' | 'none' }

export const verdictOf = (usage: UsageHit[], used: boolean | undefined): Verdict => {
  const live = usage.filter(isLive).length
  const current = usage.filter((hit) => hit.status !== 'version').length

  if (live > 0) return { count: live, kind: 'live' }
  if (current > 0) return { count: current, kind: 'current' }
  if (used !== false) return { count: usage.length, kind: 'held' }

  return { count: 0, kind: usage.length > 0 ? 'history' : 'none' }
}

const RANK: Record<UsageHit['status'], number> = { published: 0, draft: 1, version: 2, trashed: 3 }

const newestFirst = (a: UsageHit, b: UsageHit): number =>
  RANK[a.status] - RANK[b.status] || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')

const foldVersions = (places: UsageHit[]): Place[] => {
  const folded: Place[] = []
  const versions = new Map<string, UsageHit[]>()

  for (const place of places) {
    if (place.status !== 'version') {
      folded.push(place)
      continue
    }

    const key = place.fields.join(', ')

    versions.set(key, [...(versions.get(key) ?? []), place])
  }

  for (const group of versions.values()) {
    const sorted = group.toSorted(newestFirst)
    const [newest] = sorted

    if (newest) folded.push({ ...newest, revisions: sorted })
  }

  return folded.toSorted(newestFirst)
}

export const groupByDocument = (hits: UsageHit[]): Group[] => {
  const documents = new Map<string, UsageHit[]>()

  for (const hit of hits) {
    const key = `${hit.collection}:${hit.id}`

    documents.set(key, [...(documents.get(key) ?? []), hit])
  }

  return [...documents.values()]
    .map((places) => foldVersions(places))
    .filter((places) => places.length > 0)
    .map((places) => ({ first: places[0] as Place, places }))
    .toSorted((a, b) => RANK[a.first.status] - RANK[b.first.status])
}

export const countsOf = (
  hits: UsageHit[],
): { count: number; key: Filter; style: 'dark' | 'error' | 'light-gray' | 'success' | 'warning' }[] =>
  [
    { count: hits.length, key: 'all' as const, style: 'light-gray' as const },
    { count: hits.filter(isLive).length, key: 'live' as const, style: 'success' as const },
    { count: hits.filter((hit) => hit.status === 'draft').length, key: 'draft' as const, style: 'warning' as const },
    {
      count: hits.filter((hit) => hit.status === 'version').length,
      key: 'version' as const,
      style: 'dark' as const,
    },
    { count: hits.filter((hit) => hit.status === 'trashed').length, key: 'trashed' as const, style: 'error' as const },
  ].filter((entry) => entry.count > 0)

export const keep = (hits: UsageHit[], filter: Filter): UsageHit[] => {
  if (filter === 'all') return hits
  if (filter === 'live') return hits.filter(isLive)

  return hits.filter((hit) => hit.status === filter)
}

export const dateOf = (value: string | undefined, language: string): string =>
  value ? new Date(value).toLocaleDateString(language, { day: 'numeric', month: 'short', year: 'numeric' }) : ''

export const timeOf = (value: string | undefined, language: string): string =>
  value
    ? new Date(value).toLocaleString(language, {
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        month: 'short',
        second: '2-digit',
      })
    : ''

export const fieldsByVersion = (places: Place[]): Map<string, string[]> => {
  const byVersion = new Map<string, string[]>()

  for (const place of places.flatMap((entry) => [entry, ...(entry.revisions ?? [])])) {
    if (place.versionId === undefined) continue
    const key = String(place.versionId)
    const fields = byVersion.get(key) ?? []
    byVersion.set(key, [...fields, ...place.fields.filter((field) => !fields.includes(field))])
  }

  return byVersion
}

export const stateOf = (places: Place[]): 'draft' | 'gone' | 'live' | 'trashed' => {
  if (places.some((place) => place.status === 'trashed')) return 'trashed'
  if (places.some((place) => place.status === 'published')) return 'live'
  if (places.some((place) => place.status === 'draft')) return 'draft'

  return 'gone'
}

export const STATE_STYLE = {
  draft: 'warning',
  gone: 'light-gray',
  live: 'success',
  trashed: 'error',
} as const
