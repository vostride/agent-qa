// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import { useTargetDetails } from '@/hooks/use-target-details'
import { fetchConfig } from '@/lib/api'

vi.mock('@/lib/api', () => ({ fetchConfig: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('lists each validly named browser remote of the served config once with its protocol, never local or an appium remote, beside the global default', async () => {
  vi.mocked(fetchConfig).mockResolvedValue({
    config: {
      registry: {
        remotes: [
          { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' },
          { protocol: 'cdp', url: 'ws://10.0.0.5:9222' },
          { name: 'lab', protocol: 'cdp', url: 'ws://10.0.0.6:9222' },
          { name: 'bare', url: 'ws://10.0.0.7:9222' },
          { name: 'invalid name', protocol: 'invalid protocol', url: 'invalid url' },
          { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' },
          { name: 'local', protocol: 'cdp', url: 'ws://127.0.0.1:9222' },
          { name: 'farm', protocol: 'appium', url: 'https://farm.example.com:443' },
        ],
      },
      use: { browser: { name: 'chromium', headless: true, remote: 'grid' } },
    },
    provider: null,
    revision: 'rev-1',
    file: { path: '/work/agent-qa.config.yaml', lines: [] },
  } as never)
  let details: ReturnType<typeof useTargetDetails> | undefined
  function Probe() {
    details = useTargetDetails()
    return null
  }
  const root = createRoot(document.createElement('div'))

  await act(async () => {
    root.render(<Probe />)
  })

  expect(details?.remotes).toEqual([
    { name: 'grid', protocol: 'playwright' },
    { name: 'lab', protocol: 'cdp' },
    { name: 'bare' },
  ])
  expect(details?.globalUse?.browser?.remote).toBe('grid')
  act(() => root.unmount())
})
