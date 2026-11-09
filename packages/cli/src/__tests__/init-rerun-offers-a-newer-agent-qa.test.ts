import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InitDocument } from '../commands/init-document.js'
import type { LatestVersionAsk } from '../commands/latest-version-ask.js'
import type { FakeInitUiEntry } from './fake-init-ui.js'
import { cleanupTempProjects, tempProject } from './project-fixtures.js'
import { initializedProject, rerun } from './rerun-fixtures.js'

const { PROJECT_VERSION } = vi.hoisted(() => ({ PROJECT_VERSION: '0.3.0' }))

vi.mock('@vostride/agent-qa-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-core')>()),
  getAgentQaVersion: () => PROJECT_VERSION,
}))

afterEach(() => {
  cleanupTempProjects()
})

function summaryLines(entries: readonly FakeInitUiEntry[]): string[] {
  const entry = entries.find((item) => item.kind === 'summary')
  return entry?.kind === 'summary' ? entry.lines : []
}

function answering(answer: Awaited<ReturnType<LatestVersionAsk>>): LatestVersionAsk {
  return async () => answer
}

async function rerunAnswered(
  label: string,
  answer: Awaited<ReturnType<LatestVersionAsk>>,
  args: readonly string[] = [],
): Promise<Awaited<ReturnType<typeof rerun>>> {
  const project = await initializedProject(label)
  return await rerun(project, args, { hooks: { latestVersion: answering(answer) } })
}

describe('a re-run says whether a newer agent-qa is out', () => {
  it('says a newer patch is out when the check answers one', async () => {
    const result = await rerunAnswered('latest-patch', {
      source: 'registry',
      latestVersion: '0.3.2',
    })

    expect(result.exit, result.stderr).toBe(0)
    const lines = summaryLines(result.entries)
    expect(lines[0]).toBe(`You're on agent-qa ${PROJECT_VERSION}.`)
    expect(lines).toContain('agent-qa 0.3.2 is out.')
  })

  it("says the project is on the latest when the answer is the project's version", async () => {
    const result = await rerunAnswered('latest-equal', {
      source: 'registry',
      latestVersion: PROJECT_VERSION,
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(summaryLines(result.entries)[0]).toBe(
      `You're on agent-qa ${PROJECT_VERSION}, the latest.`,
    )
  })

  it('says nothing about a newer version when the check did not answer', async () => {
    const result = await rerunAnswered('latest-none', { source: 'none' })

    expect(result.exit, result.stderr).toBe(0)
    const lines = summaryLines(result.entries)
    expect(lines[0]).toBe(`You're on agent-qa ${PROJECT_VERSION}.`)
    expect(lines.join('\n')).not.toMatch(/is out|the latest|can change your config/u)
  })

  it('prints no newer-version line and no link for a cached answer that is not a version', async () => {
    const result = await rerunAnswered(
      'latest-crafted',
      { source: 'cache', latestVersion: '9.9.9 https://example.test/x' },
      ['--json'],
    )

    expect(result.exit, result.stderr).toBe(0)
    const lines = summaryLines(result.entries)
    expect(lines[0]).toBe(`You're on agent-qa ${PROJECT_VERSION}.`)
    expect(lines.join('\n')).not.toMatch(/is out|the latest|https?:/u)
    expect((JSON.parse(result.stdout) as InitDocument).latest).toEqual({ source: 'none' })
  })

  it('asks the check once, with the home folder', async () => {
    const project = await initializedProject('latest-asked-once')
    const asked: string[] = []

    const result = await rerun(project, [], {
      hooks: {
        latestVersion: async (home) => {
          asked.push(home)
          return { source: 'none' }
        },
      },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(asked).toEqual([project.home])
  })

  it('exits 0 and records no answer when the check throws', async () => {
    const project = await initializedProject('latest-throws')

    const result = await rerun(project, ['--json'], {
      hooks: {
        latestVersion: async () => {
          throw new Error('the registry is down')
        },
      },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect((JSON.parse(result.stdout) as InitDocument).latest).toEqual({ source: 'none' })
  })
})

describe("a re-run's summary says what upgrading to the newer agent-qa means", () => {
  it('points the coding agent at the migration guide for a release that can change the config', async () => {
    const result = await rerunAnswered('guide-one-step', {
      source: 'registry',
      latestVersion: '0.4.0',
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(summaryLines(result.entries).slice(0, 3)).toEqual([
      `You're on agent-qa ${PROJECT_VERSION}.`,
      'agent-qa 0.4.0 can change your config. To upgrade, point your coding agent at',
      'https://vostride.com/docs/agent-qa/migrate/v0-3-to-v0-4',
    ])
  })

  it('names one migration guide per breaking step crossed', async () => {
    const result = await rerunAnswered('guide-two-steps', {
      source: 'cache',
      latestVersion: '0.5.1',
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(summaryLines(result.entries).slice(0, 4)).toEqual([
      `You're on agent-qa ${PROJECT_VERSION}.`,
      'agent-qa 0.5.1 can change your config. To upgrade, point your coding agent at',
      'https://vostride.com/docs/agent-qa/migrate/v0-3-to-v0-4',
      'https://vostride.com/docs/agent-qa/migrate/v0-4-to-v0-5',
    ])
  })

  it('links the release notes for a patch', async () => {
    const result = await rerunAnswered('notes-patch', {
      source: 'registry',
      latestVersion: '0.3.2',
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(summaryLines(result.entries).slice(0, 3)).toEqual([
      `You're on agent-qa ${PROJECT_VERSION}.`,
      'agent-qa 0.3.2 is out.',
      'https://github.com/vostride/agent-qa/releases/tag/v0.3.2',
    ])
  })
})

describe("the re-run's --json document records what the check found", () => {
  it('records the source and the version of a registry answer', async () => {
    const result = await rerunAnswered(
      'latest-json-registry',
      { source: 'registry', latestVersion: '0.4.0' },
      ['--json'],
    )

    expect(result.exit, result.stderr).toBe(0)
    expect((JSON.parse(result.stdout) as InitDocument).latest).toEqual({
      source: 'registry',
      version: '0.4.0',
    })
  })

  it('records the source and the version of a cached answer', async () => {
    const result = await rerunAnswered(
      'latest-json-cache',
      { source: 'cache', latestVersion: '0.3.2' },
      ['--json'],
    )

    expect(result.exit, result.stderr).toBe(0)
    expect((JSON.parse(result.stdout) as InitDocument).latest).toEqual({
      source: 'cache',
      version: '0.3.2',
    })
  })

  it('records the source alone when the check did not answer', async () => {
    const result = await rerunAnswered('latest-json-none', { source: 'none' }, ['--json'])

    expect(result.exit, result.stderr).toBe(0)
    expect((JSON.parse(result.stdout) as InitDocument).latest).toEqual({ source: 'none' })
  })

  it("leaves the latest key out of a fresh init's document", async () => {
    const project = tempProject('latest-json-fresh')
    const asked: string[] = []

    const result = await rerun(
      project,
      ['--yes', '--json', '--pm', 'none', '--no-browsers', '--agents', 'none', '--llm', 'gemini'],
      {
        hooks: {
          latestVersion: async (home) => {
            asked.push(home)
            return { source: 'registry', latestVersion: '0.4.0' }
          },
        },
      },
    )

    expect(result.exit, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).not.toHaveProperty('latest')
    expect(asked).toEqual([])
  })
})
