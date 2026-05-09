// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ConfigLineNotice,
  ConfigSectionBody,
  ConfigSectionFooter,
  ConfigSectionHeader,
  ConfigSectionShell,
} from '@/components/config-manager/config-section-shell'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderShell() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  act(() => {
    root!.render(
      <>
        <ConfigSectionShell aria-label="Config section">
          <ConfigSectionHeader>
            <h3>Section title</h3>
          </ConfigSectionHeader>
          <ConfigSectionBody>
            <div>Section body</div>
          </ConfigSectionBody>
          <ConfigSectionFooter>
            <button type="button">Save Changes</button>
          </ConfigSectionFooter>
        </ConfigSectionShell>
        <ConfigLineNotice>Setting not found</ConfigLineNotice>
      </>,
    )
  })

  return container
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) {
    container.remove()
  }
  container = null
})

describe('Config section shell helpers', () => {
  it('render the Phase 205 no-card section chrome contract', () => {
    const view = renderShell()
    const shell = view.querySelector('[data-config-section-shell]')
    expect(shell).not.toBeNull()
    expect(shell?.tagName).toBe('SECTION')
    expect(shell?.className).toContain('border border-border')
    expect(shell?.className).toContain('bg-transparent')
    expect(shell?.className).toContain('rounded-none')
    expect(shell?.className).toContain('shadow-none')

    const header = shell?.querySelector('header')
    expect(header?.className).toContain('border-b border-border px-5 py-4')

    const body = shell?.querySelector('[data-config-section-body]')
    expect(body?.className).toContain('space-y-6 px-5 py-5')

    const footer = shell?.querySelector('footer')
    expect(footer?.className).toContain('border-t border-border px-5 py-4')

    const notice = view.querySelector('[data-config-line-notice]')
    expect(notice?.className).toContain('border border-border')
    expect(notice?.className).toContain('bg-transparent')
    expect(notice?.className).toContain('rounded-none')
    expect(notice?.className).toContain('px-4 py-3 text-sm text-muted-foreground')

    expect(view.querySelector('[data-slot="card"]')).toBeNull()
  })
})
