import { Window } from 'happy-dom'

export const window = new Window({ url: 'http://localhost:3000/admin' })

const KEYS = [
  'CustomEvent',
  'document',
  'Element',
  'Event',
  'getComputedStyle',
  'HTMLElement',
  'MouseEvent',
  'navigator',
  'Node',
  'SVGElement',
  'Text',
] as const

for (const key of KEYS) {
  const value = window[key as keyof Window]

  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: typeof value === 'function' && key === 'getComputedStyle' ? value.bind(window) : value,
    writable: true,
  })
}

Object.defineProperty(globalThis, 'window', { configurable: true, value: window, writable: true })
Object.assign(globalThis, {
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 16),
})
