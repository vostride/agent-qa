import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AGENT_QA_SENTRY_DSN } from '../index.js'
import { PACKAGE_SRC_DIR } from './source-scan.js'

const SCRIPT_NAME = 'ensure-posthog-project.cjs'
const POSTHOG_HOST_LINE = 'export const AGENT_QA_POSTHOG_HOST = "https://us.i.posthog.com"\n'
const BLANK_POSTHOG_FILE = `export const AGENT_QA_POSTHOG_KEY = ""\n${POSTHOG_HOST_LINE}`
const BLANK_SENTRY_FILE = 'export const AGENT_QA_SENTRY_DSN = ""\n'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// The copy resolves `src/` beside its own folder, so the checkout's key files are never written.
async function packageCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-qa-analytics-key-files-'))
  roots.push(root)
  await mkdir(join(root, 'scripts'))
  await copyFile(
    join(PACKAGE_SRC_DIR, '..', 'scripts', SCRIPT_NAME),
    join(root, 'scripts', SCRIPT_NAME),
  )
  return root
}

function runScript(root: string): void {
  execFileSync(process.execPath, [join(root, 'scripts', SCRIPT_NAME)], { cwd: root })
}

async function readKeyFile(root: string, name: string): Promise<string | null> {
  const path = join(root, 'src', name)
  return existsSync(path) ? readFile(path, 'utf8') : null
}

describe('the key-file script', () => {
  it('writes a blank PostHog key file and a blank Sentry DSN file into a package with no src', async () => {
    const root = await packageCopy()

    runScript(root)

    expect(await readKeyFile(root, 'posthog-project.ts')).toBe(BLANK_POSTHOG_FILE)
    expect(await readKeyFile(root, 'sentry-project.ts')).toBe(BLANK_SENTRY_FILE)
  })

  it('leaves a Sentry DSN file that already holds a value byte for byte', async () => {
    const root = await packageCopy()
    const dsnFile = join(root, 'src', 'sentry-project.ts')
    const baked = Buffer.from(
      'export const AGENT_QA_SENTRY_DSN = "https://key@o0.ingest.example/1"\n',
    )
    runScript(root)
    await writeFile(dsnFile, baked)

    runScript(root)

    expect(await readFile(dsnFile)).toEqual(baked)
  })

  it('keeps a PostHog key file that holds a value and writes the blank Sentry DSN file beside it', async () => {
    const root = await packageCopy()
    const baked = `export const AGENT_QA_POSTHOG_KEY = "phc_test_key"\n${POSTHOG_HOST_LINE}`
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'posthog-project.ts'), baked)

    runScript(root)

    expect(await readKeyFile(root, 'posthog-project.ts')).toBe(baked)
    expect(await readKeyFile(root, 'sentry-project.ts')).toBe(BLANK_SENTRY_FILE)
  })
})

describe('the package root', () => {
  it('exports a blank Sentry DSN in a source checkout', () => {
    expect(AGENT_QA_SENTRY_DSN).toBe('')
  })
})
