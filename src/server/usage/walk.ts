export const asId = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)

  const oid = value as { toHexString?: () => string }

  return typeof oid?.toHexString === 'function' ? oid.toHexString() : undefined
}

const MAX_DEPTH = 128

const EDITOR_LAYOUT_KEYS = new Set([
  'colSpan',
  'detail',
  'direction',
  'format',
  'headerState',
  'indent',
  'mode',
  'relationTo',
  'rowSpan',
  'start',
  'style',
  'textFormat',
  'textStyle',
  'type',
  'version',
])

const NODE_LAYOUT_KEYS: Record<string, Set<string>> = {
  heading: new Set(['tag']),
  list: new Set(['listType', 'tag']),
  listitem: new Set(['value']),
  table: new Set(['colWidths', 'frozenColumnCount', 'frozenRowCount']),
  tablecell: new Set(['width']),
  tablerow: new Set(['height']),
}

const isScalar = (item: unknown): boolean => item === null || typeof item !== 'object'

const isLayout = (node: Record<string, unknown>, key: string, item: unknown): boolean =>
  (NODE_LAYOUT_KEYS[node.type as string]?.has(key) === true &&
    (isScalar(item) || (Array.isArray(item) && item.every(isScalar)))) ||
  (isScalar(item) && EDITOR_LAYOUT_KEYS.has(key))

const isEditorNode = (value: Record<string, unknown>): boolean =>
  typeof value.type === 'string' && typeof value.version === 'number'

export const walkIds = (value: unknown, onMatch: (id: string, path: string) => void, path = '', depth = 0): boolean => {
  if (value === null || value === undefined) return true
  if (depth > MAX_DEPTH) return false

  if (Array.isArray(value)) {
    let complete = true

    for (const item of value) complete = walkIds(item, onMatch, path, depth + 1) && complete

    return complete
  }

  const id = asId(value)

  if (id !== undefined) {
    if (path) onMatch(id, path)

    return true
  }

  if (typeof value !== 'object') return true

  const entries = value as Record<string, unknown>
  const node = isEditorNode(entries)
  let complete = true

  for (const [key, item] of Object.entries(entries)) {
    if (node && isLayout(entries, key, item)) continue

    complete = walkIds(item, onMatch, path ? `${path}.${key}` : key, depth + 1) && complete
  }

  return complete
}

export const UNREADABLE: unique symbol = Symbol('unreadable')

export const parseJson = (value: unknown): unknown => {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return UNREADABLE
  if (typeof value !== 'string') return value

  const trimmed = value.trimStart()

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined

  try {
    return JSON.parse(value)
  } catch {
    return UNREADABLE
  }
}
