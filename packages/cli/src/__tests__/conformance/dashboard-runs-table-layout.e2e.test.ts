/// <reference lib="dom" />
// The Runs list in real Chromium over seeded runs.db rows, recorded per viewport in `beforeAll`.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  DashboardDatabase,
  formatRunTitle,
  resolveDashboardDbPath,
} from '@vostride/agent-qa-dashboard'
import { generateRunId } from '@vostride/agent-qa-ids'
import { chromium } from 'playwright-core'
import type { Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DASHBOARD_ANCHORED_BUILDS,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  dashboardFixtureProject,
  reserveEphemeralPort,
  spawnDashboard,
  type SpawnedDashboard,
} from './spawned-chat.js'

const FILE_BUDGET_MS = 240_000
const PAGE_BUDGET_MS = 30_000
const VIEWPORTS = [1280, 1024, 1600] as const
const NARROW = [1280, 1024] as const
const NAME_FLOOR_PX = 272
const ALWAYS_SHOWN = ['Status', 'Duration', 'Started'] as const
const LONG_TARGET = 'checkout-staging-eu-west-registry-target'

const VERIFY_RUN_NAME =
  'Sign in as the seeded shopper, open the account page, change the delivery address to the second '
  + 'saved address, confirm the change, and check the order summary shows the new address in full'
const MEMBER_NAMES = ['a-login', 'b-checkout', 'c-search'] as const
const SUITE_NAME = 'Nightly checkout suite with members'
const FAILED_RUN_NAME = 'Checkout rejects an expired card with the documented message'

interface SeedFields {
  readonly status: string
  readonly minutes: number
  readonly attributes?: Record<string, string>
  readonly suiteId?: string
}

interface SeedMember {
  readonly name: string
  readonly outcome: string
  readonly suiteId?: string
  readonly suiteName?: string
}

interface Seeded {
  readonly id: string
  readonly name: string
}

interface ColumnView {
  readonly label: string
  readonly shown: boolean
  readonly width: number
  readonly right: number
}

interface ViewportView {
  readonly width: number
  readonly rows: number
  readonly columns: readonly ColumnView[]
  readonly nameCells: readonly number[]
  readonly fits: readonly { label: string; scrollWidth: number; clientWidth: number }[]
  readonly scrollers: readonly { slot: string; scrollWidth: number; clientWidth: number }[]
  readonly wrapperRight: number
  readonly badge?: { readonly top: number; readonly nameTop: number; readonly lineHeight: number }
}

const scene: {
  error?: string
  seeded: Seeded[]
  views: Map<number, ViewportView>
  screenshots: string[]
} = { seeded: [], views: new Map(), screenshots: [] }

let dashboard: SpawnedDashboard | undefined
let browser: Browser | undefined

function message(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

function testFile(name: string, target: string): string {
  return `name: ${JSON.stringify(name)}\ntarget: ${target}\nsteps:\n  - Open the page\n`
}

function seedRuns(root: string): Seeded[] {
  const db = new DashboardDatabase({ dbPath: resolveDashboardDbPath({ configDir: root }) })
  const seeded: Seeded[] = []
  const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 17, 9, minutes)).toISOString()
  try {
    const add = (name: string, fields: SeedFields, members: readonly SeedMember[] = []): void => {
      const id = db.insertRun({
        id: generateRunId(),
        name,
        status: fields.status,
        duration: 4_200,
        startedAt: at(fields.minutes),
        endedAt: at(fields.minutes + 1),
        platform: 'web',
        testFileContent: testFile(name, LONG_TARGET),
        ...(fields.attributes === undefined ? {} : { attributes: fields.attributes }),
        ...(fields.suiteId === undefined ? {} : { suiteId: fields.suiteId }),
        ...(fields.status === 'failed' ? { failureSummary: 'The card was accepted.' } : {}),
      })
      for (const [testIndex, member] of members.entries()) {
        db.upsertRunMember({
          runId: id,
          testIndex,
          name: member.name,
          filePath: `tests/${member.name}.test.yaml`,
          outcome: member.outcome,
          ...(member.suiteId === undefined
            ? {}
            : { suiteId: member.suiteId, suiteName: member.suiteName }),
        })
      }
      seeded.push({ id, name })
    }
    add(VERIFY_RUN_NAME, {
      status: 'passed',
      minutes: 1,
      attributes: {
        'agent-qa.trigger': 'cli',
        'agent-qa.runner': 'local',
        'agent-qa.gate-run': 'true',
      },
    })
    add(
      formatRunTitle(MEMBER_NAMES),
      { status: 'passed', minutes: 2, attributes: { 'agent-qa.trigger': 'cli' } },
      MEMBER_NAMES.map((name) => ({ name, outcome: 'passed' })),
    )
    add(
      SUITE_NAME,
      {
        status: 'failed',
        minutes: 3,
        suiteId: 's_checkout',
        attributes: { 'agent-qa.trigger': 'cli' },
      },
      MEMBER_NAMES.map((name, index) => ({
        name,
        suiteId: 's_checkout',
        suiteName: SUITE_NAME,
        outcome: index === 1 ? 'failed' : 'passed',
      })),
    )
    add(FAILED_RUN_NAME, {
      status: 'failed',
      minutes: 4,
      attributes: {
        'agent-qa.trigger': 'dashboard',
        'agent-qa.runner': 'local',
        'git.branch': 'release/checkout-expired-card-message',
        'ci.pipeline': 'nightly-checkout-regressions',
      },
    })
  } finally {
    db.close()
  }
  return seeded
}

