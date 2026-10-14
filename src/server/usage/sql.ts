import type { Payload } from 'payload'

export type Row = Record<string, unknown>

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

type Query = (text: string, values?: unknown[]) => Promise<{ rows: Row[] }>
type Execute = (input: { args?: unknown[]; sql: string }) => Promise<{ rows: Row[] }>

type Database = {
  client?: { execute?: Execute }
  name?: string
  pool?: { query?: Query }
  schemaName?: string
  sessions?: Record<string, { db?: { session?: { client?: { query?: Query }; tx?: { execute?: Execute } } } }>
}

export type Dialect = 'postgres' | 'sqlite'

export type Context = { transactionID?: number | string }

const databaseOf = (payload: Payload): Database => payload.db as unknown as Database

export const dialectOf = (payload: Payload): Dialect | undefined => {
  const db = databaseOf(payload)

  if (db.name === 'postgres' && typeof db.pool?.query === 'function') return 'postgres'
  if (db.name === 'sqlite' && typeof db.client?.execute === 'function') return 'sqlite'

  return undefined
}

export const quote = (name: string): string => {
  if (!SAFE_NAME.test(name)) throw new Error(`janitor: unexpected identifier ${name}`)

  return `"${name}"`
}

export const schemaOf = (payload: Payload): string => databaseOf(payload).schemaName || 'public'

export const tableName = (payload: Payload, dialect: Dialect, table: string): string =>
  dialect === 'postgres' ? `${quote(schemaOf(payload))}.${quote(table)}` : quote(table)

export const run = async (payload: Payload, sql: string, args: unknown[] = [], context?: Context): Promise<Row[]> => {
  const db = databaseOf(payload)
  const transactionID = context?.transactionID
  const session = transactionID === undefined ? undefined : db.sessions?.[String(transactionID)]?.db

  if (!session)
    return db.pool ? (await db.pool.query!(sql, args)).rows : (await db.client!.execute!({ args, sql })).rows

  const driver = session.session

  if (db.pool && driver?.client?.query) return (await driver.client.query(sql, args)).rows
  if (!db.pool && driver?.tx?.execute) return (await driver.tx.execute({ args, sql })).rows

  throw new Error('janitor: cannot read the database inside this transaction; its driver is neither pg nor libsql')
}

export const placeholder = (dialect: Dialect, index: number): string => (dialect === 'postgres' ? `$${index}` : '?')
