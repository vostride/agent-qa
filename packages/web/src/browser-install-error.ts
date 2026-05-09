type BrowserName = 'chromium' | 'firefox' | 'webkit'

function displayBrowserName(browserName: BrowserName): string {
  if (browserName === 'chromium') return 'Chromium'
  if (browserName === 'firefox') return 'Firefox'
  return 'WebKit'
}

export function isPlaywrightMissingBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  return lower.includes("executable doesn't exist")
    && lower.includes('playwright')
    && lower.includes('install')
}

export function formatMissingBrowserError(browserName: BrowserName): string {
  return [
    `agent-qa browser support is not installed for ${displayBrowserName(browserName)}.`,
    '',
    'Install the browser managed by agent-qa, then rerun the test:',
    `  agent-qa install-browsers --${browserName}`,
    '',
    'This can happen after upgrading agent-qa or Playwright because browser binaries live outside the package install.',
  ].join('\n')
}
