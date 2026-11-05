import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  writeScriptedPlugin,
  type ScriptedPluginInput,
} from '@vostride/agent-qa-plugin-kit/testing'

import { createFixtureRoot, type FixtureRoot } from '../../../plugins/__tests__/plugin-fixtures.js'
import {
  createPluginHostPool,
  type PluginHostPool,
  type PluginHostPoolInput,
} from '../host-pool.js'

export const webAnswer = { protocol: 'playwright', url: 'ws://127.0.0.1:9/lab' } as const

export const webSession = { platform: 'web', engine: 'chromium', context: 'new' } as const

export const SECRETS: Record<string, string> = { LAB_KEY: 'lab-key-value' }

function resolveValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{secret:(\w+)\}\}/g, (_, name: string) => SECRETS[name] ?? '')
  }
  if (Array.isArray(value)) return value.map(resolveValue)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolveValue(child)]),
    )
  }
  return value
}

export function resolveSecrets(value: Record<string, unknown>): Record<string, unknown> {
  return resolveValue(value) as Record<string, unknown>
}

export type LedgerLine = Record<string, unknown> & { method: string }

export interface ScriptedEntry {
  name: string
  path: string
  ledgerFile: string
  options: Record<string, unknown>
}

export interface HostProject {
  fixture: FixtureRoot
  entry(
    name: string,
    options?: Record<string, unknown>,
    scripted?: ScriptedPluginInput,
  ): ScriptedEntry
  missingEntry(name: string): ScriptedEntry
  pool(
    entries: readonly ScriptedEntry[],
    input?: Partial<PluginHostPoolInput>,
  ): PluginHostPool
  ledger(entry: ScriptedEntry): LedgerLine[]
  cleanup(): Promise<void>
}

export function createHostProject(): HostProject {
  const fixture = createFixtureRoot('agent-qa-plugin-host-')
  const pools: PluginHostPool[] = []
  return {
    fixture,
    entry(name, options = {}, scripted = {}) {
      writeScriptedPlugin(join(fixture.configDir, 'plugins', name), scripted)
      const ledgerFile = join(fixture.root, `${name}.ledger.jsonl`)
      return {
        name,
        path: `./plugins/${name}`,
        ledgerFile,
        options: { ledgerFile, answer: webAnswer, ...options },
      }
    },
    missingEntry(name) {
      return {
        name,
        path: `./plugins/${name}`,
        ledgerFile: join(fixture.root, `${name}.ledger.jsonl`),
        options: {},
      }
    },
    pool(entries, input = {}) {
      const pool = createPluginHostPool({
        configDir: fixture.configDir,
        plugins: entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
          options: entry.options,
        })),
        agentQaVersion: '0.2.6',
        hostVersions: { playwright: '1.63.0', webdriverio: '9.20.0' },
        resolveSecrets,
        mask: (text) => text,
        bounds: { killAfterMs: 1_000, cancelGraceMs: 1_000 },
        ...input,
      })
      pools.push(pool)
      return pool
    },
    ledger(entry) {
      if (!existsSync(entry.ledgerFile)) return []
      return readFileSync(entry.ledgerFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as LedgerLine)
    },
    async cleanup() {
      await Promise.all(pools.map((pool) => pool.shutdown({ signal: true })))
      fixture.remove()
    },
  }
}

export function methodsOf(lines: readonly LedgerLine[]): string[] {
  return lines.map((line) => line.method)
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('the condition did not hold in time')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
