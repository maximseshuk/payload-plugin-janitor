import { reportTelemetry } from '@seshuk/payload-plugin-tooling/telemetry'
import type { Config, Payload } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { janitor } from '@/index.js'
import { resolveOptions } from '@/server/options/resolveOptions.js'
import { buildFeatures } from '@/server/telemetry.js'
import { PLUGIN_NAME } from '@/shared/constants.js'
import type { JanitorPluginOptions } from '@/shared/types/options.js'
import type { StorageAdapter } from '@/shared/types/storage.js'

vi.mock('@seshuk/payload-plugin-tooling/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@seshuk/payload-plugin-tooling/telemetry')>()),
  reportTelemetry: vi.fn(async () => {}),
}))

vi.mock('@/server/options/validateRuntime.js', () => ({ validateRuntime: vi.fn() }))

const config = {
  collections: [
    { slug: 'media', fields: [{ name: 'alt', type: 'text' }], upload: true },
    { slug: 'tags', fields: [{ name: 'name', type: 'text' }] },
    { slug: 'tenants', fields: [{ name: 'name', type: 'text' }] },
  ],
} as unknown as Config

const storage: StorageAdapter = { delete: async () => {}, list: async function* () {} }

describe('plugin metadata', () => {
  it('sets the slug and options on janitor()', () => {
    const options = { collections: { tags: true } }
    const plugin = janitor(options)

    expect(plugin.slug).toBe(PLUGIN_NAME)
    expect(plugin.options).toBe(options)
  })
})

describe('buildFeatures', () => {
  const features = (options: JanitorPluginOptions) =>
    buildFeatures({ options, resolved: resolveOptions(options, config) })

  it('sets only the defaults for one ordinary collection', () => {
    expect(features({ collections: { tags: true } })).toEqual({
      access: false,
      admin: true,
      adminGroupOff: false,
      adminWidget: true,
      blockDelete: true,
      checkMissing: false,
      checkOrphans: false,
      checkUnused: true,
      collectionStorage: false,
      compositePrefixes: false,
      documentCollections: true,
      endpoints: true,
      endpointsPath: false,
      jobs: false,
      minAge: false,
      overrides: false,
      referencesIgnoreTables: false,
      referencesText: false,
      referencesVersionsUnused: false,
      schedule: false,
      storage: false,
      tenants: false,
      uploadCollections: false,
      usagePanel: true,
    })
  })

  it('sets a flag for each option in use', () => {
    const result = features({
      access: () => true,
      admin: { group: false, widget: false },
      collections: {
        media: { compositePrefixes: true, prefix: '', storage, usagePanel: false },
        tags: { blockDelete: false, report: ['unused'], usagePanel: false },
      },
      endpoints: { path: '/cleanup' },
      minAge: 0,
      overrides: { runs: { slug: 'cleanup-runs' } },
      references: { ignoreTables: ['audit'], text: true, versions: 'unused' },
      jobs: { queue: 'cleanup', schedule: '0 3 * * *' },
      tenants: true,
    })

    expect(Object.entries(result).filter(([, on]) => !on)).toEqual([
      ['adminWidget', false],
      ['storage', false],
      ['usagePanel', false],
    ])
  })

  it('tells queued runs without a schedule from scheduled ones', () => {
    expect(features({ collections: { tags: true }, jobs: {} })).toMatchObject({ jobs: true, schedule: false })
  })
})

describe('telemetry onInit', () => {
  const payload = { config: {}, db: {} } as unknown as Payload
  const init = async (options: Partial<JanitorPluginOptions> = {}, onInit?: Config['onInit']) => {
    const result = await janitor({ collections: { tags: true }, ...options })({ ...config, onInit })
    await result.onInit?.(payload)
  }

  it('reports after the existing onInit resolves', async () => {
    const order: string[] = []
    const onInit = vi.fn(async () => {
      await Promise.resolve()
      order.push('onInit')
    })
    vi.mocked(reportTelemetry).mockImplementationOnce(async () => {
      order.push('telemetry')
    })

    await init({}, onInit)

    expect(onInit).toHaveBeenCalledWith(payload)
    expect(order).toEqual(['onInit', 'telemetry'])
    expect(reportTelemetry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        features: expect.objectContaining({ checkUnused: true, documentCollections: true }),
        packageName: PLUGIN_NAME,
        payload,
        product: 'payload-plugin-janitor',
      }),
    )
  })

  it.each([
    [{}, undefined],
    [{ telemetry: false }, false],
    [
      { telemetry: { url: 'https://telemetry.example.com/v1/collect' } },
      { url: 'https://telemetry.example.com/v1/collect' },
    ],
  ] as const)('passes the opt-out env and option %j to the tooling', async (options, option) => {
    await init(options)

    expect(vi.mocked(reportTelemetry).mock.lastCall![0]).toMatchObject({
      disableEnv: 'JANITOR_TELEMETRY_DISABLED',
      option,
    })
  })

  it('reports nothing when `enabled` is false', async () => {
    vi.mocked(reportTelemetry).mockClear()
    const result = await janitor({ collections: { tags: true }, enabled: false })(config)

    await result.onInit?.(payload)

    expect(result.onInit).toBeUndefined()
    expect(reportTelemetry).not.toHaveBeenCalled()
  })
})
