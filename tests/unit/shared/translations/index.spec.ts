import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { acceptedLanguages } from '@payloadcms/translations'
import { describe, expect, it } from 'vitest'

import { localeOf, noticeOf } from '@/client/findingData.js'
import { countsOf, STATE_STYLE } from '@/client/usageData.js'
import { PLUGIN_NAME } from '@/shared/constants.js'
import { translations } from '@/shared/translations/index.js'

import { hit } from '../../../helpers/usage.js'

describe('translations', () => {
  const sources = async (dir: string): Promise<string[]> => {
    const names = await readdir(join(import.meta.dirname, '..', '..', '..', '..', 'src', dir), { recursive: true })

    return Promise.all(
      names
        .filter((name) => /\.tsx?$/.test(name))
        .map((name) => readFile(join(import.meta.dirname, '..', '..', '..', '..', 'src', dir, name), 'utf8')),
    )
  }

  const usedKeys = async (): Promise<Set<string>> => {
    const keys = new Set<string>()

    for (const source of [
      ...(await sources('client')),
      ...(await sources('server/collections')),
      ...(await sources('rsc')),
    ]) {
      for (const match of source.matchAll(/\$\{PLUGIN_NAME\}:(\w+)/g)) keys.add(match[1]!)
      for (const match of source.matchAll(/\b(?:label|title)\('(\w+)'\)/g)) keys.add(match[1]!)

      for (const match of source.matchAll(/\$\{PLUGIN_NAME\}:\$\{([^}]*)\}/g)) {
        for (const quoted of match[1]!.matchAll(/'(\w+)'/g)) keys.add(quoted[1]!)
      }
    }

    for (const entry of countsOf([
      hit({ status: 'published' }),
      hit({ status: 'draft' }),
      hit({ status: 'version' }),
      hit({ status: 'trashed' }),
    ])) {
      keys.add(entry.key)
    }

    for (const state of Object.keys(STATE_STYLE)) keys.add(state)

    const answers: [number, unknown][] = [
      [409, {}],
      [403, {}],
      [500, {}],
      [500, { error: 'x' }],
      [200, { queued: true }],
      [200, { scan: { missing: 0, orphans: 0, unused: 0 } }],
      [200, {}],
      [200, { report: { deleted: 0, failed: 1, skipped: 0 } }],
    ]

    for (const mode of ['scan', 'purge'] as const) {
      for (const [status, body] of answers) keys.add(noticeOf(mode, status, body).key)
    }

    return keys
  }

  const PLURAL = /_(zero|one|two|few|many|other)$/
  const english = translations.en[PLUGIN_NAME]
  const baseOf = (key: string): string => key.replace(PLURAL, '')
  const placeholders = (text: string): string[] => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]!)
  const languages = Object.keys(translations) as (keyof typeof translations)[]

  it('has every key the admin components use in en', async () => {
    const keys = await usedKeys()

    expect(keys).toContain('deleteBlocked')
    expect(keys).toContain('scanQueued')
    expect(keys).toContain('janitorFindings')
    expect(keys).toContain('widgetLabel')
    expect([...keys].filter((key) => !(key in english) && !(`${key}_other` in english))).toEqual([])
  })

  it('ships every language Payload accepts', () => {
    expect(languages.toSorted()).toEqual([...new Set(acceptedLanguages)].toSorted())
  })

  it.each(languages)('never makes a count agree with a word Payload picks the wrong plural for in %s', (language) => {
    const strings = translations[language][PLUGIN_NAME]
    const rules = new Intl.PluralRules(localeOf(language))
    const pick = (base: string, count: number): string => {
      const has = (form: string) => `${base}_${form}` in strings

      if (count === 1 && has('one')) return 'one'
      if (count === 2 && has('two')) return 'two'
      if (count > 5 && has('many')) return 'many'
      if (count > 2 && count <= 5 && has('few')) return 'few'

      return 'other'
    }
    const problems = new Set<string>()

    for (const key of new Set(
      Object.keys(strings)
        .filter((name) => PLURAL.test(name))
        .map(baseOf),
    )) {
      for (let count = 2; count <= 200; count += 1) {
        const form = pick(key, count)
        const text = strings[`${key}_${form}`] ?? ''

        if (form !== rules.select(count) && /\{\{count\}\}[\s\u00a0]*\p{L}/u.test(text)) problems.add(`${key}_${form}`)
      }
    }

    expect([...problems]).toEqual([])
  })

  it.each(languages)('has the same keys and placeholders as en in %s', (language) => {
    const strings = translations[language][PLUGIN_NAME]
    const problems: string[] = []

    for (const key of new Set(Object.keys(english).map(baseOf))) {
      const plural = `${key}_other` in english

      for (const form of plural ? ['_one', '_other'] : ['']) {
        if (!strings[`${key}${form}`]?.trim()) problems.push(`missing ${key}${form}`)
      }
    }

    for (const [key, text] of Object.entries(strings)) {
      const base = baseOf(key)
      const plural = key !== base

      if (!(`${base}${plural ? '_other' : ''}` in english)) {
        problems.push(`unknown ${key}`)
        continue
      }

      const expected = placeholders(english[`${base}${plural ? '_other' : ''}`]!)
      const found = placeholders(text)
      const required = expected.filter((name) => !plural || name !== 'count' || key.endsWith('_other'))

      for (const name of found) if (!expected.includes(name)) problems.push(`${key} has {{${name}}}`)
      for (const name of required) if (!found.includes(name)) problems.push(`${key} lacks {{${name}}}`)
    }

    expect(problems).toEqual([])
  })
})
