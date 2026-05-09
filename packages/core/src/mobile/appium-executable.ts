import { existsSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'

export type AppiumExecutableSource = 'local' | 'path'

export interface ResolvedAppiumExecutable {
  command: string
  source: AppiumExecutableSource
}

export interface ResolveAppiumExecutableOptions {
  cwd?: string
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
}

export function localAppiumBinaryNames(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['appium.cmd', 'appium.exe', 'appium'] : ['appium']
}

export function resolveAppiumExecutable(opts: ResolveAppiumExecutableOptions = {}): ResolvedAppiumExecutable {
  const exists = opts.exists ?? existsSync
  const names = localAppiumBinaryNames(opts.platform ?? process.platform)
  let current = resolve(opts.cwd ?? process.cwd())
  const root = parse(current).root

  while (true) {
    for (const name of names) {
      const candidate = join(current, 'node_modules', '.bin', name)
      if (exists(candidate)) {
        return { command: candidate, source: 'local' }
      }
    }

    if (current === root) break
    current = dirname(current)
  }

  return { command: 'appium', source: 'path' }
}

export function formatAppiumInstallGuidance(): string {
  return 'Install Appium locally with `npm install -D appium` (or `pnpm add -D appium` / `yarn add -D appium`). If you prefer a machine-wide setup, use `npm install -g appium`.'
}
