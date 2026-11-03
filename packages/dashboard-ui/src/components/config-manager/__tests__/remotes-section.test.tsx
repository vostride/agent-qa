// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RemotesSection } from '@/components/config-manager/remotes-section'
import { REMOTES_COPY, remoteDefaultLine } from '@/lib/config-copy'

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

  it('names the project default remote when use.browser.remote picks one', () => {
    const section = show({ ...TWO_REMOTES, use: { browser: { remote: 'grid' } } })
    expect(section.querySelector('[data-remote-default]')?.textContent).toBe(remoteDefaultLine('grid'))
    expect(remoteDefaultLine('grid')).toBe('Web tests run on grid unless a suite or test picks another place.')
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

  it('renders no control and no field mark, so nothing here edits a remote', () => {
    for (const config of [{ ...TWO_REMOTES, use: { browser: { remote: 'grid' } } }, {}]) {
      const section = show(config)
      expect(section.querySelector('input, select, button, textarea, [role="combobox"], [contenteditable]')).toBeNull()
      expect(section.querySelector('[data-field-path], [data-field-list], [data-config-field]')).toBeNull()
    }
  })
})
