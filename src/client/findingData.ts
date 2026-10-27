import type { JanitorMode, StartResult } from '@/shared/types/index.js'

export type Finding = {
  collectionSlug?: null | string
  documentId?: null | string
  kind?: 'missing' | 'orphan' | 'unused' | null
  objectKey?: null | string
  ref?: null | string
}

export type Doc = Record<string, unknown> & { id: number | string }

export type Notice = {
  key: string
  level: 'error' | 'info' | 'success' | 'warning'
  options?: Record<string, unknown>
  runs?: boolean
}

export const UNDECIDED = 'where[or][0][and][0][status][equals]=found'

export const noticeOf = (mode: JanitorMode, status: number, body: unknown): Notice => {
  const result = (body ?? {}) as Partial<StartResult>

  if (status === 409) return { key: 'alreadyRunning', level: 'info' }
  if (status === 401 || status === 403) return { key: 'forbidden', level: 'error' }

  if (status < 200 || status >= 300 || result.error) {
    return typeof result.error === 'string' && result.error.trim()
      ? { key: 'runFailedWith', level: 'error', options: { error: result.error }, runs: true }
      : { key: 'runFailed', level: 'error', runs: true }
  }

  if (result.queued) return { key: mode === 'scan' ? 'scanQueued' : 'purgeQueued', level: 'info', runs: true }

  if (mode === 'purge') {
    const { failed = 0, skipped = 0 } = result.report ?? {}

    return failed + skipped > 0
      ? { key: 'purgePartial', level: 'warning', options: { count: failed + skipped, failed, skipped }, runs: true }
      : { key: 'purgeDone', level: 'success', runs: true }
  }

  return result.scan
    ? { key: 'scanFound', level: 'success', options: { ...result.scan }, runs: true }
    : { key: 'scanDone', level: 'success', runs: true }
}

export const linkOf = (ref: null | string | undefined): string | undefined => {
  if (!ref) return undefined

  try {
    const url = new URL(ref)

    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

const IMAGE = /\.(avif|gif|jpe?g|png|svg|webp)$/i

export const isImageKey = (key: null | string | undefined): boolean => Boolean(key && IMAGE.test(key))

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const

const LOCALES: Record<string, string> = { rs: 'sr-Cyrl', 'rs-latin': 'sr-Latn' }

export const localeOf = (language: string): string => {
  try {
    return Intl.getCanonicalLocales(LOCALES[language] ?? language)[0] ?? 'en'
  } catch {
    return 'en'
  }
}

export const bytesOf = (value: unknown, language: string): string => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return ''

  const step = Math.min(Math.floor(Math.log(Math.max(value, 1)) / Math.log(1000)), UNITS.length - 1)

  return new Intl.NumberFormat(localeOf(language), {
    maximumFractionDigits: step === 0 ? 0 : 1,
    style: 'unit',
    unit: UNITS[step],
    unitDisplay: step === 0 ? 'long' : 'short',
  }).format(value / 1000 ** step)
}

const SPANS = [
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
  ['month', 12],
  ['year', Infinity],
] as const

export const agoOf = (value: unknown, language: string, now: number = Date.now()): string => {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN

  if (Number.isNaN(time)) return ''

  let amount = Math.max(0, Math.round((now - time) / 60_000))

  for (const [unit, size] of SPANS) {
    if (amount < size) {
      return new Intl.RelativeTimeFormat(localeOf(language), { numeric: 'auto' }).format(-amount, unit)
    }

    amount = Math.round(amount / size)
  }

  return ''
}

export const durationOf = (start: unknown, end: unknown, language: string): string => {
  const ms = typeof start === 'string' && typeof end === 'string' ? Date.parse(end) - Date.parse(start) : Number.NaN

  if (!Number.isFinite(ms) || ms < 0) return ''

  const seconds = Math.max(1, Math.round(ms / 1000))
  const minutes = Math.round(seconds / 60)
  const [amount, unit] =
    seconds < 60 ? [seconds, 'second'] : minutes < 60 ? [minutes, 'minute'] : [seconds / 3600, 'hour']

  return new Intl.NumberFormat(localeOf(language), {
    maximumFractionDigits: 1,
    style: 'unit',
    unit,
    unitDisplay: 'long',
  }).format(amount)
}

export const titleOf = (doc: Doc | null | undefined, useAsTitle: string | undefined): string | undefined => {
  const value = doc && useAsTitle ? doc[useAsTitle] : undefined

  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number') return String(value)

  const filename = doc?.filename

  return typeof filename === 'string' && filename ? filename : undefined
}

export const kindOf = (finding: Finding, upload: boolean): 'document' | 'file' | 'object' => {
  if (!finding.documentId) return 'object'

  return upload ? 'file' : 'document'
}

type Waiter = { id: string; reject: (error: unknown) => void; resolve: (doc: Doc | null) => void }

const queues = new Map<string, Waiter[]>()

const flush = async (url: string, fetcher: typeof fetch): Promise<void> => {
  const waiters = queues.get(url) ?? []

  queues.delete(url)

  const ids = [...new Set(waiters.map((waiter) => waiter.id))]
  const query = `depth=0&limit=${ids.length}&${ids.map((id, index) => `where[id][in][${index}]=${encodeURIComponent(id)}`).join('&')}`

  try {
    const response = await fetcher(`${url}${url.includes('?') ? '&' : '?'}${query}`, { credentials: 'include' })

    if (!response.ok) throw new Error(String(response.status))

    const body = (await response.json()) as { docs?: Doc[] }
    const found = new Map((body.docs ?? []).map((doc) => [String(doc.id), doc]))

    for (const waiter of waiters) waiter.resolve(found.get(waiter.id) ?? null)
  } catch (error) {
    for (const waiter of waiters) waiter.reject(error)
  }
}

export const loadDoc = (url: string, id: string, fetcher: typeof fetch = fetch): Promise<Doc | null> =>
  new Promise((resolve, reject) => {
    const queue = queues.get(url)

    if (queue) {
      queue.push({ id, reject, resolve })

      return
    }

    queues.set(url, [{ id, reject, resolve }])
    setTimeout(() => void flush(url, fetcher), 0)
  })
