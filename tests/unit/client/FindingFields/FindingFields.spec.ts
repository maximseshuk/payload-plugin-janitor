import { createElement as h } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import { calls, host, render, respond, ui } from '../../../helpers/ui.js'

const {
  CollectionCell,
  CollectionField,
  FindingSummary,
  FindingTargetCell,
  FindingUsage,
  StatusDescription,
  StatusField,
} = await import('@/client/FindingFields/FindingFields.js')

describe('finding target', () => {
  beforeEach(() => {
    ui.entities = {
      media: {
        admin: { useAsTitle: 'filename' },
        labels: { singular: 'Media' },
        slug: 'media',
        upload: { displayPreview: true },
      },
      tags: { admin: { useAsTitle: 'name' }, labels: { singular: 'Tag' }, slug: 'tags' },
    }
    respond((url) =>
      url.startsWith('http://localhost:3000/api/tags?')
        ? { body: { docs: [{ id: 12, name: 'news' }] } }
        : url.startsWith('http://localhost:3000/api/media?')
          ? {
              body: {
                docs: [
                  {
                    filename: 'cat.png',
                    id: 7,
                    mimeType: 'image/png',
                    thumbnailURL: '/media/cat-small.png',
                    url: '/media/cat.png',
                  },
                ],
              },
            }
          : undefined,
    )
  })

  const cell = (rowData: Record<string, unknown>) =>
    h(FindingTargetCell, { cellData: undefined, collectionSlug: 'janitor-findings', field: {} as never, rowData })

  it('names a plain document by its title and links to it', async () => {
    await render(cell({ collectionSlug: 'tags', documentId: '12', kind: 'unused', objectKey: 'tags/12' }))

    const link = host.querySelector('a')

    expect(link?.textContent).toBe('news')
    expect(link?.getAttribute('href')).toBe('/admin/collections/tags/12')
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain('ID: 12')
  })

  it('shows the id once when the document has no title', async () => {
    ui.entities.tags = { labels: { singular: 'Tag' }, slug: 'tags' }
    await render(cell({ collectionSlug: 'tags', documentId: '12', kind: 'unused', objectKey: 'tags/12' }))

    expect(host.querySelector('a')?.textContent).toBe('ID: 12')
    expect(host.textContent?.split('ID: 12')).toHaveLength(2)
  })

  it('names the collection of a finding by its label, not its slug', async () => {
    const column = (cellData: string) =>
      h(CollectionCell, { cellData, collectionSlug: 'janitor-findings', field: {} as never, rowData: {} })

    await render(column('tags'))
    expect(host.textContent).toBe('Tag')

    await render(column('removed'))
    expect(host.textContent).toBe('removed')
  })

  it('shows the collection label in the edit view too', async () => {
    ui.form = { collectionSlug: { value: 'tags' } }
    await render(
      h(CollectionField, { field: { label: 'Collection', name: 'collectionSlug' }, path: 'collectionSlug' } as never),
    )

    const input = host.querySelector('input')

    expect(input?.value).toBe('Tag')
    expect(input?.readOnly).toBe(true)
  })

  it('shows a preview for an upload document', async () => {
    await render(cell({ collectionSlug: 'media', documentId: '7', kind: 'unused', objectKey: 'media/cat.png' }))

    expect(host.querySelector('a')?.textContent).toBe('cat.png')
    expect(host.querySelector('img')?.getAttribute('data-thumb')).toBe('/media/cat-small.png')
  })

  it('shows no preview for a file that is missing from storage', async () => {
    await render(cell({ collectionSlug: 'media', documentId: '7', kind: 'missing', objectKey: 'media/cat.png' }))

    expect(host.querySelector('a')?.textContent).toBe('cat.png')
    expect(host.querySelector('img')).toBeNull()
  })

  it('says so when the document is gone', async () => {
    await render(cell({ collectionSlug: 'tags', documentId: '99', kind: 'unused', objectKey: 'tags/99' }))

    expect(host.querySelector('a')).toBeNull()
    expect(host.textContent).toContain('documentGone')
  })

  it('links an orphan only to an http(s) ref and marks the new tab', async () => {
    await render(
      cell({
        collectionSlug: 'media',
        kind: 'orphan',
        objectKey: 'media/lost.png',
        ref: 'https://cdn.example.com/lost.png',
      }),
    )

    const link = host.querySelector('a')

    expect(link?.getAttribute('href')).toBe('https://cdn.example.com/lost.png')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.textContent).toContain('newTab')
    expect(host.querySelector('svg')?.closest('[aria-hidden="true"]')).toBeTruthy()

    await render(
      cell({ collectionSlug: 'media', kind: 'orphan', objectKey: 'media/x.png', ref: 'javascript:alert(1)' }),
    )

    expect(host.querySelector('a')).toBeNull()
  })

  it('batches the lookups of one collection into one request', async () => {
    await render(
      h(
        'div',
        null,
        cell({ collectionSlug: 'tags', documentId: '12', kind: 'unused', objectKey: 'tags/12' }),
        cell({ collectionSlug: 'tags', documentId: '13', kind: 'unused', objectKey: 'tags/13' }),
      ),
    )

    expect(calls.filter((call) => call.url.includes('/api/tags?'))).toHaveLength(1)
  })

  it('lists the references stored at scan time', async () => {
    ui.form = {
      collectionSlug: { value: 'tags' },
      documentId: { value: '12' },
      usage: { value: [{ column: 'tag_id', count: 2, table: '_posts_v', versions: true }] },
    }

    await render(h(FindingUsage, { field: { label: 'Usage', name: 'usage', type: 'json' } as never, path: 'usage' }))

    expect(host.textContent).toContain('snapshot')
    expect(host.querySelector('code')?.textContent).toBe('_posts_v.tag_id')
    expect(host.textContent).toContain('×2')
  })
})

