import { describe, expect, it, vi } from 'vitest'

import { resolveOptions } from '@/server/options/resolveOptions.js'
import { sameTenants, seesAllTenants, tenantIdsOf, tenantScope } from '@/server/tenants.js'

import { config } from '../../helpers/options.js'

describe('tenantIdsOf', () => {
  const objectId = (hex: string) => ({ id: Buffer.from(hex), toHexString: () => hex, toString: () => hex })

  it('reads ids, populated tenants, hasMany arrays and ObjectId values', () => {
    expect(tenantIdsOf(1)).toEqual([1])
    expect(tenantIdsOf({ id: 'a', name: 'gold' })).toEqual(['a'])
    expect(tenantIdsOf([2, { id: 3 }, null])).toEqual([2, 3])
    expect(tenantIdsOf(objectId('65f0a1'))).toEqual(['65f0a1'])
    expect(tenantIdsOf([{ id: objectId('65f0b2') }, objectId('65f0c3')])).toEqual(['65f0b2', '65f0c3'])
    expect(tenantIdsOf(undefined)).toEqual([])
  })

  it('compares tenant sets in any order and form', () => {
    expect(sameTenants([objectId('b'), 'a'], ['a', { id: 'b' }])).toBe(true)
    expect(sameTenants(['a'], [])).toBe(false)
  })
})

describe('tenantScope', () => {
  it('asks the tenants collection once per request', async () => {
    const options = resolveOptions({ collections: { tags: true }, tenants: true }, config)
    const read = vi.fn(() => ({ id: { in: [1] } }))
    const find = vi.fn(async () => ({ docs: [{ id: 1 }] }))
    const req = { payload: { collections: { tenants: { config: { access: { read } } } }, find } } as never

    expect(await tenantScope(req, options)).toEqual({ tenant: { in: [1] } })
    expect(await tenantScope(req, options)).toEqual({ tenant: { in: [1] } })
    expect(read).toHaveBeenCalledTimes(1)
    expect(find).toHaveBeenCalledTimes(1)

    await tenantScope({ ...(req as object) } as never, options)

    expect(find).toHaveBeenCalledTimes(2)
  })

  it('asks again when the request changes user', async () => {
    const options = resolveOptions({ collections: { tags: true }, tenants: true }, config)
    const admin = { id: 1 }
    const editor = { id: 2 }
    const read = vi.fn(({ req }: { req: { user: unknown } }) => (req.user === admin ? true : { id: { in: [7] } }))
    const find = vi.fn(async () => ({ docs: [{ id: 7 }] }))
    const req = { payload: { collections: { tenants: { config: { access: { read } } } }, find }, user: admin }

    expect(await tenantScope(req as never, options)).toBe(true)

    req.user = editor

    expect(await tenantScope(req as never, options)).toEqual({ tenant: { in: [7] } })
    expect(await seesAllTenants(req as never, options)).toBe(false)
  })
})
