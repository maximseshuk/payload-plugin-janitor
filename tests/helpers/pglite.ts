import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'

type Pending = {
  handlerId: number
  message: Uint8Array
  onData: (data: Uint8Array) => void
  reject: (err: unknown) => void
  resolve: (bytes: number) => void
}

const HANDS_OVER = new Set([0, 'Q'.charCodeAt(0), 'S'.charCodeAt(0), 'X'.charCodeAt(0)])

const READY = 'Z'.charCodeAt(0)

const withoutReady = (data: Uint8Array): Uint8Array => {
  const kept: Uint8Array[] = []
  let offset = 0

  while (offset + 5 <= data.length) {
    const end = offset + 1 + new DataView(data.buffer, data.byteOffset + offset + 1, 4).getInt32(0)

    if (data[offset] !== READY) kept.push(data.subarray(offset, end))
    offset = end
  }

  return offset === data.length ? Buffer.concat(kept) : data
}

class SessionQueue {
  private owner: number | undefined
  private pending: Pending[] = []
  private running = false

  constructor(private readonly db: PGlite) {}

  enqueue(handlerId: number, message: Uint8Array, onData: (data: Uint8Array) => void): Promise<number> {
    return new Promise((resolve, reject) => {
      this.pending.push({ handlerId, message, onData, reject, resolve })
      void this.drain()
    })
  }

  getQueueLength(): number {
    return this.pending.length
  }

  clearQueueForHandler(handlerId: number): void {
    for (const item of this.pending) if (item.handlerId === handlerId) item.reject(new Error('Handler disconnected'))
    this.pending = this.pending.filter((item) => item.handlerId !== handlerId)
  }

  async clearTransactionIfNeeded(handlerId: number): Promise<void> {
    if (this.owner !== handlerId) return
    if (this.db.isInTransaction()) await this.db.exec('ROLLBACK')
    this.owner = undefined
    await this.drain()
  }

  private next(): Pending | undefined {
    const index = this.owner === undefined ? 0 : this.pending.findIndex((item) => item.handlerId === this.owner)

    return index === -1 ? undefined : this.pending.splice(index, 1)[0]
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true

    try {
      for (let item = this.next(); item; item = this.next()) {
        const current = item
        const handsOver = HANDS_OVER.has(current.message[0] ?? 0)
        let bytes = 0

        try {
          await this.db.runExclusive(() =>
            this.db.execProtocolRawStream(current.message, {
              onRawData: (data) => {
                const sent = handsOver ? data : withoutReady(data)

                bytes += sent.length
                if (sent.length) current.onData(sent)
              },
            }),
          )
          current.resolve(bytes)
        } catch (err) {
          current.reject(err)
        }

        this.owner = this.db.isInTransaction() || !handsOver ? current.handlerId : undefined
      }
    } finally {
      this.running = false
    }
  }
}

export const startPglite = async (): Promise<{ stop: () => Promise<void>; url: string }> => {
  const db = await PGlite.create()
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', maxConnections: 8, port: 0 })

  Object.assign(server, { queryQueue: new SessionQueue(db) })
  await server.start()

  return {
    stop: async () => {
      await server.stop()
      await db.close()
    },
    url: `postgresql://postgres@${server.getServerConn()}/postgres`,
  }
}
