export interface PlaywrightCoreModule {
  chromium: { executablePath(): string }
}

export type ChromiumAnswer = { found: true; path: string } | { found: false; reason: string }

export type ChromiumResolver = (options: { projectAgentQaDir?: string }) => ChromiumAnswer

export function resolveWebPlaywrightCoreDir(_fromDir?: string): string {
  throw new Error('not implemented')
}

export function resolveWebPlaywrightCore(_fromDir?: string): PlaywrightCoreModule {
  throw new Error('not implemented')
}

export function findChromium(_input: {
  playwrightCore: PlaywrightCoreModule
  exists: (path: string) => boolean
}): ChromiumAnswer {
  return { found: false, reason: 'not implemented' }
}

export const findChromiumByDefault: ChromiumResolver = () => ({
  found: false,
  reason: 'not implemented',
})
