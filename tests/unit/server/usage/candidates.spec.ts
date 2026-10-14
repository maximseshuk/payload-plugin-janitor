import { describe, expect, it } from 'vitest'

import { schemaCandidates } from '@/server/usage/candidates.js'

describe('schemaCandidates', () => {
  const source = {
    collections: [
      {
        slug: 'posts',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'hero', type: 'upload', relationTo: 'media' },
          { name: 'body', type: 'richText' },
          { name: 'meta', type: 'json' },
        ],
      },
      {
        slug: 'layouts',
        fields: [
          {
            name: 'layout',
            type: 'blocks',
            blocks: [{ slug: 'gallery', fields: [{ name: 'image', type: 'upload', relationTo: ['media', 'files'] }] }],
          },
        ],
      },
      { slug: 'tags', fields: [{ name: 'name', type: 'text' }] },
    ],
    globals: [],
  }

  it('lists only the entities that can reference the upload', () => {
    const candidates = schemaCandidates(source as never, 'media')

    expect([...candidates.keys()].toSorted()).toEqual(['layouts', 'posts'])
  })

  it('keeps the top-level field that carries the reference, whatever it is nested in', () => {
    const candidates = schemaCandidates(source as never, 'media')

    expect([...candidates.get('posts')!.fields].toSorted()).toEqual(['body', 'hero', 'meta'])
    expect([...candidates.get('layouts')!.fields]).toEqual(['layout'])
  })
})
