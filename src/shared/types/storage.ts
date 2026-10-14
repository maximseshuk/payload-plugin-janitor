/** One object in the bucket, as a listing returns it. */
export type StorageObject = {
  /** Full key, prefix included. */
  key: string
  /**
   * When the object was last written. Leave it out only when the provider cannot know: an object
   * without a date is never held back by `minAge`, so the safety rail goes with it.
   */
  lastModified?: Date
  /**
   * Whatever the provider needs to delete this object later and cannot derive from the key — a URL,
   * a file id. It is stored with the finding, because a purge runs in a process that never listed.
   */
  ref?: string
  /** Bytes. Leave it out rather than guess: the number is summed into the report. */
  size?: number
}

/** What the janitor is looking at. Grows by optional fields, never by a new argument. */
export type StorageScope = {
  /** Slug of the upload collection, for a provider that keeps a bucket or a zone per collection. */
  collection: string
  /** Key prefix without a trailing slash. An empty string is the root of the bucket. */
  prefix: string
}

export type StorageListArgs = StorageScope & {
  /**
   * When set, the caller needs only these keys, all inside `prefix`. List just them if the provider can do
   * it cheaply (a lookup per key, or a listing with the key as prefix), or ignore the field and list the
   * whole prefix: the caller filters. Every key that exists must come back, or `list` throws.
   */
  keys?: string[]
}

export type StorageDeleteArgs = Pick<StorageObject, 'key' | 'ref'> & StorageScope

/**
 * The only thing the plugin needs from a storage provider. Implement it for any backend or use one of
 * the bundled adapters, and pass it as `storage`.
 *
 * Two rules, both load-bearing:
 *
 * - `list` walks the whole prefix or throws. A listing that quietly stops short reads as an empty
 *   bucket, and every document whose file was not reached is then reported as missing.
 * - `delete` resolves when the object is already gone. Treating a 404 as failure leaves the finding
 *   waiting for a deletion that can never happen.
 */
export type StorageAdapter = {
  delete: (args: StorageDeleteArgs) => Promise<void>
  /**
   * Dotted path of a field that marks a document whose file this storage never holds, such as a video kept
   * by a streaming service. A document with a value there is never reported missing, and its file is not
   * looked for in the listing. Ignored on a collection without that field.
   */
  external?: string
  /** Yields the listing in pages, in any order — one page per request the provider makes. */
  list: (args: StorageListArgs) => AsyncIterable<StorageObject[]>
  /**
   * Set when the listing depends on `collection`, not only on `prefix` — a bucket, a zone or a directory
   * per collection. Collections on such an adapter never share a scope, even under the same prefix.
   */
  perCollection?: boolean
}
