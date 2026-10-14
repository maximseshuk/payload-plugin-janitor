import './dom.js'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, vi } from 'vitest'

import { window } from './dom.js'

export const ui = {
  entities: {} as Record<string, unknown>,
  form: {} as Record<string, { value: unknown }>,
  open: new Set<string>(),
  permissions: { collections: { 'janitor-findings': { update: true }, 'janitor-runs': { read: true } } } as unknown,
  push: vi.fn(),
  refresh: vi.fn(),
  selection: [] as (number | string)[],
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}

vi.mock('next/navigation.js', () => ({ useRouter: () => ({ push: ui.push, refresh: ui.refresh }) }))

vi.mock('@payloadcms/ui/shared', () => ({ mergeFieldStyles: () => ({}) }))

vi.mock('@payloadcms/ui', async () => {
  const { createElement, useReducer } = await import('react')
  const t = (key: string, options?: Record<string, unknown>) =>
    `${key.split(':').at(-1)}${options ? JSON.stringify(options) : ''}`
  const config = {
    collections: [],
    routes: { admin: '/admin', api: '/api' },
    serverURL: 'http://localhost:3000',
  }
  const listeners = new Set<() => void>()
  const openModal = (slug: string) => {
    ui.open.add(slug)
    for (const listener of listeners) listener()
  }
  const useModal = () => {
    const [, rerender] = useReducer((count: number) => count + 1, 0)

    listeners.add(rerender)

    return {
      closeModal: (slug: string) => ui.open.delete(slug),
      modalState: Object.fromEntries([...ui.open].map((slug) => [slug, { isOpen: true }])),
      openModal,
    }
  }
  const passthrough = ({ children }: { children?: unknown }) => createElement('div', null, children as never)
  const icon = () => createElement('svg')

  return {
    Banner: passthrough,
    Button: ({ children, onClick }: { children?: unknown; onClick?: () => void }) =>
      createElement('button', { onClick, type: 'button' }, children as never),
    ChevronIcon: icon,
    DocumentIcon: icon,
    ConfirmationModal: ({
      body,
      heading,
      modalSlug,
      onConfirm,
    }: {
      body: unknown
      heading: unknown
      modalSlug: string
      onConfirm: () => Promise<void>
    }) => {
      useModal()

      return ui.open.has(modalSlug)
        ? createElement(
            'div',
            { role: 'dialog' },
            createElement('h1', null, heading as never),
            createElement('p', null, body as never),
            createElement('button', { 'data-confirm': true, onClick: () => void onConfirm(), type: 'button' }, 'ok'),
          )
        : null
    },
    Drawer: ({ children, slug }: { children?: unknown; slug: string }) => {
      useModal()

      return ui.open.has(slug) ? createElement('div', { 'data-drawer': slug }, children as never) : null
    },
    DrawerContentContainer: passthrough,
    DrawerToggler: passthrough,
    ExternalLinkIcon: icon,
    FieldDescription: ({ description }: { description: string }) => createElement('p', null, description),
    FieldLabel: ({ label }: { label?: unknown }) => createElement('label', null, String(label ?? '')),
    fieldBaseClass: 'field-type',
    Link: ({ children, href }: { children?: unknown; href: string }) => createElement('a', { href }, children as never),
    LinkIcon: icon,
    Pill: passthrough,
    PopupList: {
      Button: ({
        children,
        disabled,
        href,
        onClick,
      }: {
        children?: unknown
        disabled?: boolean
        href?: string
        onClick?: () => void
      }) =>
        href
          ? createElement('a', { href }, children as never)
          : createElement('button', { disabled, onClick, type: 'button' }, children as never),
    },
    RadioGroupField: ({ field, readOnly }: { field: { options: { value: string }[] }; readOnly?: boolean }) =>
      createElement(
        'fieldset',
        { disabled: readOnly },
        field.options.map((option) => createElement('label', { key: option.value }, option.value)),
      ),
    ShimmerEffect: () => null,
    Table: ({
      columns,
      data,
    }: {
      columns: { accessor: string; Heading: unknown; renderedCells: unknown[] }[]
      data: unknown[]
    }) =>
      createElement(
        'table',
        null,
        createElement(
          'tbody',
          null,
          data.map((_, row) =>
            createElement(
              'tr',
              { key: row },
              columns.map((column) =>
                createElement('td', { key: column.accessor }, column.renderedCells[row] as never),
              ),
            ),
          ),
        ),
      ),
    TextInput: ({ label, readOnly, value }: { label?: unknown; readOnly?: boolean; value?: string }) =>
      createElement('input', { 'aria-label': String(label ?? ''), readOnly, value }),
    Thumbnail: ({ fileSrc }: { fileSrc?: string }) => createElement('img', { 'data-thumb': fileSrc ?? '' }),
    toast: ui.toast,
    useAuth: () => ({ permissions: ui.permissions }),
    useConfig: () => ({
      config,
      getEntityConfig: ({ collectionSlug }: { collectionSlug: string }) => ui.entities[collectionSlug],
    }),
    useDocumentInfo: () => ({ collectionSlug: 'media', id: 1 }),
    useDrawerSlug: (slug: string) => slug,
    useField: ({ path }: { path: string }) => ({ value: ui.form[path]?.value }),
    useFormFields: (selector: (context: [typeof ui.form]) => unknown) => selector([ui.form]),
    useListQuery: () => ({ data: undefined }),
    useModal,
    useSelection: () => ({
      count: ui.selection.length,
      getQueryParams: (where?: unknown) => `?where=${JSON.stringify({ and: [where, { id: { in: ui.selection } }] })}`,
    }),
    useTranslation: () => ({ i18n: { language: 'en' }, t }),
    XIcon: icon,
  }
})

export type Reply = { body: unknown; status?: number }

let replies: ((url: string, init?: RequestInit) => Reply | undefined)[] = []
export let calls: { method: string; url: string }[] = []
export let root: Root
export let host: HTMLElement

export const respond = (handler: (url: string, init?: RequestInit) => Reply | undefined) => replies.push(handler)

export const render = async (node: ReactNode): Promise<HTMLElement> => {
  await act(async () => {
    root.render(node)
  })
  await settle()

  return host
}

const settle = async (): Promise<void> => {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

export const click = async (element: Element | null | undefined): Promise<void> => {
  expect(element).toBeTruthy()
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await settle()
}

const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll('button')] as HTMLButtonElement[]
export const byText = (text: string) => buttons().find((button) => button.textContent?.includes(text))

beforeEach(() => {
  replies = []
  calls = []
  ui.open.clear()
  ui.permissions = { collections: { 'janitor-findings': { update: true }, 'janitor-runs': { read: true } } }
  ui.selection = []
  ui.form = {}
  ui.entities = {}
  vi.clearAllMocks()
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url })

    for (const handler of replies) {
      const reply = handler(url, init)

      if (reply) return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 })
    }

    return new Response('{}', { status: 404 })
  })
  host = window.document.createElement('div') as unknown as HTMLElement
  window.document.body.append(host as never)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