async function observe(width: number, captureDir: string | undefined): Promise<ViewportView> {
  const page = await browser!.newPage({ viewport: { width, height: 900 } })
  try {
    await page.goto(`${dashboard!.origin}/runs`)
    await page.locator('[data-runs-row-surface]').nth(scene.seeded.length - 1)
      .waitFor({ state: 'visible', timeout: PAGE_BUDGET_MS })
    const verifyRunId = scene.seeded[0]!.id
    const view = await page.evaluate(({ badgeRowId, fitted }) => {
      const heads = Array.from(document.querySelectorAll<HTMLElement>('thead th'))
      const columns = heads.map((th) => {
        const rect = th.getBoundingClientRect()
        const label = (th.textContent ?? '').replace(/\s+/g, ' ').trim()
        return {
          label,
          shown: getComputedStyle(th).display !== 'none' && rect.width > 0,
          width: rect.width,
          right: rect.right,
        }
      })
      const nameIndex = columns.findIndex((column) => column.label.startsWith('Test Name'))
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('tbody tr[data-runs-row-surface]'),
      )
      const cellAt = (row: HTMLElement, index: number) => row.querySelectorAll('td')[index]
      const nameCells = rows.map(
        (row) => cellAt(row, nameIndex)?.getBoundingClientRect().width ?? 0,
      )
      const fits = fitted.flatMap((label) => {
        const index = columns.findIndex((column) => column.label.startsWith(label))
        return [heads[index], ...rows.map((row) => cellAt(row, index))].map((cell) => ({
          label,
          scrollWidth: cell?.scrollWidth ?? -1,
          clientWidth: cell?.clientWidth ?? -1,
        }))
      })
      const scrollers = ['scroll-area', 'table-container'].map((slot) => {
        const element = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)
        return {
          slot,
          scrollWidth: element?.scrollWidth ?? -1,
          clientWidth: element?.clientWidth ?? -1,
        }
      })
      const wrapper = document.querySelector<HTMLElement>('[data-tour-id="tour-runs-table"]')
      const badgeRow = document.querySelector(`[data-runs-row-surface="${badgeRowId}"]`)
      const badges = badgeRow?.querySelectorAll<HTMLElement>('[data-slot="badge"]') ?? []
      const badgeElement = Array.from(badges)
        .find((element) => element.textContent === 'Verify run')
      const nameSpan = badgeElement?.parentElement?.querySelector<HTMLElement>('span')
      const badge = badgeElement && nameSpan
        ? {
            top: badgeElement.getBoundingClientRect().top,
            nameTop: nameSpan.getBoundingClientRect().top,
            lineHeight: Number.parseFloat(getComputedStyle(nameSpan).lineHeight),
          }
        : undefined
      return {
        rows: rows.length,
        columns,
        nameCells,
        fits,
        scrollers,
        wrapperRight: wrapper?.getBoundingClientRect().right ?? -1,
        ...(badge === undefined ? {} : { badge }),
      }
    }, { badgeRowId: verifyRunId, fitted: [...ALWAYS_SHOWN] })
    if (captureDir !== undefined && (NARROW as readonly number[]).includes(width)) {
      const path = join(captureDir, `runs-table-${String(width)}.png`)
      await page.screenshot({ path, fullPage: true })
      scene.screenshots.push(path)
    }
    return { width, ...view }
  } finally {
    await page.close()
  }
}

