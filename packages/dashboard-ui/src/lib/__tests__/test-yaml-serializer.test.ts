import { parseDocument, isMap } from 'yaml'
import { describe, it, expect } from 'vitest'
import {
  yamlToFormState,
  updateYamlField,
  updateYamlStep,
  updateYamlStepOverride,
  reorderYamlList,
  formStateToYaml,
} from '../test-yaml-serializer.js'

function getTopLevelKeys(yaml: string): string[] {
  const doc = parseDocument(yaml)
  if (!isMap(doc.contents)) return []
  return doc.contents.items.map((item) => String(item.key))
}

describe('yamlToFormState', () => {
  it('parses name, target, context, and testId from YAML', () => {
    const yaml = [
      'test-id: t_abc-def-ghi-jkl-mno-pqr',
      'name: Login Test',
      'target: my-app',
      'context: user auth flow',
      'steps:',
      '  - Navigate to login page',
    ].join('\n')

    const state = yamlToFormState(yaml)
    expect(state).not.toBeNull()
    expect(state!.name).toBe('Login Test')
    expect(state!.target).toBe('my-app')
    expect(state!.context).toBe('user auth flow')
    expect(state!.testId).toBe('t_abc-def-ghi-jkl-mno-pqr')
    expect(state!.setup).toEqual([])
    expect(state!.teardown).toEqual([])
  })

  it('returns testId as empty string when test-id field is absent', () => {
    const yaml = [
      'name: No ID Test',
      'target: app',
      'steps:',
      '  - Click button',
    ].join('\n')

    const state = yamlToFormState(yaml)
    expect(state).not.toBeNull()
    expect(state!.testId).toBe('')
  })

  it('maps string steps to StepFormState with empty overrides', () => {
    const yaml = [
      'name: Test',
      'target: app',
      'steps:',
      '  - Navigate to homepage',
      '  - Click login button',
    ].join('\n')

    const state = yamlToFormState(yaml)
    expect(state).not.toBeNull()
    expect(state!.steps).toEqual([
      { text: 'Navigate to homepage', overrides: {} },
      { text: 'Click login button', overrides: {} },
    ])
  })

  it('maps object steps to StepFormState with overrides', () => {
    const yaml = [
      'name: Test',
      'target: app',
      'steps:',
      '  - step: Click login',
      '    timeout: 30s',
      '    retries: 3',
    ].join('\n')

    const state = yamlToFormState(yaml)
    expect(state).not.toBeNull()
    expect(state!.steps).toHaveLength(1)
    expect(state!.steps[0].text).toBe('Click login')
    expect(state!.steps[0].overrides.timeout).toBe('30s')
    expect(state!.steps[0].overrides.retries).toBe(3)
    expect(state!.steps[0].overrides.screenshot).toBeUndefined()
    expect(state!.steps[0].overrides.maxAttempts).toBeUndefined()
  })

  it('parses setup and teardown hooks from YAML', () => {
    const yaml = [
      'name: Hooked Test',
      'target: app',
      'setup:',
      '  - login',
      'steps:',
      '  - Click dashboard',
      'teardown:',
      '  - cleanup',
    ].join('\n')

    const state = yamlToFormState(yaml)
    expect(state).not.toBeNull()
    expect(state!.setup).toEqual(['login'])
    expect(state!.teardown).toEqual(['cleanup'])
  })

  it('returns null for invalid YAML', () => {
    expect(yamlToFormState('{{{')).toBeNull()
  })
})

describe('updateYamlStep', () => {
  it('editing text of a string step replaces it', () => {
    const yaml = [
      'name: Test',
      'target: app',
      'steps:',
      '  - Click old button',
    ].join('\n')

    const result = updateYamlStep(yaml, 0, 'Click new button')
    expect(result).toContain('Click new button')
    expect(result).not.toContain('Click old button')
  })

  it('editing text of an object step preserves override fields', () => {
    const yaml = [
      'name: Test',
      'target: app',
      'steps:',
      '  - step: Click login',
      '    timeout: 30s',
      '    retries: 2',
    ].join('\n')

    const result = updateYamlStep(yaml, 0, 'Click submit')
    expect(result).toContain('Click submit')
    expect(result).toContain('timeout: 30s')
    expect(result).toContain('retries: 2')
    expect(result).not.toContain('Click login')
  })
})

describe('updateYamlStepOverride', () => {
  it('adding timeout to a string step converts it to object step', () => {
    const yaml = [
      'name: Test',
      'target: app',
      'steps:',
      '  - Click button',
    ].join('\n')

    const result = updateYamlStepOverride(yaml, 0, 'timeout', '60s')
    expect(result).toContain('step: Click button')
    expect(result).toContain('timeout: 60s')
  })

  it('removing the last override converts object step back to string', () => {
    const yaml = [
      'name: Test',
      'target: app',
      'steps:',
      '  - step: Click button',
      '    timeout: 60s',
    ].join('\n')

    const result = updateYamlStepOverride(yaml, 0, 'timeout', undefined)
    const state = yamlToFormState(result)
    expect(state).not.toBeNull()
    expect(state!.steps[0].text).toBe('Click button')
    expect(state!.steps[0].overrides).toEqual({})
  })

  it('updating an override preserves other fields', () => {
    const yaml = [
      'name: Test',
      'target: app',
      'steps:',
      '  - step: Click button',
      '    timeout: 30s',
      '    retries: 2',
    ].join('\n')

    const result = updateYamlStepOverride(yaml, 0, 'timeout', '60s')
    expect(result).toContain('timeout: 60s')
    expect(result).toContain('retries: 2')
    expect(result).toContain('step: Click button')
  })
})

