import { describe, expect, it } from 'vitest'

import { azure, contract } from '../../helpers/storage.js'

describe('azure adapter', () => {
  contract(azure)

  it('splits a long listing into pages of a thousand', async () => {
    const store = new Set(Array.from({ length: 2500 }, (_, index) => `media/${index}.png`))
    const sizes: number[] = []

    for await (const page of azure(store).list({ collection: 'media', prefix: 'media' })) sizes.push(page.length)

    expect(sizes).toEqual([1000, 1000, 500])
  })
})