async function drive(): Promise<void> {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
  const freshness = buildFreshness(DASHBOARD_ANCHORED_BUILDS)
  if (freshness.missing.length > 0 || freshness.stale.length > 0) {
    throw new Error(`${REBUILD_INSTRUCTION}\n${JSON.stringify(freshness, null, 2)}`)
  }
  const project = dashboardFixtureProject('444-runs-table')
  scene.seeded = seedRuns(project.root)
  const port = await reserveEphemeralPort()
  dashboard = await spawnDashboard(project.root, project.configPath, port)
  if (!dashboard.stdout().includes('Dashboard running at')) {
    throw new Error(`the spawned dashboard never said it was listening: ${dashboard.stderr()}`)
  }
  browser = await chromium.launch({ headless: true })
  const captureDir = process.env.AGENT_QA_CAPTURE_DIR?.trim() || undefined
  if (captureDir !== undefined) mkdirSync(captureDir, { recursive: true })
  for (const width of VIEWPORTS) scene.views.set(width, await observe(width, captureDir))
}

function facts(): string {
  return JSON.stringify({ ...scene, views: Object.fromEntries(scene.views) }, null, 2)
}

function column(view: ViewportView, label: string): ColumnView | undefined {
  return view.columns.find((entry) => entry.label.startsWith(label))
}

describe('the dashboard runs table layout', () => {
  beforeAll(async () => {
    try {
      await drive()
    } catch (error) {
      scene.error = message(error)
    }
  }, FILE_BUDGET_MS)

  afterAll(async () => {
    await browser?.close().catch(() => undefined)
    await dashboard?.stop().catch(() => undefined)
    cleanupTempRoots()
  }, 60_000)

  it('at 1280px and 1024px the name column keeps about 280px and nothing overflows', () => {
    expect(scene.error, facts()).toBeUndefined()
    for (const width of NARROW) {
      const view = scene.views.get(width)
      expect(view, `the ${String(width)}px view\n${facts()}`).toBeDefined()
      expect(view!.rows, `rows at ${String(width)}px`).toBe(scene.seeded.length)
      const name = column(view!, 'Test Name')
      expect(name?.width ?? 0, `the Name header at ${String(width)}px`)
        .toBeGreaterThanOrEqual(NAME_FLOOR_PX)
      for (const cell of view!.nameCells) {
        expect(cell, `a name cell at ${String(width)}px`).toBeGreaterThanOrEqual(NAME_FLOOR_PX)
      }
      for (const scroller of view!.scrollers) {
        expect(scroller.clientWidth, `${scroller.slot} at ${String(width)}px`).toBeGreaterThan(0)
        expect(scroller.scrollWidth, `${scroller.slot} overflows at ${String(width)}px`)
          .toBeLessThanOrEqual(scroller.clientWidth + 1)
      }
      expect(view!.fits.length, `measured cells at ${String(width)}px`)
        .toBe(ALWAYS_SHOWN.length * (scene.seeded.length + 1))
      for (const fit of view!.fits) {
        expect(fit.clientWidth, `a ${fit.label} cell at ${String(width)}px`).toBeGreaterThan(0)
        expect(fit.scrollWidth, `a ${fit.label} cell's content fits at ${String(width)}px`)
          .toBeLessThanOrEqual(fit.clientWidth + 1)
      }
      for (const label of ALWAYS_SHOWN) {
        const head = column(view!, label)
        expect(head?.shown, `${label} at ${String(width)}px`).toBe(true)
        expect(head!.right, `${label}'s right edge at ${String(width)}px`)
          .toBeLessThanOrEqual(view!.wrapperRight + 1)
      }
      expect(column(view!, 'Attributes')?.shown, `Attributes at ${String(width)}px`).toBe(false)
      const badge = view!.badge
      expect(badge, `the Verify run badge at ${String(width)}px`).toBeDefined()
      expect(badge!.top, `the badge's top at ${String(width)}px`)
        .toBeGreaterThanOrEqual(badge!.nameTop - 1)
      expect(badge!.top, `the badge within the name's first line at ${String(width)}px`)
        .toBeLessThan(badge!.nameTop + badge!.lineHeight)
    }
  })

  it('at 1600px the Attributes column shows', () => {
    expect(scene.error, facts()).toBeUndefined()
    const view = scene.views.get(1600)
    expect(view, facts()).toBeDefined()
    expect(view!.rows, 'rows at 1600px').toBe(scene.seeded.length)
    expect(column(view!, 'Attributes')?.shown, 'Attributes at 1600px').toBe(true)
    expect(column(view!, 'Attributes')!.width, 'Attributes width at 1600px').toBeGreaterThan(0)
  })
})
