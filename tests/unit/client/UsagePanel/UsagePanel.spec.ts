import { createElement as h } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { byText, calls, click, host, render, respond } from '../../../helpers/ui.js'

const { UsagePanel } = await import('@/client/UsagePanel/UsagePanel.js')

describe('usage panel', () => {
  it('opens the version history from the preview', async () => {
    respond((url) =>
      url.includes('/janitor/usage/media/1')
        ? {
            body: {
              supported: true,
              usage: [
                {
                  collection: 'posts',
                  count: 1,
                  fields: ['Cover'],
                  global: false,
                  id: 'p&1',
                  status: 'version',
                  title: 'Old',
                  versionId: 50,
                },
              ],
              used: false,
            },
          }
        : undefined,
    )
    respond((url) => (url.includes('/api/posts/versions') ? { body: { docs: [{ id: 50 }], totalDocs: 1 } } : undefined))

    await render(h(UsagePanel, { endpointsPath: '/janitor' }))

    expect(host.querySelector('[data-drawer]')).toBeNull()

    await click(byText('onlyVersions'))

    expect(host.querySelector('[data-drawer]')?.textContent).toContain('historyHint')
    expect(calls.some((call) => call.url.includes('/api/posts/versions?where[parent][equals]=p%261&'))).toBe(true)

    await click(host.querySelector('[data-drawer] .drawer__header button'))

    expect(host.querySelector('[data-drawer]')?.textContent).not.toContain('historyHint')
    expect(host.querySelector('[data-drawer]')?.textContent).toContain('Old')
  })

  it('says drafts or the trash hold a document, not older versions', async () => {
    respond((url) =>
      url.includes('/janitor/usage/tags/9')
        ? {
            body: {
              supported: true,
              usage: [{ collection: 'posts', fields: ['tag'], id: 3, status: 'draft', title: 'Draft' }],
              used: true,
            },
          }
        : undefined,
    )

    await render(h(UsagePanel, { endpointsPath: '/janitor', collectionSlug: 'tags', id: '9' }))

    expect(host.textContent).toContain('verdictHeldCurrent{"count":1}')
    expect(host.textContent).not.toContain('verdictHeld{')
  })

  it('reads a different document when told to', async () => {
    respond((url) =>
      url.includes('/janitor/usage/tags/a%2F1%3F') ? { body: { supported: true, usage: [], used: false } } : undefined,
    )

    await render(h(UsagePanel, { endpointsPath: '/janitor', collectionSlug: 'tags', id: 'a/1?' }))

    expect(calls.map((call) => call.url)).toContain('http://localhost:3000/api/janitor/usage/tags/a%2F1%3F')
    expect(host.textContent).toContain('verdictNone')
    expect([...host.querySelectorAll('svg')].every((svg) => svg.closest('[aria-hidden="true"]'))).toBe(true)
  })

  it('keeps the field spacing when it sits between other fields', async () => {
    respond((url) =>
      url.includes('/janitor/usage/tags/5') ? { body: { supported: true, usage: [], used: false } } : undefined,
    )

    await render(h(UsagePanel, { endpointsPath: '/janitor', collectionSlug: 'tags', id: '5' }))

    expect(host.firstElementChild?.className).toBe('janitor-usage field-type')
  })

  it('keeps the list in place while it reloads', async () => {
    respond((url) =>
      url.includes('/janitor/usage/tags/7')
        ? {
            body: {
              supported: true,
              usage: [{ collection: 'posts', fields: ['tag'], id: 3, status: 'published', title: 'Kept' }],
              used: true,
            },
          }
        : undefined,
    )

    await render(h(UsagePanel, { endpointsPath: '/janitor', collectionSlug: 'tags', id: '7' }))
    vi.stubGlobal('fetch', () => new Promise(() => undefined))
    await click(host.querySelector('.janitor-usage__header button'))

    const panel = host.querySelector('.janitor-usage')

    expect(panel?.getAttribute('aria-busy')).toBe('true')
    expect(panel?.classList.contains('janitor-usage--refreshing')).toBe(true)
    expect(host.querySelector('.janitor-usage__loading')).toBeNull()
    expect(host.textContent).toContain('Kept')
  })
})
