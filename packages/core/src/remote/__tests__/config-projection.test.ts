import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { projectRemotesInConfigText } from '../config-projection.js'

const PATH_TOKEN = 'pathtoken-7f3a'
const QUERY_SECRET = 'querysecret-91bc'
const HEADER_VALUE = 'headervalue-c0de'

const CONFIG = [
  '# owner notes: the grid is the team one',
  'registry:',
  '  remotes:',
  '    - name: grid',
  '      protocol: playwright',
  `      url: wss://grid.example.com/${PATH_TOKEN}/playwright?key=${QUERY_SECRET}`,
  '      headers:',
  `        Authorization: Bearer ${HEADER_VALUE}`,
  '  llms:',
  '    - name: judge',
  '      provider: openai',
  'use: # the browser runs on the grid',
  '  browser:',
  '    name: chromium',
  '    remote: grid',
  '',
].join('\n')

describe('projectRemotesInConfigText', () => {
  it('keeps every comment and key outside registry.remotes and shows a remote by name, protocol and origin only', () => {
    const shown = projectRemotesInConfigText(CONFIG)

    expect(shown).toContain('# owner notes: the grid is the team one')
    expect(shown).toContain('# the browser runs on the grid')
    for (const hidden of [PATH_TOKEN, QUERY_SECRET, HEADER_VALUE, 'Authorization', 'headers']) {
      expect(shown).not.toContain(hidden)
    }
    const original = parseYaml(CONFIG) as Record<string, Record<string, unknown>>
    expect(parseYaml(shown)).toEqual({
      ...original,
      registry: {
        ...original.registry,
        remotes: [{ name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' }],
      },
    })
  })

  it('shows a remote whose url does not parse as invalid url', () => {
    const shown = projectRemotesInConfigText(
      [
        'registry:',
        '  remotes:',
        '    - name: grid',
        '      protocol: cdp',
        '      url: not a url',
        '',
      ].join('\n'),
    )

    expect(parseYaml(shown)).toEqual({
      registry: { remotes: [{ name: 'grid', protocol: 'cdp', url: 'invalid url' }] },
    })
  })

  it('returns a config with no remote list, or text that does not parse, unchanged', () => {
    const plain = '# notes\nuse:\n  browser:\n    name:   chromium\n'
    const broken = 'registry:\n  remotes: [\n'

    expect(projectRemotesInConfigText(plain)).toBe(plain)
    expect(projectRemotesInConfigText(broken)).toBe(broken)
  })
})
