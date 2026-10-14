import '../../../helpers/dom.js'
import { act, createElement as h, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { window } from '../../../helpers/dom.js'
import { host, render, root as current } from '../../../helpers/ui.js'

const { FieldHighlight } = await import('@/client/FieldHighlight/FieldHighlight.js')

let root: Root

beforeEach(() => {
  root = current
})

describe('field highlight', () => {
  it('finds the field without Payload tab classes or the animation API', async () => {
    const field = window.document.createElement('div')
    const scrolled = vi.fn()

    field.id = 'field-cover'
    field.scrollIntoView = scrolled
    window.document.body.append(field)
    Object.defineProperty(window.HTMLElement.prototype, 'animate', { configurable: true, value: undefined })
    window.location.hash = '#field-cover'

    await render(h(FieldHighlight, null, 'child'))

    expect(host.textContent).toBe('child')
    expect(scrolled).toHaveBeenCalled()

    field.remove()
    window.location.hash = ''
  })

  it('leaves one frame under StrictMode and none once unmounted', async () => {
    const field = window.document.createElement('div')
    const frames = () =>
      [...window.document.body.querySelectorAll('div')].filter((div) => div.style.position === 'fixed')

    field.id = 'field-hero'
    field.scrollIntoView = vi.fn()
    window.document.body.append(field)
    Object.defineProperty(window.HTMLElement.prototype, 'animate', { configurable: true, value: undefined })
    window.location.hash = '#field-hero'

    await render(h(StrictMode, null, h(FieldHighlight, null, 'child')))

    expect(frames()).toHaveLength(1)

    await act(async () => {
      root.unmount()
    })

    expect(frames()).toHaveLength(0)

    root = createRoot(host)
    field.remove()
    window.location.hash = ''
  })
})
