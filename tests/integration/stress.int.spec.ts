import type { Payload } from 'payload'
import { getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { janitorOptions } from '@/server/run.js'
import { scanStorage } from '@/server/scan.js'
import { buildUsageIndex } from '@/server/usage/index.js'
import type { ResolvedOptions } from '@/shared/types/resolved.js'

import config, { storage } from '../payload.config.js'
import { clear } from '../seed.js'

const SIZE = Number(process.env.STRESS_SIZE ?? 100_000)
const STRAYS = 5
const UNUSED = 3
const BATCH = 5_000

const label = `${process.env.TEST_DB ?? 'sqlite'}, ${SIZE} objects`

let payload: Payload
let options: ResolvedOptions

const filenameOf = (index: number): string => `stress-${index}.txt`

const fill = async (): Promise<(number | string)[]> => {
  const ids: (number | string)[] = []
  const started = Date.now()

  for (let index = 0; index < SIZE; index += 1) {
    const name = filenameOf(index)
    const doc = await payload.create({
      collection: 'media',
      data: { alt: name },
      file: { data: Buffer.from(name), mimetype: 'text/plain', name, size: name.length },
      overrideAccess: true,
    })

    ids.push(doc.id)
    storage.put(`media/${name}`)

    if ((index + 1) % BATCH === 0) report(`${index + 1}/${SIZE} uploads in ${seconds(started)}s`)
  }

  return ids
}

const seconds = (from: number): number => Math.round((Date.now() - from) / 100) / 10

const report = (line: string): void => {
  process.stdout.write(`[stress] ${line}\n`)
}

describe.skipIf(!process.env.STRESS)(`stress on ${label}`, () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    options = janitorOptions(payload)!

    await clear(payload, options)
    storage.objects.clear()

    const ids = await fill()

    await payload.create({
      collection: 'posts',
      data: { body: { used: ids.slice(0, SIZE - UNUSED) }, title: 'stress' },
      overrideAccess: true,
    })

    for (let index = 0; index < STRAYS; index += 1) storage.put(`media/stray-${index}.txt`)
  }, 3_600_000)

  afterAll(async () => {
    await payload.db.destroy?.()
  })

  it('builds the reverse index in one pass', async () => {
    const started = Date.now()
    const index = await buildUsageIndex(payload, { ...options.references, collection: 'media' })

    report(`usage index over ${SIZE} uploads in ${seconds(started)}s`)

    expect(index?.size).toBe(SIZE - UNUSED)
  }, 1_800_000)

  it('scans the whole bucket and reports only the real problems', async () => {
    const started = Date.now()
    const scanned = await scanStorage(payload, options)

    report(`scan of ${scanned.scanned} objects in ${seconds(started)}s`)

    expect([scanned.scanned, scanned.orphans, scanned.missing, scanned.unused]).toEqual([
      SIZE + STRAYS,
      STRAYS,
      0,
      UNUSED,
    ])
  }, 1_800_000)
})
