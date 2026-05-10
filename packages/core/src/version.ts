import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function readPackageVersion(): string {
  try {
    const manifest = require('../package.json') as { version?: unknown }
    if (typeof manifest.version === 'string' && manifest.version.trim()) {
      return manifest.version.trim()
    }
  } catch {
    // Keep public version consumers non-throwing if package metadata is unavailable.
  }

  return '0.0.0'
}

export const AGENT_QA_VERSION = readPackageVersion()

export function getAgentQaVersion(): string {
  return AGENT_QA_VERSION
}
