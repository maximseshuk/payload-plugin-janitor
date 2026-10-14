import { createElement as h } from 'react'
import { describe, expect, it } from 'vitest'

import { byText, calls, click, host, type Reply, render, respond, ui } from '../../../helpers/ui.js'

const { JanitorMenu, PURGE_MODAL } = await import('@/client/JanitorMenu/JanitorMenu.js')

describe('janitor menu', () => {
  const menu = () =>
    h(JanitorMenu, { endpointsPath: '/janitor', findingsSlug: 'janitor-findings', runsSlug: 'janitor-runs' })

  it('asks before deleting and shows how many findings go', async () => {
    let approved = 3

    respond((url) =>
      url.includes('/count')
        ? { body: { totalDocs: url.includes('[kind][not_equals]=missing') ? approved : approved + 2 } }
        : undefined,
    )
    respond((url, init) =>
      url.endsWith('/janitor/purge') && init?.method === 'POST'
        ? { body: { queued: false, report: { deleted: 3, failed: 0, skipped: 0 }, started: true } }
        : undefined,
    )

    await render(menu())

    const purge = byText('purge')

    expect(purge?.textContent).toBe('purge (3)')
    expect(purge?.disabled).toBe(false)

    await click(purge)

    expect(calls.some((call) => call.method === 'POST')).toBe(false)
    expect(host.querySelector('[role=dialog]')?.textContent).toContain('purgeConfirm{"count":3,"status":"toDelete"}')

    approved = 0
    await click(host.querySelector('[data-confirm]'))

    expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual([
      'http://localhost:3000/api/janitor/purge',
    ])
    expect(ui.toast.success).toHaveBeenCalledWith('purgeDone', expect.objectContaining({ action: expect.anything() }))
    expect(ui.refresh).toHaveBeenCalled()
    expect(byText('purge')?.disabled).toBe(true)
  })

  it('refuses to open the confirmation when nothing is approved', async () => {
    let approved = 2

    respond((url) => (url.includes('/count') ? { body: { totalDocs: approved } } : undefined))

    await render(menu())
    approved = 0
    await click(byText('purge'))

    expect(ui.open.has(PURGE_MODAL)).toBe(false)
    expect(ui.toast.info).toHaveBeenCalledWith('purgeNothing{"status":"toDelete"}')
  })

  it('shows scan counts and the server error text', async () => {
    let answer: Reply = { body: { queued: false, scan: { missing: 1, orphans: 2, unused: 3 }, started: true } }

    respond((url) => (url.includes('/count') ? { body: { totalDocs: 0 } } : undefined))
    respond((url) => (url.endsWith('/janitor/scan') ? answer : undefined))

    await render(menu())
    await click(byText('scan'))

    expect(ui.toast.success).toHaveBeenCalledWith(
      'scanFound{"missing":1,"orphans":2,"unused":3}',
      expect.objectContaining({ action: expect.objectContaining({ label: 'openRuns' }) }),
    )

    const action = ui.toast.success.mock.calls[0]![1] as { action: { onClick: () => void } }

    action.action.onClick()
    expect(ui.push).toHaveBeenCalledWith('/admin/collections/janitor-runs?sort=-startedAt')

    answer = { body: { error: 'bucket unreachable', queued: false, started: false }, status: 500 }
    await click(byText('scan'))

    expect(ui.toast.error).toHaveBeenCalledWith('runFailedWith{"error":"bucket unreachable"}', expect.anything())
  })

  it('sets any status on the selected findings, skipping deleted ones, and shows the server message', async () => {
    const sent: { body: unknown; url: string }[] = []
    let answer: Reply = {
      body: { docs: [{}, {}], errors: [], message: 'Updated 2 Janitor findings successfully.' },
    }

    ui.selection = [1, 2]
    respond((url) => (url.includes('/count') ? { body: { totalDocs: 0 } } : undefined))
    respond((url, init) => {
      if (init?.method !== 'PATCH') return undefined
      sent.push({ body: JSON.parse(String(init.body)), url: decodeURIComponent(url) })

      return answer
    })

    await render(menu())
    await click(byText('markSelected{"status":"keep"} (2)'))

    expect(sent).toEqual([
      {
        body: { status: 'keep' },
        url: 'http://localhost:3000/api/janitor-findings?where={"and":[{"status":{"not_equals":"deleted"}},{"id":{"in":[1,2]}}]}&depth=0',
      },
    ])
    expect(ui.toast.success).toHaveBeenCalledWith('Updated 2 Janitor findings successfully.')
    expect(ui.refresh).toHaveBeenCalled()

    answer = { body: { docs: [], errors: [{ message: 'denied' }], message: 'Unable to update 2 out of 2.' } }
    await click(byText('markSelected{"status":"toDelete"} (2)'))

    expect(sent[1]?.body).toEqual({ status: 'delete' })
    expect(ui.toast.error).toHaveBeenCalledWith('Unable to update 2 out of 2.')
    await click(byText('markSelected{"status":"undecided"} (2)'))

    expect(sent[2]?.body).toEqual({ status: 'found' })
  })

  it('offers the selection actions only with a selection and update access', async () => {
    await render(menu())

    expect(byText('markSelected')).toBeUndefined()

    ui.selection = [1]
    ui.permissions = { collections: { 'janitor-findings': { read: true } } }
    await render(menu())

    expect(byText('markSelected')).toBeUndefined()
  })

  it('hides scan and purge from a user who may not read runs, and keeps the undecided findings link', async () => {
    ui.permissions = { collections: { 'janitor-findings': { read: true, update: true } } }
    await render(menu())

    expect(byText('scan')).toBeUndefined()
    expect(byText('purge')).toBeUndefined()
    expect(host.querySelector('a')?.getAttribute('href')).toContain('/admin/collections/janitor-findings?')
  })

  it('links to the undecided findings for bulk review', async () => {
    await render(menu())

    expect(host.querySelector('a')?.getAttribute('href')).toBe(
      '/admin/collections/janitor-findings?where[or][0][and][0][status][equals]=found',
    )
  })
})
