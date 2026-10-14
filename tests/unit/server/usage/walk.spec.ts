import { describe, expect, it } from 'vitest'

import { walkIds } from '@/server/usage/walk.js'

describe('walkIds', () => {
  const collect = (value: unknown): string[] => {
    const found: string[] = []

    walkIds(value, (id) => found.push(id))

    return found
  }

  it('reads the document out of a lexical upload node', () => {
    const tree = {
      root: {
        type: 'root',
        children: [{ type: 'upload', fields: null, format: '', relationTo: 'media', value: 42, version: 3 }],
        direction: null,
        format: '',
        indent: 0,
        version: 1,
      },
    }

    expect(collect(tree)).toEqual(['42'])
  })

  it('never mistakes a lexical schema version for a document id', () => {
    const tree = { root: { type: 'paragraph', indent: 7, textFormat: 9, version: 1 } }

    expect(collect(tree)).toEqual([])
  })

  it('never mistakes lexical list ordinals and table sizes for document ids', () => {
    const tree = {
      root: {
        type: 'root',
        children: [
          {
            type: 'list',
            children: [{ type: 'listitem', checked: false, children: [], value: 2, version: 1 }],
            listType: 'number',
            start: 3,
            tag: 'ol',
            version: 1,
          },
          { type: 'table', children: [], colWidths: [92, 93], version: 1 },
          { type: 'tablecell', colSpan: 1, children: [], headerState: 0, rowSpan: 1, version: 1, width: 94 },
          { type: 'tablerow', children: [], height: 95, version: 1 },
          { type: 'upload', relationTo: 'media', value: 4, version: 3 },
        ],
        version: 1,
      },
    }

    expect(collect(tree)).toEqual(['4'])
  })

  it('still reads an object a custom node keeps under a layout key', () => {
    const tree = {
      root: {
        type: 'root',
        children: [{ type: 'listitem', children: [], value: { relationTo: 'media', value: 7 }, version: 1 }],
        version: 1,
      },
    }

    expect(collect(tree)).toContain('7')
  })

  it('still reads a plain object, whatever the keys are', () => {
    expect(collect({ note: { image: 5 }, size: 12 }).toSorted()).toEqual(['12', '5'])
  })
})
