// The Playwright versions BrowserStack's browsers-and-OS page lists; it moves with each release.
export const BROWSERSTACK_PLAYWRIGHT_VERSIONS = ['1.59', '1.60', '1.61', '1.62', '1.63'] as const

export function playwrightMajorMinor(version: string): string | undefined {
  const match = /^(\d+)\.(\d+)(?:\.|$|-)/.exec(version)
  return match === null ? undefined : `${match[1]}.${match[2]}`
}

export function listedPlaywright(version: string): boolean {
  const majorMinor = playwrightMajorMinor(version)
  return BROWSERSTACK_PLAYWRIGHT_VERSIONS.some((listed) => listed === majorMinor)
}
