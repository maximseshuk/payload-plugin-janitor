'use client'

import React, { useEffect } from 'react'

const SHOWN = 2600
const WAIT = 15000
const STEP = 100
const SETTLE = 500

const token = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

const mark = (id: string): (() => void) => {
  if (!document.getElementById(id)) return () => {}

  const ring = document.createElement('div')

  ring.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'z-index:100',
    `border-radius:${token('--radius-medium')}`,
    `outline:1px solid ${token('--color-border-warning')}`,
    'outline-offset:6px',
    `box-shadow:0 0 0 6px ${token('--color-bg-warning-tertiary')}`,
  ].join(';')
  document.body.append(ring)

  let frame = 0

  const done = () => {
    cancelAnimationFrame(frame)
    ring.remove()
  }

  const follow = () => {
    const field = document.getElementById(id)

    if (!field) return done()

    const box = field.getBoundingClientRect()

    ring.style.height = `${box.height}px`
    ring.style.left = `${box.left}px`
    ring.style.top = `${box.top}px`
    ring.style.width = `${box.width}px`
    frame = requestAnimationFrame(follow)
  }

  follow()

  if (typeof ring.animate !== 'function') {
    setTimeout(done, SHOWN)

    return done
  }

  const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const fade = ring.animate(
    [
      { offset: 0, opacity: 1 },
      { offset: still ? 1 : 0.6, opacity: 1 },
      { offset: 1, opacity: 0 },
    ],
    { duration: SHOWN, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  )

  fade.onfinish = done

  return done
}

const TAB = '.tabs-field__tab-button'
const OPEN = 'tabs-field__tab-button--active'
const FOLDED = '.collapsible--collapsed'
const UNFOLD = '.collapsible__toggle--collapsed'

const ROUNDS = 4
const PATIENCE = 600
const RETRIES = 2

const all = (selector: string): Element[] => {
  try {
    return [...document.querySelectorAll(selector)]
  } catch {
    return []
  }
}

const unfold = (field?: HTMLElement): boolean => {
  const folded = field ? all(FOLDED).filter((section) => section.contains(field)) : all(FOLDED)

  for (const section of folded) section.querySelector<HTMLElement>(UNFOLD)?.click()

  return folded.length > 0
}

const openNextTab = (tried: Set<Element>): boolean => {
  const closed = all(TAB).filter((tab) => !tab.classList.contains(OPEN) && !tried.has(tab))
  const next = closed[0]

  if (!next) return false

  tried.add(next)
  if (next instanceof HTMLElement) next.click()

  return true
}

export const FieldHighlight: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let clearMark = () => {}

    const find = (tries = 0) => {
      clearTimeout(timer)

      const id = window.location.hash.slice(1)

      if (!id.startsWith('field-')) return

      const started = Date.now()
      const tried = new Set<Element>()
      const wasOpen = all(`${TAB}.${OPEN}`)[0]
      let rounds = 0
      let restored = false
      let waitUntil = 0

      const look = () => {
        const field = document.getElementById(id)

        if (!field) {
          const unfolded = rounds < ROUNDS && unfold()

          if (unfolded) rounds += 1
          else if (Date.now() >= waitUntil) {
            if (openNextTab(tried)) waitUntil = Date.now() + PATIENCE
            else if (tried.size > 0 && !restored) {
              restored = true
              if (wasOpen instanceof HTMLElement) wasOpen.click()
            }
          }

          if (Date.now() - started < WAIT) timer = setTimeout(look, STEP)

          return
        }

        const bring = () =>
          (document.getElementById(id) ?? field).scrollIntoView({ behavior: 'smooth', block: 'center' })

        const show = () => {
          bring()
          clearMark()
          clearMark = mark(id)

          timer = setTimeout(() => {
            if (document.getElementById(id)) bring()
            else if (tries < RETRIES) find(tries + 1)
          }, SETTLE)
        }

        if (unfold(field)) timer = setTimeout(show, STEP * 2)
        else show()
      }

      look()
    }

    const again = () => find()

    find()
    window.addEventListener('hashchange', again)

    return () => {
      clearTimeout(timer)
      clearMark()
      window.removeEventListener('hashchange', again)
    }
  }, [])

  return <>{children}</>
}
