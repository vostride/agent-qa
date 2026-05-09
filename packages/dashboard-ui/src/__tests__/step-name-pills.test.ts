import { describe, it, expect } from 'vitest'
import { parseSegments, pillBgColor } from '../components/run-detail/step-name-pills.js'

describe('parseSegments', () => {
  it('parses single variable in middle of text', () => {
    const result = parseSegments(
      'Click on {{env:BUTTON_NAME}}',
      'Click on Submit',
      { BUTTON_NAME: { value: 'Submit', source: 'env' } }
    )
    expect(result).toEqual([
      { type: 'text', value: 'Click on ' },
      { type: 'pill', resolvedValue: 'Submit', varName: 'BUTTON_NAME', namespace: 'env', templateSyntax: '{{env:BUTTON_NAME}}' },
    ])
  })

  it('parses multiple variables with text between', () => {
    const result = parseSegments(
      'Navigate to {{env:URL}} and click {{env:TITLE}}',
      'Navigate to https://example.com and click Home',
      { URL: { value: 'https://example.com', source: 'env' }, TITLE: { value: 'Home', source: 'capture' } }
    )
    expect(result).toEqual([
      { type: 'text', value: 'Navigate to ' },
      { type: 'pill', resolvedValue: 'https://example.com', varName: 'URL', namespace: 'env', templateSyntax: '{{env:URL}}' },
      { type: 'text', value: ' and click ' },
      { type: 'pill', resolvedValue: 'Home', varName: 'TITLE', namespace: 'env', templateSyntax: '{{env:TITLE}}' },
    ])
  })

  it('returns single text segment when no variables', () => {
    const result = parseSegments(
      'No variables here',
      'No variables here',
      null
    )
    expect(result).toEqual([
      { type: 'text', value: 'No variables here' },
    ])
  })

  it('handles adjacent variables using snapshot value lengths', () => {
    const result = parseSegments(
      '{{env:FIRST}}{{env:LAST}}',
      'JohnDoe',
      { FIRST: { value: 'John', source: 'env' }, LAST: { value: 'Doe', source: 'env' } }
    )
    expect(result).toEqual([
      { type: 'pill', resolvedValue: 'John', varName: 'FIRST', namespace: 'env', templateSyntax: '{{env:FIRST}}' },
      { type: 'pill', resolvedValue: 'Doe', varName: 'LAST', namespace: 'env', templateSyntax: '{{env:LAST}}' },
    ])
  })

  it('skips pill when resolved value equals template syntax (unresolved variable)', () => {
    const result = parseSegments(
      'Click {{env:MISSING}}',
      'Click {{env:MISSING}}',
      null
    )
    expect(result).toEqual([
      { type: 'text', value: 'Click ' },
      { type: 'text', value: '{{env:MISSING}}' },
    ])
  })

  it('handles single character resolved value', () => {
    const result = parseSegments(
      'Step {{env:X}}',
      'Step 1',
      { X: { value: '1', source: 'env' } }
    )
    expect(result).toEqual([
      { type: 'text', value: 'Step ' },
      { type: 'pill', resolvedValue: '1', varName: 'X', namespace: 'env', templateSyntax: '{{env:X}}' },
    ])
  })

  it('handles variable at start of string', () => {
    const result = parseSegments(
      '{{env:ACTION}} the button',
      'Click the button',
      { ACTION: { value: 'Click', source: 'env' } }
    )
    expect(result).toEqual([
      { type: 'pill', resolvedValue: 'Click', varName: 'ACTION', namespace: 'env', templateSyntax: '{{env:ACTION}}' },
      { type: 'text', value: ' the button' },
    ])
  })

  it('handles variable at end of string', () => {
    const result = parseSegments(
      'Click on {{env:TARGET}}',
      'Click on Submit Button',
      { TARGET: { value: 'Submit Button', source: 'env' } }
    )
    expect(result).toEqual([
      { type: 'text', value: 'Click on ' },
      { type: 'pill', resolvedValue: 'Submit Button', varName: 'TARGET', namespace: 'env', templateSyntax: '{{env:TARGET}}' },
    ])
  })

  it('runJS before env: longer resolved', () => {
    const result = parseSegments(
      'Verify "{{runJS:"doc.title"}}" matches "{{env:hn_top_title}}"',
      'Verify "The Cognitive Dark Forest" matches "ChatGPT"',
      { hn_top_title: { value: 'ChatGPT', source: 'env' } }
    )
    expect(result).toEqual([
      { type: 'text', value: 'Verify "' },
      { type: 'pill', resolvedValue: 'The Cognitive Dark Forest', varName: '"doc.title"', namespace: 'runJS', templateSyntax: '{{runJS:"doc.title"}}' },
      { type: 'text', value: '" matches "' },
      { type: 'pill', resolvedValue: 'ChatGPT', varName: 'hn_top_title', namespace: 'env', templateSyntax: '{{env:hn_top_title}}' },
      { type: 'text', value: '"' },
    ])
  })

  it('runJS before env: shorter resolved', () => {
    const result = parseSegments(
      'Title is {{runJS:"x"}} and {{env:COLOR}}',
      'Title is LongExpandedValue and blue',
      { COLOR: { value: 'blue', source: 'env' } }
    )
    expect(result).toEqual([
      { type: 'text', value: 'Title is ' },
      { type: 'pill', resolvedValue: 'LongExpandedValue', varName: '"x"', namespace: 'runJS', templateSyntax: '{{runJS:"x"}}' },
      { type: 'text', value: ' and ' },
      { type: 'pill', resolvedValue: 'blue', varName: 'COLOR', namespace: 'env', templateSyntax: '{{env:COLOR}}' },
    ])
  })

  it('multiple runJS with env between', () => {
    const result = parseSegments(
      '{{runJS:"a"}} then {{env:MID}} then {{runJS:"b"}}',
      'AAAA then hello then BB',
      { MID: { value: 'hello', source: 'env' } }
    )
    expect(result).toEqual([
      { type: 'pill', resolvedValue: 'AAAA', varName: '"a"', namespace: 'runJS', templateSyntax: '{{runJS:"a"}}' },
      { type: 'text', value: ' then ' },
      { type: 'pill', resolvedValue: 'hello', varName: 'MID', namespace: 'env', templateSyntax: '{{env:MID}}' },
      { type: 'text', value: ' then ' },
      { type: 'pill', resolvedValue: 'BB', varName: '"b"', namespace: 'runJS', templateSyntax: '{{runJS:"b"}}' },
    ])
  })

  it('runJS resolves to empty string', () => {
    const result = parseSegments(
      'Value is {{runJS:"x"}} here',
      'Value is  here',
      null
    )
    expect(result).toEqual([
      { type: 'text', value: 'Value is ' },
      { type: 'pill', resolvedValue: '', varName: '"x"', namespace: 'runJS', templateSyntax: '{{runJS:"x"}}' },
      { type: 'text', value: ' here' },
    ])
  })

  it('step entirely is runJS', () => {
    const result = parseSegments(
      '{{runJS:"document.title"}}',
      'My Page',
      null
    )
    expect(result).toEqual([
      { type: 'pill', resolvedValue: 'My Page', varName: '"document.title"', namespace: 'runJS', templateSyntax: '{{runJS:"document.title"}}' },
    ])
  })

  it('runJS resolves to undefined', () => {
    const result = parseSegments(
      'Got {{runJS:"void 0"}}',
      'Got undefined',
      null
    )
    expect(result).toEqual([
      { type: 'text', value: 'Got ' },
      { type: 'pill', resolvedValue: 'undefined', varName: '"void 0"', namespace: 'runJS', templateSyntax: '{{runJS:"void 0"}}' },
    ])
  })

  it('runHook before env', () => {
    const result = parseSegments(
      'Got {{runHook:"fetch"}} for {{env:KEY}}',
      'Got longresult for val',
      { KEY: { value: 'val', source: 'env' } }
    )
    expect(result).toEqual([
      { type: 'text', value: 'Got ' },
      { type: 'pill', resolvedValue: 'longresult', varName: '"fetch"', namespace: 'runHook', templateSyntax: '{{runHook:"fetch"}}' },
      { type: 'text', value: ' for ' },
      { type: 'pill', resolvedValue: 'val', varName: 'KEY', namespace: 'env', templateSyntax: '{{env:KEY}}' },
    ])
  })
})

