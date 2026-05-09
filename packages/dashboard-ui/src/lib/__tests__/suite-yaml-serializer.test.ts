import { parseDocument, isMap } from 'yaml'
import { describe, it, expect } from 'vitest'
import {
  suiteYamlToFormState,
  updateSuiteField,
  reorderSuiteTests,
  addSuiteTest,
  removeSuiteTest,
} from '../suite-yaml-serializer'

function getTopLevelKeys(yaml: string): string[] {
  const doc = parseDocument(yaml)
  if (!isMap(doc.contents)) return []
  return doc.contents.items.map((item) => String(item.key))
}

describe('suiteYamlToFormState', () => {
  it('parses a valid suite into form state with {test, id} entries', () => {
    const yaml = [
      'name: Smoke',
      'suite-id: s_able-acre-add-age-ago-air',
      'target: web',
      'tests:',
      '  - test: a.yaml',
      '    id: t_a',
      '  - test: b.yaml',
      '    id: t_b',
    ].join('\n')
    const state = suiteYamlToFormState(yaml)
    expect(state).not.toBeNull()
    expect(state!.name).toBe('Smoke')
    expect(state!.suiteId).toBe('s_able-acre-add-age-ago-air')
    expect(state!.target).toBe('web')
    expect(state!.tests).toEqual([
      { test: 'a.yaml', id: 't_a' },
      { test: 'b.yaml', id: 't_b' },
    ])
  })

  it('returns null on YAML parse error', () => {
    expect(suiteYamlToFormState('name: [unclosed')).toBeNull()
  })

  it('drops malformed test entries without corrupting to [object Object]', () => {
    const yaml = [
      'name: S',
      'target: t',
      'tests:',
      '  - test: a.yaml',
      '    id: t_a',
      '  - broken_entry',
    ].join('\n')
    const state = suiteYamlToFormState(yaml)
    expect(state!.tests).toEqual([{ test: 'a.yaml', id: 't_a' }])
  })
})

describe('root key ordering', () => {
  it('normalizes unordered root keys to the canonical order', () => {
    const yaml = [
      'tests:',
      '  - test: a.yaml',
      '    id: t_a',
      'teardown:',
      '  - cleanup',
      'context: preamble',
      'setup:',
      '  - login',
      'target: dashboard',
      'use:',
      '  browser:',
      '    name: chromium',
      'custom-flag: keep-me',
      'name: Smoke',
      'suite-id: s_able-acre-add-age-ago-air',
    ].join('\n')
    const result = updateSuiteField(yaml, ['name'], 'Smoke Renamed')
    expect(getTopLevelKeys(result)).toEqual([
      'name',
      'suite-id',
      'target',
      'use',
      'context',
      'setup',
      'tests',
      'teardown',
      'custom-flag',
    ])
  })
})

describe('{test, id} round-trip', () => {
  const base = [
    'name: Smoke',
    'target: web',
    'tests:',
    '  - test: a.yaml',
    '    id: t_a',
    '  - test: b.yaml',
    '    id: t_b',
  ].join('\n')

  it('preserves object shape after reorder (no [object Object])', () => {
    const after = reorderSuiteTests(base, 0, 1)
    expect(after).toContain('test: b.yaml')
    expect(after).toContain('id: t_b')
    expect(after).toContain('test: a.yaml')
    expect(after).toContain('id: t_a')
    expect(after).not.toContain('[object Object]')
  })

  it('addSuiteTest appends a new {test, id} entry', () => {
    const after = addSuiteTest(base, { test: 'c.yaml', id: 't_c' })
    expect(after).toContain('test: c.yaml')
    expect(after).toContain('id: t_c')
    const state = suiteYamlToFormState(after)
    expect(state!.tests).toHaveLength(3)
  })

  it('removeSuiteTest removes entry at index and deletes key when empty', () => {
    const afterOne = removeSuiteTest(base, 1)
    const state1 = suiteYamlToFormState(afterOne)
    expect(state1!.tests).toEqual([{ test: 'a.yaml', id: 't_a' }])
    const afterBoth = removeSuiteTest(afterOne, 0)
    const state2 = suiteYamlToFormState(afterBoth)
    expect(state2!.tests).toEqual([])
    expect(afterBoth).not.toContain('tests:')
  })

  it('reorder out-of-bounds is a no-op', () => {
    expect(reorderSuiteTests(base, 0, 99)).toBe(base)
    expect(reorderSuiteTests(base, -1, 0)).toBe(base)
  })
})
