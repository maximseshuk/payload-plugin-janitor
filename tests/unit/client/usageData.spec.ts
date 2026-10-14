import { describe, expect, it } from 'vitest'

import {
  countsOf,
  fieldsByVersion,
  groupByDocument,
  keep,
  PREVIEW,
  previewSize,
  readUsage,
  stateOf,
  verdictOf,
} from '@/client/usageData.js'

import { hit } from '../../helpers/usage.js'

describe('usage panel data', () => {
  it('reads a successful answer as usage', () => {
    const usage = [hit({})]

    expect(readUsage(true, { supported: true, usage })).toEqual({ usage })
    expect(readUsage(true, { supported: true, usage: [] })).toEqual({ usage: [] })
    expect(readUsage(true, { supported: true, usage, used: true })).toEqual({ usage, used: true })
    expect(readUsage(true, { supported: true, usage: [], used: false })).toEqual({ usage: [], used: false })
    expect(readUsage(true, { supported: true, usage: [], used: 'no' })).toEqual({ usage: [] })
  })

  it('calls a document safe only when the server says it is unused', () => {
    const version = hit({ status: 'version', versionId: 10 })

    expect(verdictOf([], false)).toEqual({ count: 0, kind: 'none' })
    expect(verdictOf([version], false)).toEqual({ count: 0, kind: 'history' })
    expect(verdictOf([version], true)).toEqual({ count: 1, kind: 'held' })
    expect(verdictOf([], undefined)).toEqual({ count: 0, kind: 'held' })
    expect(verdictOf([version], undefined)).toEqual({ count: 1, kind: 'held' })
  })

  it('holds a document used by drafts or trashed referrers, whatever the server says, but never calls it live', () => {
    const trashed = hit({ id: 2, status: 'trashed' })
    const draft = hit({ id: 3, status: 'draft' })

    expect(verdictOf([trashed, hit({ status: 'version' })], true)).toEqual({ count: 1, kind: 'current' })
    expect(verdictOf([trashed], false)).toEqual({ count: 1, kind: 'current' })
    expect(verdictOf([draft, trashed], false)).toEqual({ count: 2, kind: 'current' })
  })

  it('counts in the live verdict exactly what the live badge counts', () => {
    const hits = [
      hit({}),
      hit({ id: 2, status: 'published' }),
      hit({ id: 3, status: 'draft' }),
      hit({ id: 4, status: 'trashed' }),
      hit({ id: 5, status: 'version' }),
    ]

    expect(verdictOf(hits, true)).toEqual({ count: 2, kind: 'live' })
    expect(countsOf(hits).find((entry) => entry.key === 'live')?.count).toBe(2)
  })

  it('never reads a refused request as «safe to delete»', () => {
    expect(readUsage(false, { usage: [] })).toEqual({ error: 'failed' })
    expect(readUsage(false, { errors: [{ message: 'Forbidden' }] })).toEqual({ error: 'failed' })
    expect(readUsage(false, undefined)).toEqual({ error: 'failed' })
  })

  it('tells an unsupported database apart from a failed request', () => {
    expect(readUsage(true, { supported: false, usage: [] })).toEqual({ error: 'unsupported' })
  })

  it('treats an answer without a usage list as a failure', () => {
    expect(readUsage(true, {})).toEqual({ error: 'failed' })
    expect(readUsage(true, null)).toEqual({ error: 'failed' })
    expect(readUsage(true, { usage: 'none' })).toEqual({ error: 'failed' })
  })

  it('previews `limit` documents, or the default when the limit is 0', () => {
    expect(previewSize(0)).toBe(PREVIEW)
    expect(previewSize(5)).toBe(5)
  })

  it('groups places by document and folds old versions under the live one', () => {
    const groups = groupByDocument([
      hit({ id: 1, status: 'version', updatedAt: '2026-01-01', versionId: 10 }),
      hit({ id: 1, status: 'published' }),
      hit({ id: 1, status: 'version', updatedAt: '2026-02-01', versionId: 11 }),
      hit({ id: 2, status: 'trashed' }),
    ])

    expect(groups.map((group) => [group.first.id, group.first.status, group.places.length])).toEqual([
      [1, 'published', 2],
      [2, 'trashed', 1],
    ])
    expect(groups[0]!.places[1]!.revisions?.map((place) => place.versionId)).toEqual([11, 10])
    expect([...fieldsByVersion(groups[0]!.places).keys()]).toEqual(['11', '10'])
  })

  it('counts and filters by state', () => {
    const hits = [hit({ status: 'published' }), hit({ id: 2, status: 'draft' }), hit({ id: 3, status: 'version' })]

    expect(countsOf(hits).map((entry) => [entry.key, entry.count])).toEqual([
      ['all', 3],
      ['live', 1],
      ['draft', 1],
      ['version', 1],
    ])
    expect(keep(hits, 'live')).toHaveLength(1)
    expect(keep(hits, 'version')).toHaveLength(1)
  })

  it('names the state of a document from its places', () => {
    expect(stateOf([hit({ status: 'version' })])).toBe('gone')
    expect(stateOf([hit({ status: 'draft' }), hit({ status: 'published' })])).toBe('live')
    expect(stateOf([hit({ status: 'trashed' })])).toBe('trashed')
  })
})
