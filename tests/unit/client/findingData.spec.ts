import { describe, expect, it } from 'vitest'

import { bytesOf, durationOf, isImageKey, kindOf, linkOf, loadDoc, noticeOf, titleOf } from '@/client/findingData.js'
import { translations } from '@/shared/translations/index.js'

describe('finding data', () => {
  it('picks the toast from the answer of a run', () => {
    const ok = { queued: false, started: true }

    expect(noticeOf('scan', 409, { reason: 'already-running' })).toEqual({ key: 'alreadyRunning', level: 'info' })
    expect(noticeOf('scan', 403, {})).toEqual({ key: 'forbidden', level: 'error' })
    expect(noticeOf('scan', 500, { error: 'bucket gone' })).toEqual({
      key: 'runFailedWith',
      level: 'error',
      options: { error: 'bucket gone' },
      runs: true,
    })
    expect(noticeOf('purge', 500, undefined)).toMatchObject({ key: 'runFailed', level: 'error' })
    expect(noticeOf('scan', 200, { ...ok, error: 'late failure' })).toMatchObject({ key: 'runFailedWith' })
    expect(noticeOf('scan', 200, { jobId: 1, queued: true, started: true })).toMatchObject({ key: 'scanQueued' })
    expect(noticeOf('purge', 200, { queued: true, started: true })).toMatchObject({ key: 'purgeQueued' })
    expect(noticeOf('scan', 200, { ...ok, scan: { missing: 1, orphans: 2, unused: 3 } })).toEqual({
      key: 'scanFound',
      level: 'success',
      options: { missing: 1, orphans: 2, unused: 3 },
      runs: true,
    })
    expect(noticeOf('scan', 200, ok)).toMatchObject({ key: 'scanDone', level: 'success' })
    expect(noticeOf('purge', 200, { ...ok, report: { deleted: 1, failed: 1, skipped: 2 } })).toMatchObject({
      key: 'purgePartial',
      level: 'warning',
      options: { count: 3, failed: 1, skipped: 2 },
    })
    expect(noticeOf('purge', 200, { ...ok, report: { deleted: 1, failed: 0, skipped: 0 } })).toMatchObject({
      key: 'purgeDone',
    })
  })

  it('tells how long a run took in the largest fitting unit', () => {
    const start = '2026-01-01T00:00:00.000Z'
    const after = (ms: number) => new Date(Date.parse(start) + ms).toISOString()

    expect(durationOf(start, after(200), 'en')).toBe('1 second')
    expect(durationOf(start, after(42_000), 'en')).toBe('42 seconds')
    expect(durationOf(start, after(150_000), 'en')).toBe('3 minutes')
    expect(durationOf(start, after(3_590_000), 'en')).toBe('1 hour')
    expect(durationOf(start, after(5_400_000), 'en')).toBe('1.5 hours')
    expect(durationOf(start, undefined, 'en')).toBe('')
    expect(durationOf(after(1000), start, 'en')).toBe('')
  })

  it('links only to http and https refs', () => {
    expect(linkOf('https://cdn.example.com/a b.png')).toBe('https://cdn.example.com/a%20b.png')
    expect(linkOf('http://localhost/a.png')).toBe('http://localhost/a.png')
    expect(linkOf('javascript:alert(1)')).toBeUndefined()
    expect(linkOf('s3://bucket/key')).toBeUndefined()
    expect(linkOf('media/a.png')).toBeUndefined()
    expect(linkOf(null)).toBeUndefined()
  })

  it('formats sizes for people', () => {
    expect(bytesOf(0, 'en')).toBe('0 bytes')
    expect(bytesOf(1, 'en')).toBe('1 byte')
    expect(bytesOf(999, 'en')).toBe('999 bytes')
    expect(bytesOf(21, 'ru')).toBe('21 байт')
    expect(bytesOf(10, 'ja')).toBe('10 バイト')
    expect(bytesOf(10, 'rs-latin')).toBe('10 bajtova')
    expect(bytesOf(10, 'rs')).toBe('10 бајтова')
    expect(bytesOf(1_500, 'en')).toBe('1.5 kB')
    expect(bytesOf(2_000_000_000, 'en')).toBe('2 GB')
    expect(bytesOf(1_536_000, 'de')).toBe('1,5 MB')
    expect(bytesOf(undefined, 'en')).toBe('')
    expect(bytesOf(-1, 'en')).toBe('')
  })

  it('formats sizes in every language Payload speaks', () => {
    for (const language of Object.keys(translations)) {
      expect(bytesOf(10, language)).not.toBe('')
      expect(bytesOf(1_500, language)).not.toBe('')
    }
  })

  it('tells a file, a plain document and a bare object apart', () => {
    expect(kindOf({ documentId: '1' }, true)).toBe('file')
    expect(kindOf({ documentId: '1' }, false)).toBe('document')
    expect(kindOf({ kind: 'orphan' }, true)).toBe('object')
    expect(isImageKey('media/cat.PNG')).toBe(true)
    expect(isImageKey('media/report.pdf')).toBe(false)
  })

  it('titles a document by useAsTitle, then by filename', () => {
    expect(titleOf({ id: 1, name: 'news' }, 'name')).toBe('news')
    expect(titleOf({ filename: 'a.png', id: 1, name: ' ' }, 'name')).toBe('a.png')
    expect(titleOf({ id: 1 }, 'name')).toBeUndefined()
    expect(titleOf(null, 'name')).toBeUndefined()
  })

  it('loads documents of one collection in one request and fails them together', async () => {
    const urls: string[] = []
    const ok = (async (url: string) => {
      urls.push(url)

      return new Response(JSON.stringify({ docs: [{ id: 1, name: 'a' }] }))
    }) as typeof fetch

    const [one, two] = await Promise.all([loadDoc('/api/tags', '1', ok), loadDoc('/api/tags', 'a,b&c', ok)])

    expect(one).toEqual({ id: 1, name: 'a' })
    expect(two).toBeNull()
    expect(urls).toEqual(['/api/tags?depth=0&limit=2&where[id][in][0]=1&where[id][in][1]=a%2Cb%26c'])

    const refused = (async () => new Response('{}', { status: 403 })) as typeof fetch

    await expect(loadDoc('/api/tags?trash=true', '3', refused)).rejects.toThrow('403')
  })
})
