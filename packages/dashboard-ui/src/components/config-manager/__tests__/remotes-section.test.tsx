// @vitest-environment jsdom

import {
  connectionSecretNames,
  NAME_SLUG_PATTERN,
  REMOTE_PROTOCOLS,
  remoteEntryIssues,
  remoteOrigin,
} from '@vostride/agent-qa-schema'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { RemotesSection } from '@/components/config-manager/remotes-section'
import {
  DEFAULT_BADGE,
  REMOTES_COPY,
  remoteCredentialsLine,
  remoteDefaultLine,
  remoteNotListedLine,
} from '@/lib/config-copy'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TWO_REMOTES = {
  registry: {
    remotes: [
      { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' },
      { name: 'lab', protocol: 'cdp', url: 'ws://10.0.0.5:9222' },
    ],
  },
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function show(config: Record<string, unknown>) {
  act(() => {
    root.render(
      <section data-config-section="remotes">
        <RemotesSection config={config} />
      </section>,
    )
  })
  return container.querySelector('[data-config-section="remotes"]') as HTMLElement
}

function rows(section: HTMLElement): string[][] {
  return Array.from(section.querySelectorAll('[data-remote]')).map((row) =>
    Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent ?? ''),
  )
}

describe('the Remotes section', () => {
  it('lists each remote by name, protocol and origin', () => {
    const section = show(TWO_REMOTES)
    expect(rows(section)).toEqual([
      ['grid', 'playwright', 'wss://grid.example.com:443'],
      ['lab', 'cdp', 'ws://10.0.0.5:9222'],
    ])
    expect(section.querySelector('[data-remotes-empty]')).toBeNull()
  })

  it('shows only the origin even when a served url carries a path, query or credentials', () => {
    const section = show({
      registry: {
        remotes: [{ name: 'grid', protocol: 'playwright', url: 'wss://user:pw@grid.example.com/session/abc?token=s3cret' }],
      },
    })
    expect(rows(section)).toEqual([['grid', 'playwright', 'wss://grid.example.com:443']])
    expect(section.textContent).not.toContain('s3cret')
    expect(section.textContent).not.toContain('/session')
    expect(section.textContent).not.toContain('user:pw')
  })

  it('names the project default remote when use.browser.remote picks one, the name in medium weight', () => {
    const section = show({ ...TWO_REMOTES, use: { browser: { remote: 'grid' } } })
    const line = section.querySelector('[data-remote-default]')
    expect(line?.textContent).toBe(remoteDefaultLine('grid'))
    expect(remoteDefaultLine('grid')).toBe('Web tests run on grid unless a suite or test picks another place.')
    expect(Array.from(line?.querySelectorAll('.font-medium') ?? []).map((mark) => mark.textContent)).toEqual(['grid'])
  })

  it('warns when the default names no listed remote, as a config that fails to parse can', () => {
    for (const config of [
      { ...TWO_REMOTES, use: { browser: { remote: 'gird' } } },
      { use: { browser: { remote: 'gird' } } },
    ]) {
      const section = show(config)
      const warning = section.querySelector('[data-remote-unlisted]')
      expect(warning?.textContent).toBe(remoteNotListedLine('gird'))
      expect(warning?.className).toContain('text-destructive')
      expect(Array.from(warning?.querySelectorAll('.font-medium') ?? []).map((mark) => mark.textContent)).toEqual([
        'gird',
      ])
      expect(Array.from(warning?.querySelectorAll('code') ?? []).map((code) => code.textContent)).toEqual([
        'registry.remotes',
        'use.browser.remote',
      ])
    }
    expect(remoteNotListedLine('gird')).toBe(
      'gird is not listed under registry.remotes, so web tests that use this default cannot run. List it, or change use.browser.remote.',
    )
  })

  it('gives no warning when the default names a listed remote or this machine', () => {
    for (const config of [
      { ...TWO_REMOTES, use: { browser: { remote: 'grid' } } },
      { ...TWO_REMOTES, use: { browser: { remote: 'local' } } },
      TWO_REMOTES,
    ]) {
      expect(show(config).querySelector('[data-remote-unlisted]')).toBeNull()
    }
  })

  it("marks the default remote's row and no other", () => {
    const section = show({ ...TWO_REMOTES, use: { browser: { remote: 'lab' } } })
    const marked = Array.from(section.querySelectorAll('[data-remote-default-badge]'))
    expect(marked.map((badge) => badge.closest('[data-remote]')?.getAttribute('data-remote'))).toEqual([
      'lab',
    ])
    expect(marked[0]?.textContent).toBe(DEFAULT_BADGE)
    expect(show(TWO_REMOTES).querySelector('[data-remote-default-badge]')).toBeNull()
  })

  it('shows a dash for a remote entry missing its name or protocol', () => {
    const section = show({ registry: { remotes: [{ url: 'wss://grid.example.com' }] } })
    expect(rows(section)).toEqual([
      [REMOTES_COPY.missingValue, REMOTES_COPY.missingValue, 'wss://grid.example.com:443'],
    ])
  })

  it('ends the default sentence the same way whether tests run here or on a remote', () => {
    const ending = 'unless a suite or test picks another place.'
    expect(REMOTES_COPY.runsHere.endsWith(ending)).toBe(true)
    expect(remoteDefaultLine('grid').endsWith(ending)).toBe(true)
  })

  it('says tests run on this machine when the default is local or unset', () => {
    for (const config of [{ ...TWO_REMOTES, use: { browser: { remote: 'local' } } }, TWO_REMOTES, {}]) {
      const section = show(config)
      expect(section.querySelector('[data-remote-default]')?.textContent).toBe(REMOTES_COPY.runsHere)
    }
  })

  it('shows the empty state when no remotes are listed', () => {
    for (const config of [{}, { registry: { remotes: [] } }, { registry: { targets: {} } }]) {
      const section = show(config)
      expect(section.querySelector('[data-remotes-empty]')?.textContent).toBe(REMOTES_COPY.empty)
      expect(rows(section)).toEqual([])
    }
  })

  it('shows how to define a remote when none is listed: an example entry, where credentials go and how one is picked', () => {
    const section = show({ workspace: { secretsFile: '.env.secrets.local' } })
    expect(section.querySelector('[data-remotes-empty]')?.textContent).toBe(
      'No remotes are listed. Add one under registry.remotes in agent-qa.config.yaml:',
    )
    expect(section.querySelector('pre[data-remotes-example] code')?.textContent).toBe(
      [
        'registry:',
        '  remotes:',
        '    - name: grid',
        '      protocol: playwright # or cdp',
        '      url: wss://grid.example.com/playwright',
        '      query: # or headers, with the same {{secret:NAME}} values',
        '        token: "{{secret:GRID_TOKEN}}"',
      ].join('\n'),
    )
    expect(section.querySelector('[data-remotes-credentials]')?.textContent).toBe(
      'Write credentials as {{secret:NAME}} references to names declared in .env.secrets.local.',
    )
    expect(section.querySelector('[data-remotes-pick]')?.textContent).toBe(
      'Pick one with use.browser.remote: <name> in agent-qa.config.yaml, a suite or a test. Use local to run on this machine.',
    )
    expect(section.querySelector('[data-remotes-listed]')).toBeNull()
  })

  it('names the workspace secrets file the config declares, and the workspace key when it declares none', () => {
    const named = show({ workspace: { secretsFile: 'secrets/remote.env' } })
    expect(named.querySelector('[data-remotes-credentials]')?.textContent).toBe(
      remoteCredentialsLine('secrets/remote.env'),
    )
    expect(remoteCredentialsLine('secrets/remote.env')).toContain('secrets/remote.env.')
    for (const config of [{}, { workspace: { secretsFile: '' } }, { workspace: 'none' }]) {
      expect(show(config).querySelector('[data-remotes-credentials]')?.textContent).toBe(
        'Write credentials as {{secret:NAME}} references to names declared in your secrets file (set workspace.secretsFile).',
      )
    }
  })

  it('sets the key paths, the config file and local in code in the empty state', () => {
    const section = show({})
    const codes = (selector: string) =>
      Array.from(section.querySelectorAll(`${selector} code`)).map((code) => code.textContent)
    expect(codes('[data-remotes-empty]')).toEqual(['registry.remotes', 'agent-qa.config.yaml'])
    expect(codes('[data-remotes-credentials]')).toEqual(['{{secret:NAME}}', 'workspace.secretsFile'])
    expect(codes('[data-remotes-pick]')).toEqual(['use.browser.remote: <name>', 'agent-qa.config.yaml', 'local'])
  })

  it('leads into the example in foreground text and keeps the notes muted', () => {
    const section = show({})
    expect(section.querySelector('[data-remotes-empty]')?.className).toContain('text-foreground')
    expect(section.querySelector('[data-remotes-empty]')?.className).not.toContain('text-muted-foreground')
    for (const note of ['[data-remotes-credentials]', '[data-remotes-pick]']) {
      expect(section.querySelector(note)?.className).toContain('text-muted-foreground')
    }
  })

  it('says in the example that a credential can go in headers instead of the query', () => {
    const queryLine = REMOTES_COPY.example.split('\n').find((line) => line.trim().startsWith('query:'))
    expect(queryLine).toBe('      query: # or headers, with the same {{secret:NAME}} values')
  })

  it('the example is an entry the remote rules accept, with its credential as a reference', () => {
    const entry = parse(REMOTES_COPY.example).registry.remotes[0]
    expect(Object.keys(entry)).toEqual(['name', 'protocol', 'url', 'query'])
    expect(NAME_SLUG_PATTERN.test(entry.name)).toBe(true)
    expect(REMOTE_PROTOCOLS).toContain(entry.protocol)
    expect(remoteOrigin(entry.url)?.host).toBe('grid.example.com')
    expect(remoteEntryIssues(entry)).toEqual([])
    expect(connectionSecretNames([entry])).toEqual(['GRID_TOKEN'])
  })

  it('points a listed section to registry.remotes and use.browser.remote, with no example', () => {
    const section = show({ ...TWO_REMOTES, workspace: { secretsFile: '.env.secrets.local' } })
    expect(section.querySelector('[data-remotes-listed]')?.textContent).toBe(
      'Remotes are defined under registry.remotes in agent-qa.config.yaml and picked with use.browser.remote.',
    )
    expect(Array.from(section.querySelectorAll('[data-remotes-listed] code')).map((code) => code.textContent)).toEqual([
      'registry.remotes',
      'agent-qa.config.yaml',
      'use.browser.remote',
    ])
    expect(
      section.querySelector('[data-remotes-empty], [data-remotes-example], [data-remotes-credentials], [data-remotes-pick]'),
    ).toBeNull()
  })

  it('renders no control and no field mark, so nothing here edits a remote', () => {
    for (const config of [{ ...TWO_REMOTES, use: { browser: { remote: 'grid' } } }, {}]) {
      const section = show(config)
      expect(section.querySelector('input, select, button, textarea, [role="combobox"], [contenteditable]')).toBeNull()
      expect(section.querySelector('[data-field-path], [data-field-list], [data-config-field]')).toBeNull()
    }
  })
})
