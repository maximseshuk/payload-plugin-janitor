import { createElement as h } from 'react'
import { describe, expect, it } from 'vitest'

import { host, render, ui } from '../../../helpers/ui.js'

const { BytesCell, BytesField, CountCell } = await import('@/client/Bytes/Bytes.js')

describe('byte cells', () => {
  it('shows sizes the way people read them', async () => {
    await render(
      h(BytesCell, { cellData: 1_536_000, collectionSlug: 'janitor-findings', field: {} as never, rowData: {} }),
    )

    expect(host.textContent).toBe('1.5 MB')
  })

  it('shows the formatted size as the field value and keeps the stored number', async () => {
    ui.form = { freedBytes: { value: 1_213_517 } }
    await render(h(BytesField, { field: { label: 'Freed', name: 'freedBytes' }, path: 'freedBytes' } as never))

    const input = host.querySelector('input')

    expect(input?.value).toBe('1.2 MB')
    expect(input?.readOnly).toBe(true)
    expect(ui.form.freedBytes?.value).toBe(1_213_517)
  })

  it('leaves a count empty when it does not apply, and shows zero when it is zero', async () => {
    const column = (cellData: unknown) =>
      h(CountCell, { cellData, collectionSlug: 'janitor-runs', field: {} as never, rowData: {} })

    await render(column(undefined))
    expect(host.textContent).toBe('')

    await render(column(null))
    expect(host.textContent).toBe('')

    await render(column(0))
    expect(host.textContent).toBe('0')

    await render(column(12_345))
    expect(host.textContent).toBe('12,345')
  })
})
