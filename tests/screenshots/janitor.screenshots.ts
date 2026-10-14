import fs from 'node:fs/promises'
import path from 'node:path'

import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '../..')
const outDir = path.join(root, 'media/screenshots')
const hidden = ['deep', 'notices', 'simple']

const login = async (request: APIRequestContext) => {
  const res = await request.post('/api/users/login', { data: { email: 'dev@example.com', password: 'dev' } })
  expect(res.ok()).toBe(true)
}

const findingId = async (request: APIRequestContext, objectKey: string) => {
  const res = await request.get('/api/janitor-findings', {
    params: { depth: 0, 'where[objectKey][equals]': objectKey },
  })
  const { docs } = (await res.json()) as { docs: { id: number | string }[] }
  expect(docs).toHaveLength(1)
  return docs[0]!.id
}

const frame = async (page: Page, name: string) => {
  const shot = await page.screenshot()
  const url = new URL(page.url())
  const framePage = await page.context().newPage()
  await framePage.setViewportSize({ height: 960, width: 1408 })
  await framePage.setContent(`<!doctype html>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { background: #0a0c0e; }
  .stage {
    background:
      radial-gradient(60% 70% at 18% 20%, rgba(154, 79, 240, 0.28), transparent 70%),
      radial-gradient(50% 60% at 90% 100%, rgba(154, 79, 240, 0.12), transparent 70%),
      #0a0c0e;
    display: inline-block;
    padding: 64px;
  }
  .window {
    background: #141619;
    border-radius: 14px;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08), 0 40px 80px -20px rgba(0, 0, 0, 0.8), 0 0 120px rgba(154, 79, 240, 0.12);
    overflow: hidden;
    width: 1280px;
  }
  .bar {
    align-items: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    display: flex;
    gap: 8px;
    height: 40px;
    padding: 0 16px;
    position: relative;
  }
  .dot { border-radius: 50%; height: 12px; width: 12px; }
  .url {
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.55);
    font: 13px/24px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    left: 50%;
    padding: 0 16px;
    position: absolute;
    transform: translateX(-50%);
  }
  img { display: block; width: 1280px; }
</style>
<div class="stage">
  <div class="window">
    <div class="bar">
      <span class="dot" style="background:#ff5f57"></span>
      <span class="dot" style="background:#febc2e"></span>
      <span class="dot" style="background:#28c840"></span>
      <span class="url">${url.pathname}</span>
    </div>
    <img src="data:image/png;base64,${shot.toString('base64')}" />
  </div>
</div>`)
  await framePage.locator('img').evaluate((img: HTMLImageElement) => img.decode())
  await framePage.locator('.stage').screenshot({ path: path.join(outDir, `${name}.png`) })
  await framePage.close()
}

const open = async (page: Page, pathname: string, ready: string) => {
  await page.goto(pathname)
  await page.addStyleTag({
    content: `nextjs-portal, ${hidden
      .flatMap((slug) => [
        `.nav__link-wrapper:has(> a[href$="/collections/${slug}"])`,
        `a.nav__link[href$="/collections/${slug}"]`,
        `li:has(> .card-${slug})`,
      ])
      .join(', ')} { display: none !important; }`,
  })
  await expect(page.locator(ready).first()).toBeVisible({ timeout: 30_000 })
  await page.mouse.move(0, 0)
}

test.use({ colorScheme: 'dark', deviceScaleFactor: 2, viewport: { height: 660, width: 1280 } })

test.describe('screenshots', () => {
  const ids: Record<string, number | string> = {}

  test.beforeAll(async ({ request }) => {
    await fs.mkdir(outDir, { recursive: true })
    await login(request)
    const scan = await request.post('/api/janitor/scan')
    expect(scan.ok()).toBe(true)
    const { runId } = (await scan.json()) as { runId: number | string }
    await expect
      .poll(
        async () =>
          ((await (await request.get(`/api/janitor-runs/${runId}?depth=0`)).json()) as { status: string }).status,
        {
          timeout: 60_000,
        },
      )
      .toBe('done')
    ids.run = runId
    ids.unused = await findingId(request, 'lonely.txt')
    const approved = await request.patch(`/api/janitor-findings/${await findingId(request, 'stray-banner.txt')}`, {
      data: { status: 'delete' },
    })
    expect(approved.ok()).toBe(true)
  })

  test.beforeEach(async ({ context, page }) => {
    await context.addCookies([{ name: 'payload-theme', url: 'http://localhost:47392', value: 'dark' }])
    await login(page.request)
  })

  test('dashboard widget', async ({ page }) => {
    await page.setViewportSize({ height: 340, width: 1280 })
    await open(page, '/admin', '.janitor-widget')
    await page.addStyleTag({ content: '.modular-dashboard > .widget:not(:has(.janitor-widget)) { display: none; }' })
    await frame(page, 'widget')
  })

  test('findings list with the janitor menu', async ({ page }) => {
    await open(page, '/admin/collections/janitor-findings', 'table')
    await page.getByRole('button', { name: 'More options' }).click()
    await expect(page.getByText(/Delete approved \(/)).toBeVisible()
    await frame(page, 'findings')
  })

  test('unused file finding', async ({ page }) => {
    await open(page, `/admin/collections/janitor-findings/${ids.unused}`, '.janitor-summary')
    await frame(page, 'finding')
  })

  test('usage panel', async ({ page }) => {
    await open(page, '/admin/collections/media/1', '.janitor-usage')
    await expect(page.locator('.janitor-usage__list').first()).toBeVisible()
    await page.evaluate(() => {
      const usage = document.querySelector<HTMLElement>('.janitor-usage')!
      usage.style.scrollMarginTop = `${document.querySelector('.doc-controls')!.getBoundingClientRect().height + 24}px`
      usage.scrollIntoView({ block: 'start' })
    })
    await frame(page, 'usage')
  })

  test('scan run', async ({ page }) => {
    await open(page, `/admin/collections/janitor-runs/${ids.run}`, '.janitor-summary__table')
    await frame(page, 'run')
  })
})
