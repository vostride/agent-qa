// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import i18n, { applyLanguage, startLanguage } from '@/i18n'
import de from '@/i18n/locales/de'
import en from '@/i18n/locales/en'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}))

vi.mock('@/components/product-tour', () => ({
  useProductTour: () => ({ restartTour: vi.fn() }),
}))

vi.mock('@/lib/api', () => ({
  fetchAppMetadata: vi.fn().mockResolvedValue({ version: '0.0.0' }),
}))

vi.mock('@/components/ui/sidebar', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    Sidebar: Pass,
    SidebarHeader: Pass,
    SidebarContent: Pass,
    SidebarFooter: Pass,
    SidebarSeparator: () => <hr />,
    SidebarGroup: Pass,
    SidebarGroupLabel: Pass,
    SidebarMenu: Pass,
    SidebarMenuItem: Pass,
    SidebarMenuButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SidebarRail: () => null,
    useSidebar: () => ({ state: 'expanded', toggleSidebar: vi.fn() }),
  }
})

import { AppSidebar } from '@/components/app-sidebar'

describe('the first visit follows the browser language', () => {
  let container: HTMLDivElement
  let root: Root
  let languages: MockInstance<() => readonly string[]>

  beforeEach(() => {
    localStorage.clear()
    languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-CH', 'en'])
  })

  afterEach(async () => {
    act(() => root.unmount())
    container.remove()
    languages.mockRestore()
    await act(async () => {
      await i18n.changeLanguage('en')
    })
  })

  async function renderSidebar() {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/runs']}>
          <AppSidebar />
        </MemoryRouter>,
      )
    })
  }

  it('shows the navigation in German for a Swiss German browser and switches back in place', async () => {
    await startLanguage()
    await renderSidebar()

    const configLink = container.querySelector('a[href="/config"]')
    expect(de['nav.config']).not.toBe(en['nav.config'])
    expect(configLink?.textContent).toBe(de['nav.config'])
    expect(document.documentElement.lang).toBe('de')

    await act(async () => {
      await applyLanguage('en')
    })

    expect(container.querySelector('a[href="/config"]')).toBe(configLink)
    expect(configLink?.textContent).toBe(en['nav.config'])
    expect(document.documentElement.lang).toBe('en')
  })
})
