import { describe, expect, it } from 'vitest'

import { configShapeScan } from '../config-shape-scan.js'

function issues(config: unknown): { path: PropertyKey[]; message: string }[] {
  const result = configShapeScan.safeParse(config)
  if (result.success) return []
  return result.error.issues.map((issue) => ({ path: issue.path, message: issue.message }))
}

describe('plugin entry shape sentences', () => {
  it('refuses an entry naming both package and path', () => {
    expect(
      issues({ plugins: [{ name: 'acme', package: '@acme/agent-qa-plugin', path: './acme' }] }),
    ).toEqual([
      {
        path: ['plugins', 0],
        message: 'Plugin entry acme names both package and path; an entry names one or the other.',
      },
    ])
  })

  it('refuses an entry naming neither package nor path', () => {
    expect(
      issues({ plugins: [{ name: 'acme', package: '@acme/agent-qa-plugin' }, { name: 'marker' }] }),
    ).toEqual([
      {
        path: ['plugins', 1],
        message:
          "Plugin entry marker names no package or path; add package with the plugin's npm name, or path with its folder.",
      },
    ])
  })

  it('refuses settings on an entry, pointing at options and the remotes', () => {
    expect(
      issues({ plugins: [{ name: 'acme', package: '@acme/agent-qa-plugin', settings: {} }] }),
    ).toEqual([
      {
        path: ['plugins', 0, 'settings'],
        message:
          "Plugin entry acme has settings; an entry's values go under options, and settings go on each remote that names the entry.",
      },
    ])
  })

  it('labels an entry with no name by its position', () => {
    expect(issues({ plugins: [{ package: '@acme/agent-qa-plugin' }, { settings: {} }] })).toEqual([
      {
        path: ['plugins', 1],
        message:
          "Plugin entry #1 names no package or path; add package with the plugin's npm name, or path with its folder.",
      },
      {
        path: ['plugins', 1, 'settings'],
        message:
          "Plugin entry #1 has settings; an entry's values go under options, and settings go on each remote that names the entry.",
      },
    ])
  })

  it('adds nothing for a well-formed list', () => {
    expect(
      issues({
        plugins: [
          { name: 'acme', package: '@acme/agent-qa-plugin', options: { pool: 'eu' } },
          { name: 'marker', path: './plugins/marker' },
        ],
      }),
    ).toEqual([])
  })

  it('adds nothing for an object plugins, a non-object item or a config without plugins', () => {
    expect(issues({ plugins: { entries: [{ package: '@acme/agent-qa-plugin' }] } })).toEqual([])
    expect(issues({ plugins: ['acme', 3, null] })).toEqual([])
    expect(issues({ workspace: {} })).toEqual([])
    expect(issues('not a config')).toEqual([])
  })
})
