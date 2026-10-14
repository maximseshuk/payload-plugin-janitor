import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { localAdapter } from '@/adapters/local.js'

import { collect, keysOf } from '../../helpers/storage.js'

describe('local adapter', () => {
  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'janitor-'))

    await mkdir(join(root, 'nested'), { recursive: true })
    await mkdir(join(root, 'media'), { recursive: true })
    await writeFile(join(root, 'top.png'), 'abc')
    await writeFile(join(root, 'a b #?фото.png'), 'x')
    await writeFile(join(root, 'nested', 'leaf.png'), 'de')
    await writeFile(join(root, 'media', 'm.png'), 'mm')

    return root
  }

  it('lists files Payload writes flat into staticDir and skips subdirectories', async () => {
    const seen = await collect(localAdapter({ staticDir: await setup() }), { prefix: '' })

    expect(seen.map((object) => [object.key, object.size]).toSorted()).toEqual([
      ['a b #?фото.png', 1],
      ['top.png', 3],
    ])
    expect(seen.every((object) => object.lastModified instanceof Date)).toBe(true)
  })

  it('lists the prefix directory with the prefix in each key', async () => {
    expect(keysOf(await collect(localAdapter({ staticDir: await setup() })))).toEqual(['media/m.png'])
  })

  it('throws when staticDir does not exist', async () => {
    await expect(collect(localAdapter({ staticDir: join(tmpdir(), 'janitor-nowhere-x') }))).rejects.toThrow(/ENOENT/)
  })

  it('stats only the requested keys', async () => {
    const seen = await collect(localAdapter({ staticDir: await setup() }), {
      keys: ['top.png', 'a b #?фото.png', 'gone.png', 'nested', 'media/m.png'],
      prefix: '',
    })

    expect(keysOf(seen)).toEqual(['a b #?фото.png', 'media/m.png', 'top.png'])
  })

  it('refuses a requested key that escapes the root', async () => {
    const adapter = localAdapter({ staticDir: await setup() })

    await expect(collect(adapter, { keys: ['../escape.png'], prefix: '' })).rejects.toThrow(/escapes/)
  })

  it('resolves a relative staticDir against the working directory, as Payload does', async () => {
    const root = await setup()
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(root)

    try {
      expect(keysOf(await collect(localAdapter({ staticDir: 'media' }), { prefix: '' }))).toEqual(['m.png'])
    } finally {
      spy.mockRestore()
    }
  })

  it('marks itself per collection only when staticDir is a function', async () => {
    const root = await setup()
    const adapter = localAdapter({ staticDir: (slug) => join(root, slug) })

    expect(adapter.perCollection).toBe(true)
    expect(localAdapter({ staticDir: root }).perCollection).toBe(false)
    expect(keysOf(await collect(adapter, { collection: 'nested', prefix: '' }))).toEqual(['leaf.png'])
  })

  it('deletes a file and resolves when it is already gone', async () => {
    const root = await setup()
    const adapter = localAdapter({ staticDir: root })

    await adapter.delete({ collection: 'media', key: 'a b #?фото.png', prefix: '' })
    await expect(adapter.delete({ collection: 'media', key: 'a b #?фото.png', prefix: '' })).resolves.toBeUndefined()
    expect((await readdir(root)).toSorted()).toEqual(['media', 'nested', 'top.png'])
  })

  it('refuses a key that escapes the root', async () => {
    const adapter = localAdapter({ staticDir: await setup() })

    await expect(adapter.delete({ collection: 'media', key: '../escape.png', prefix: '' })).rejects.toThrow(/escapes/)
    await expect(adapter.delete({ collection: 'media', key: '/etc/passwd', prefix: '' })).rejects.toThrow(/escapes/)
  })
})
