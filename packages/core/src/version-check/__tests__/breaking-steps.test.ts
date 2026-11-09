import { describe, expect, it } from 'vitest'
import { agentQaBreakingSteps } from '../index.js'

describe('agent-qa breaking steps', () => {
  it('a patch inside one 0.x minor crosses nothing', () => {
    expect(agentQaBreakingSteps('0.3.0', '0.3.2')).toEqual([])
  })

  it('a 0.x minor bump crosses one step', () => {
    expect(agentQaBreakingSteps('0.3.2', '0.4.0')).toEqual([{ from: '0-3', to: '0-4' }])
  })

  it('two 0.x minor bumps cross one step each, in order', () => {
    expect(agentQaBreakingSteps('0.3.0', '0.5.1')).toEqual([
      { from: '0-3', to: '0-4' },
      { from: '0-4', to: '0-5' },
    ])
  })

  it('leaving 0.x crosses one step to the 1 line', () => {
    expect(agentQaBreakingSteps('0.9.1', '1.0.0')).toEqual([{ from: '0-9', to: '1' }])
  })

  it('leaving 0.x and then crossing majors names the 0.x line once', () => {
    expect(agentQaBreakingSteps('0.3.0', '2.1.0')).toEqual([
      { from: '0-3', to: '1' },
      { from: '1', to: '2' },
    ])
  })

  it('from 1.0 on each major bump is one step', () => {
    expect(agentQaBreakingSteps('1.2.0', '3.0.1')).toEqual([
      { from: '1', to: '2' },
      { from: '2', to: '3' },
    ])
  })

  it('a minor bump from 1.0 on crosses nothing', () => {
    expect(agentQaBreakingSteps('1.2.0', '1.9.3')).toEqual([])
  })

  it('a prerelease to its release crosses nothing', () => {
    expect(agentQaBreakingSteps('0.4.0-beta.1', '0.4.0')).toEqual([])
  })

  it('a release to the next minor prerelease crosses one step', () => {
    expect(agentQaBreakingSteps('0.3.4', '0.4.0-rc.1')).toEqual([{ from: '0-3', to: '0-4' }])
  })

  it('a move to an equal version crosses nothing', () => {
    expect(agentQaBreakingSteps('0.4.0', '0.4.0')).toEqual([])
  })

  it('a move to an older version crosses nothing', () => {
    expect(agentQaBreakingSteps('0.5.0', '0.3.0')).toEqual([])
  })

  it('a crafted jump across very many lines is one step naming both lines', () => {
    expect(agentQaBreakingSteps('0.3.0', '0.9007199254740991.0')).toEqual([
      { from: '0-3', to: '0-9007199254740991' },
    ])
    expect(agentQaBreakingSteps('1.0.0', '9007199254740991.0.0')).toEqual([
      { from: '1', to: '9007199254740991' },
    ])
  })

  it('a version that is not semver crosses nothing', () => {
    expect(agentQaBreakingSteps('latest', '0.4.0')).toEqual([])
    expect(agentQaBreakingSteps('0.3.0', '0.4.0/../../evil')).toEqual([])
  })
})
