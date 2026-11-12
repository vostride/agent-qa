import { createRequire } from 'node:module'
import { dirname } from 'node:path'

export interface BundledAppium {
  readonly serverEntry: string
  readonly driverFolders: readonly string[]
}

const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)

// Resolved from this package's own file: under pnpm only the package that declares a dependency
// can resolve it, and a project's or the machine's own Appium is never reached.
export function resolveBundledAppium(): BundledAppium {
  return {
    serverEntry: require.resolve('appium/build/lib/main.js'),
    driverFolders: [
      dirname(require.resolve('appium-uiautomator2-driver/package.json')),
      dirname(require.resolve('appium-xcuitest-driver/package.json')),
    ],
  }
}
