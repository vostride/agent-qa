import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export interface PlaywrightCoreModule {
  chromium: { executablePath(): string }
}

export type ChromiumAnswer = { found: true; path: string } | { found: false; reason: string }

export type ChromiumResolver = (options: { projectAgentQaDir?: string }) => ChromiumAnswer

// From a project's installed agent-qa when given its folder, else from the running agent-qa.
function webPackageRequire(fromDir?: string): NodeJS.Require {
  const require = createRequire(
    fromDir === undefined ? import.meta.url : join(fromDir, 'package.json'),
  )
  return createRequire(require.resolve('@vostride/agent-qa-web'))
}

export function resolveWebPlaywrightCoreDir(fromDir?: string): string {
  return dirname(webPackageRequire(fromDir).resolve('playwright-core/package.json'))
}

export function resolveWebPlaywrightCore(fromDir?: string): PlaywrightCoreModule {
  return webPackageRequire(fromDir)('playwright-core') as PlaywrightCoreModule
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function findChromium(input: {
  playwrightCore: PlaywrightCoreModule
  exists: (path: string) => boolean
}): ChromiumAnswer {
  let path: string
  try {
    path = input.playwrightCore.chromium.executablePath()
  } catch (error) {
    return { found: false, reason: messageOf(error) }
  }
  return input.exists(path) ? { found: true, path } : { found: false, reason: `no file at ${path}` }
}

export const findChromiumByDefault: ChromiumResolver = (options) => {
  let playwrightCore: PlaywrightCoreModule
  try {
    playwrightCore = resolveWebPlaywrightCore(options.projectAgentQaDir)
  } catch (error) {
    return { found: false, reason: messageOf(error) }
  }
  return findChromium({ playwrightCore, exists: existsSync })
}