describe('status description', () => {
  it('tells why a missing file cannot be deleted, how deletion works, and nothing once deleted', async () => {
    const description = () => h(StatusDescription, { field: {} as never, path: 'status' } as never)

    ui.form = { kind: { value: 'missing' } }
    await render(description())
    expect(host.textContent).toBe('missingHint')

    ui.form = { kind: { value: 'orphan' } }
    await render(description())
    expect(host.textContent).toBe('statusHint')

    ui.form = { kind: { value: 'orphan' }, status: { value: 'deleted' } }
    await render(description())
    expect(host.textContent).toBe('')
  })
})

describe('status field', () => {
  const options = ['found', 'keep', 'delete', 'deleted'].map((value) => ({ label: value, value }))
  const field = () => h(StatusField, { field: { name: 'status', options }, path: 'status' } as never)
  const choices = () => [...host.querySelectorAll('label')].map((node) => node.textContent)

  it('offers every status but deleted, and only deleted read-only once purged', async () => {
    ui.form = { status: { value: 'keep' } }
    await render(field())
    expect(choices()).toEqual(['found', 'keep', 'delete'])
    expect(host.querySelector('fieldset')?.disabled).toBe(false)

    ui.form = { status: { value: 'deleted' } }
    await render(field())
    expect(choices()).toEqual(['deleted'])
    expect(host.querySelector('fieldset')?.disabled).toBe(true)
  })
})

describe('finding summary', () => {
  const summary = () => h(FindingSummary, { field: {} as never, path: 'summary' } as never)
  const text = () => [...host.querySelectorAll('h3, p')].map((node) => node.textContent)
  const facts = () => [...host.querySelectorAll('dl > div')].map((node) => node.textContent)

  beforeEach(() => {
    ui.entities = {
      media: { labels: { singular: 'Media' }, slug: 'media', upload: {} },
      tags: { labels: { singular: 'Tag' }, slug: 'tags' },
    }
  })

  it('explains each kind of finding in plain words', async () => {
    ui.form = { collectionSlug: { value: 'media' }, kind: { value: 'orphan' }, objectKey: { value: 'a.pdf' } }
    await render(summary())
    expect(text().slice(0, 2)).toEqual(['orphanedFile', 'summaryOrphan{"collection":"Media"}'])

    ui.form = { collectionSlug: { value: 'media' }, documentId: { value: '1' }, kind: { value: 'missing' } }
    await render(summary())
    expect(text().slice(0, 2)).toEqual(['brokenUpload', 'summaryMissing{"collection":"Media"}'])
    expect(host.querySelector('.janitor-summary--danger')).not.toBeNull()

    ui.form = { collectionSlug: { value: 'media' }, documentId: { value: '1' }, kind: { value: 'unused' } }
    await render(summary())
    expect(text().slice(0, 2)).toEqual(['unreferencedDocument', 'summaryUnusedFile{"collection":"Media"}'])

    ui.form = { collectionSlug: { value: 'tags' }, documentId: { value: '2' }, kind: { value: 'unused' } }
    await render(summary())
    expect(text().slice(0, 2)).toEqual(['unreferencedDocument', 'summaryUnused{"collection":"Tag"}'])
  })

  it('shows size, collection and when it was found and deleted', async () => {
    const hour = new Date(Date.now() - 3_600_000).toISOString()

    ui.form = {
      collectionSlug: { value: 'media' },
      createdAt: { value: hour },
      purgedAt: { value: hour },
      kind: { value: 'orphan' },
      size: { value: 1536 },
      status: { value: 'deleted' },
    }
    await render(summary())
    expect(facts()).toEqual(['collectionMedia', 'size1.5 kB', 'createdAt1 hour ago', 'deletedAt1 hour ago'])

    ui.form = { collectionSlug: { value: 'media' }, kind: { value: 'orphan' }, status: { value: 'keep' } }
    await render(summary())
    expect(facts()).toEqual(['collectionMedia'])
  })

  it('renders nothing before the finding loads', async () => {
    await render(summary())
    expect(host.textContent).toBe('')
  })
})
