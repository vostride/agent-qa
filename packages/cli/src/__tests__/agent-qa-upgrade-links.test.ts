import { describe, expect, it } from 'vitest'

import {
  guideLines,
  migrateGuideUrl,
  releaseNotesUrl,
  versionMove,
} from '../commands/agent-qa-upgrade.js'

describe('agent-qa upgrade links', () => {
  it('a step names its migration guide by each side of the step', () => {
    expect(migrateGuideUrl({ from: '0-3', to: '0-4' })).toBe(
      'https://vostride.com/docs/agent-qa/migrate/v0-3-to-v0-4',
    )
    expect(migrateGuideUrl({ from: '0-9', to: '1' })).toBe(
      'https://vostride.com/docs/agent-qa/migrate/v0-9-to-v1',
    )
    expect(migrateGuideUrl({ from: '1', to: '2' })).toBe(
      'https://vostride.com/docs/agent-qa/migrate/v1-to-v2',
    )
  })

  it("a version's release notes are its tag on the releases page", () => {
    expect(releaseNotesUrl('0.3.2')).toBe(
      'https://github.com/vostride/agent-qa/releases/tag/v0.3.2',
    )
  })

  it('a version that is not semver has no release notes link', () => {
    expect(releaseNotesUrl('0.3.2/../../evil')).toBeUndefined()
  })

  it('a move across a 0.x minor is breaking and links its guide', () => {
    expect(versionMove('0.3.0', '0.4.0')).toEqual({
      from: '0.3.0',
      to: '0.4.0',
      breaking: true,
      links: ['https://vostride.com/docs/agent-qa/migrate/v0-3-to-v0-4'],
    })
  })

  it('a move across two steps links one guide per step', () => {
    expect(versionMove('0.3.0', '0.5.1')?.links).toEqual([
      'https://vostride.com/docs/agent-qa/migrate/v0-3-to-v0-4',
      'https://vostride.com/docs/agent-qa/migrate/v0-4-to-v0-5',
    ])
  })

  it('a patch move is not breaking and links its release notes', () => {
    expect(versionMove('0.3.0', '0.3.2')).toEqual({
      from: '0.3.0',
      to: '0.3.2',
      breaking: false,
      links: ['https://github.com/vostride/agent-qa/releases/tag/v0.3.2'],
    })
  })

  it('a move names each version in its semver form', () => {
    expect(versionMove('v0.3.0', 'v0.3.2')).toMatchObject({
      from: '0.3.0',
      to: '0.3.2',
      links: ['https://github.com/vostride/agent-qa/releases/tag/v0.3.2'],
    })
  })

  it('a version that is not semver gives no move and no link', () => {
    expect(versionMove('0.3.0', '0.4.0"; rm -rf ~')).toBeUndefined()
    expect(versionMove('workspace:*', '0.4.0')).toBeUndefined()
  })

  it('a move to an equal or older version is no move', () => {
    expect(versionMove('0.4.0', '0.4.0')).toBeUndefined()
    expect(versionMove('0.5.0', '0.4.0')).toBeUndefined()
  })

  it('the guide lines name the target version and then one guide per line', () => {
    const move = versionMove('0.3.0', '0.5.1')
    expect(move && guideLines(move)).toEqual([
      'agent-qa 0.5.1 can change your config. To upgrade, point your coding agent at',
      'https://vostride.com/docs/agent-qa/migrate/v0-3-to-v0-4',
      'https://vostride.com/docs/agent-qa/migrate/v0-4-to-v0-5',
    ])
  })

  it('a patch move has no guide lines', () => {
    const move = versionMove('0.3.0', '0.3.2')
    expect(move && guideLines(move)).toEqual([])
  })
})