describe('root key ordering', () => {
  it('updateYamlField normalizes unordered root keys to the canonical order', () => {
    const yaml = [
      'steps:',
      '  - Click login',
      'teardown:',
      '  - cleanup',
      'meta:',
      '  owner: qa',
      'context: current session note',
      'setup:',
      '  - login',
      'target: dashboard',
      'use:',
      '  browser: chromium',
      'custom-flag: keep-me',
      'name: Hooked Test',
      'test-id: t_able-acre-add-age-ago-air',
    ].join('\n')

    const result = updateYamlField(yaml, ['name'], 'Hooked Test Renamed')

    expect(getTopLevelKeys(result)).toEqual([
      'name',
      'test-id',
      'target',
      'use',
      'meta',
      'context',
      'setup',
      'steps',
      'teardown',
      'custom-flag',
    ])
  })

  it('keeps context immediately after meta when both keys exist', () => {
    const yaml = [
      'steps:',
      '  - Click login',
      'context: current session note',
      'meta:',
      '  owner: qa',
      'name: Hooked Test',
      'target: dashboard',
    ].join('\n')

    const result = updateYamlField(yaml, ['setup'], ['login'])

    expect(getTopLevelKeys(result)).toEqual([
      'name',
      'target',
      'meta',
      'context',
      'setup',
      'steps',
    ])
  })

  it('reordering steps keeps setup before steps and teardown after steps', () => {
    const yaml = [
      'teardown:',
      '  - cleanup',
      'steps:',
      '  - First step',
      '  - Second step',
      'setup:',
      '  - login',
      'context: current session note',
      'meta:',
      '  owner: qa',
      'name: Hooked Test',
      'target: dashboard',
    ].join('\n')

    const result = reorderYamlList(yaml, 'steps', 0, 1)

    expect(getTopLevelKeys(result)).toEqual([
      'name',
      'target',
      'meta',
      'context',
      'setup',
      'steps',
      'teardown',
    ])
    expect(result).toContain('- Second step')
    expect(result.indexOf('setup:')).toBeLessThan(result.indexOf('steps:'))
    expect(result.indexOf('steps:')).toBeLessThan(result.indexOf('teardown:'))
  })

  it('keeps unknown root keys after the canonical ordered keys', () => {
    const yaml = [
      'custom-before: alpha',
      'steps:',
      '  - First step',
      '  - Second step',
      'custom-after: omega',
      'setup:',
      '  - login',
      'context: current session note',
      'meta:',
      '  owner: qa',
      'name: Hooked Test',
      'target: dashboard',
      'teardown:',
      '  - cleanup',
    ].join('\n')

    const result = reorderYamlList(yaml, 'steps', 0, 1)
    const keys = getTopLevelKeys(result)
    const canonicalKeys = keys.slice(0, 7)
    const unknownKeys = keys.slice(7)

    expect(canonicalKeys).toEqual([
      'name',
      'target',
      'meta',
      'context',
      'setup',
      'steps',
      'teardown',
    ])
    expect(unknownKeys).toEqual(expect.arrayContaining(['custom-before', 'custom-after']))
  })
})

describe('formStateToYaml', () => {
  it('steps with no overrides serialize as strings', () => {
    const yaml = formStateToYaml({
      name: 'Test',
      testId: '',
      target: 'app',
      context: '',
      setup: [],
      steps: [
        { text: 'Click button', overrides: {} },
        { text: 'Type hello', overrides: {} },
      ],
      teardown: [],
    })

    expect(yaml).toContain('- Click button')
    expect(yaml).toContain('- Type hello')
    expect(yaml).not.toContain('step:')
  })

  it('steps with overrides serialize as objects', () => {
    const yaml = formStateToYaml({
      name: 'Test',
      testId: '',
      target: 'app',
      context: '',
      setup: [],
      steps: [
        { text: 'Click login', overrides: { timeout: '30s', retries: 3 } },
      ],
      teardown: [],
    })

    expect(yaml).toContain('step: Click login')
    expect(yaml).toContain('timeout: 30s')
    expect(yaml).toContain('retries: 3')
  })

  it('testId is included when non-empty', () => {
    const yaml = formStateToYaml({
      name: 'Test',
      testId: 't_able-acre-add-age-ago-air',
      target: 'app',
      context: '',
      setup: [],
      steps: [{ text: 'Click', overrides: {} }],
      teardown: [],
    })

    expect(yaml).toContain('test-id: t_able-acre-add-age-ago-air')
  })

  it('testId is omitted when empty', () => {
    const yaml = formStateToYaml({
      name: 'Test',
      testId: '',
      target: 'app',
      context: '',
      setup: [],
      steps: [{ text: 'Click', overrides: {} }],
      teardown: [],
    })

    expect(yaml).not.toContain('test-id')
  })

  it('serializes setup and teardown hooks when present', () => {
    const yaml = formStateToYaml({
      name: 'Hooked Test',
      testId: '',
      target: 'app',
      context: '',
      setup: ['login'],
      steps: [{ text: 'Click', overrides: {} }],
      teardown: ['cleanup'],
    })

    expect(yaml).toContain('setup:')
    expect(yaml).toContain('- login')
    expect(yaml).toContain('teardown:')
    expect(yaml).toContain('- cleanup')
  })

  it('omits empty setup and teardown arrays', () => {
    const yaml = formStateToYaml({
      name: 'Test',
      testId: '',
      target: 'app',
      context: '',
      setup: [],
      steps: [{ text: 'Click', overrides: {} }],
      teardown: [],
    })

    expect(yaml).not.toContain('setup:')
    expect(yaml).not.toContain('teardown:')
  })
})
