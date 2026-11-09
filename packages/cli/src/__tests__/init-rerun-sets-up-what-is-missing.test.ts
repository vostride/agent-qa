import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { InitDocument } from '../commands/init-document.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { cleanupTempProjects, fakeRunner } from './project-fixtures.js'
import { initializedProject, rerun } from './rerun-fixtures.js'

const OLD_STOP = /already initialized|Use --force to rebuild/u

afterEach(() => {
  cleanupTempProjects()
})

function contents(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files[path] = readFileSync(path, 'base64')
  }
  return files
}

describe('a re-run of init in an initialized project', () => {
  it('draws the intro, a done validate step and the outro, and exits 0', async () => {
    const project = await initializedProject('rerun-validates')

    const result = await rerun(project)

    expect(result.exit, result.stderr).toBe(0)
    const kinds = result.entries.map((entry) => entry.kind)
    expect(kinds[0]).toBe('intro')
    expect(kinds.at(-1)).toBe('outro')
    expect(result.entries).toContainEqual({
      kind: 'step',
      text: 'Validating the config and tests',
    })
    expect(result.entries).toContainEqual({
      kind: 'done',
      text: 'validate: the config and tests are valid',
    })
    const texts = result.entries.map((entry) => entry.text).join('\n')
    expect(texts).not.toMatch(OLD_STOP)
  })

  it('with --yes and nothing to repair changes no byte of the project', async () => {
    const project = await initializedProject('rerun-keeps-bytes')
    const before = contents(project.root)

    const result = await rerun(project, ['--yes'])

    expect(result.exit, result.stderr).toBe(0)
    expect(contents(project.root)).toEqual(before)
  })

  it('with --json prints one done document whose steps end in a done validate', async () => {
    const project = await initializedProject('rerun-json')

    const result = await rerun(project, ['--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc).toMatchObject({ format: 1, outcome: 'done', exitCode: 0, files: [] })
    expect(doc.steps.at(-1)).toEqual({ name: 'validate', outcome: 'done' })
    expect(doc.steps.filter((step) => OLD_STOP.test(step.reason ?? ''))).toEqual([])
    expect(result.stderr).not.toMatch(OLD_STOP)
  })

  it('exits 3 with the validate step failed when the project does not validate', async () => {
    const project = await initializedProject('rerun-invalid')
    const run = fakeRunner(({ args }) =>
      args.includes('validate')
        ? { code: 1, signal: null, output: 'tests/broken.yaml\n  1:1  error  bad step\n' }
        : { code: 0, signal: null, output: '' },
    )

    const result = await rerun(project, ['--json'], { run, plain: true })

    expect(result.exit).toBe(3)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc).toMatchObject({ outcome: 'failed', exitCode: 3 })
    expect(doc.steps.at(-1)).toMatchObject({ name: 'validate', outcome: 'failed' })
  })

  it('reports one agent-qa.init.completed event that reads unchanged', async () => {
    const project = await initializedProject('rerun-analytics')
    const sent: { name: string; properties: Record<string, unknown> }[] = []
    const composeAnalytics: typeof composeAnalyticsHost = async () =>
      composeAnalyticsHost({
        surface: 'cli',
        env: {},
        transportOverride: {
          capture: (payload) => {
            sent.push(payload.event as (typeof sent)[number])
          },
          flush: () => {},
          shutdown: () => {},
        },
        resolveIdentity: async () => ({ distinctId: 'u_init-rerun', runtimeContext: 'user' }),
      })

    const result = await rerun(project, ['--yes'], { hooks: { composeAnalytics } })

    expect(result.exit, result.stderr).toBe(0)
    const completed = sent.filter((event) => event.name === 'agent-qa.init.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.properties).toMatchObject({
      outcome: 'unchanged',
      created_file_count: 0,
    })
  })
})