describe('pillBgColor', () => {
  it('returns blue background for env source', () => {
    expect(pillBgColor('env')).toBe('bg-blue-500/15 border border-blue-500/20')
  })

  it('returns emerald background for capture source', () => {
    expect(pillBgColor('capture')).toBe('bg-emerald-500/15 border border-emerald-500/20')
  })

  it('returns purple background for cli source', () => {
    expect(pillBgColor('cli')).toBe('bg-purple-500/15 border border-purple-500/20')
  })

  it('returns amber background for inline source', () => {
    expect(pillBgColor('inline')).toBe('bg-amber-500/15 border border-amber-500/20')
  })

  it('returns cyan background for suite source', () => {
    expect(pillBgColor('suite')).toBe('bg-cyan-500/15 border border-cyan-500/20')
  })

  it('returns orange background for hook source', () => {
    expect(pillBgColor('hook')).toBe('bg-orange-500/15 border border-orange-500/20')
  })

  it('returns teal background for step source', () => {
    expect(pillBgColor('step')).toBe('bg-teal-500/15 border border-teal-500/20')
  })

  it('returns yellow background for runJS source', () => {
    expect(pillBgColor('runJS')).toBe('bg-yellow-500/15 border border-yellow-500/20')
  })

  it('returns orange-600 background for runHook source', () => {
    expect(pillBgColor('runHook')).toBe('bg-orange-600/15 border border-orange-600/20')
  })

  it('returns accent fallback for undefined source', () => {
    expect(pillBgColor(undefined)).toBe('bg-accent/20 border border-accent/20')
  })

  it('returns accent fallback for unknown source', () => {
    expect(pillBgColor('unknown')).toBe('bg-accent/20 border border-accent/20')
  })
})
