import { Command } from 'commander'
import pc from 'picocolors'
import { createInterface } from 'node:readline'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  discoverWorkspaceFiles,
  parseObservation,
  listObservations,
  parseTestFile,
  parseSuiteFile,
  resolveMemoryRoot,
  resolveWorkspacePaths,
} from '@vostride/agent-qa-core'
import { resolveConfig } from '../config.js'

interface OrphanInfo {
  path: string
  tier: string
  scope: string
  fileCount: number
  lastConfirmed: string | null
  size: number
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1048576) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

async function getOrphanInfo(memoryRoot: string, tier: string, scope: string): Promise<OrphanInfo> {
  const scopePath = join(memoryRoot, tier, scope)
  const obsFiles = await listObservations(scopePath)

  let newest: string | null = null
  for (const filename of obsFiles) {
    try {
      const content = await readFile(join(scopePath, filename), 'utf-8')
      const { data } = parseObservation(content, filename)
      if (data?.last_confirmed) {
        if (!newest || data.last_confirmed > newest) {
          newest = data.last_confirmed
        }
      }
    } catch { /* skip unreadable files */ }
  }

  let totalSize = 0
  try {
    const entries = await readdir(scopePath)
    for (const entry of entries) {
      try {
        const s = await stat(join(scopePath, entry))
        if (s.isFile()) totalSize += s.size
      } catch { /* skip inaccessible entries */ }
    }
  } catch { /* empty dir */ }

  return {
    path: join(tier, scope),
    tier,
    scope,
    fileCount: obsFiles.length,
    lastConfirmed: newest,
    size: totalSize,
  }
}

export function createCleanMemoryCommand(): Command {
  const cmd = new Command('clean-memory')
    .description('Remove orphaned memory observation directories')
    .option('-y, --yes', 'skip confirmation prompt')
    .action(async (_opts, command) => {
      const opts = command.opts()
      const configPath = command.parent?.opts()?.config ?? 'agent-qa.config.yaml'
      const config = await resolveConfig({ configPath })
      const workspace = resolveWorkspacePaths({ config, configPath })

      const expectedProducts = new Set<string>()
      const targets = config.registry?.targets ?? {}
      for (const [name, entry] of Object.entries(targets)) {
        expectedProducts.add((entry as any)?.product ?? name)
      }

      const expectedTests = new Set<string>()
      for (const file of await discoverWorkspaceFiles({ workspace, kind: 'test' })) {
        try {
          const content = await readFile(file.absolutePath, 'utf-8')
          const result = parseTestFile(content, file.workspaceRelativePath)
          for (const t of result.tests) {
            if (t['test-id']) expectedTests.add(t['test-id'])
            expectedTests.add(t.name)
          }
        } catch { /* skip unparseable files */ }
      }

      const expectedSuites = new Set<string>()
      for (const file of await discoverWorkspaceFiles({ workspace, kind: 'suite' })) {
        try {
          const suite = await parseSuiteFile(file.absolutePath)
          if (suite['suite-id']) expectedSuites.add(suite['suite-id'])
          expectedSuites.add(suite.name)
        } catch { /* skip unparseable files */ }
      }

      const memoryRoot = resolveMemoryRoot(config, workspace.configDir)
      if (!existsSync(memoryRoot)) {
        console.log(pc.dim('No memory directory found.'))
        return
      }

      const TIERS = [
        { dir: 'products', expected: expectedProducts },
        { dir: 'suites', expected: expectedSuites },
        { dir: 'tests', expected: expectedTests },
      ]

      const orphans: OrphanInfo[] = []
      for (const tier of TIERS) {
        const tierPath = join(memoryRoot, tier.dir)
        let entries: string[]
        try {
          entries = await readdir(tierPath)
        } catch { continue }

        for (const entry of entries) {
          try {
            const s = await stat(join(tierPath, entry))
            if (!s.isDirectory()) continue
          } catch { continue }

          if (!tier.expected.has(entry)) {
            orphans.push(await getOrphanInfo(memoryRoot, tier.dir, entry))
          }
        }
      }

      if (orphans.length === 0) {
        console.log(pc.dim('No orphaned memory directories found.'))
        return
      }

      const maxPathLen = Math.max('Path'.length, ...orphans.map(o => o.path.length))
      console.log('')
      console.log(pc.bold('Orphaned memory directories:'))
      console.log('')
      console.log('  ' + pc.dim('Path'.padEnd(maxPathLen + 2) + 'Files'.padStart(7) + '  ' + 'Last Confirmed'.padEnd(20) + 'Size'.padStart(10)))
      console.log('  ' + pc.dim('-'.repeat(maxPathLen + 2 + 7 + 2 + 20 + 10)))
      for (const o of orphans) {
        const confirmed = o.lastConfirmed ?? pc.dim('never')
        console.log('  ' + o.path.padEnd(maxPathLen + 2) + String(o.fileCount).padStart(7) + '  ' + String(confirmed).padEnd(20) + formatSize(o.size).padStart(10))
      }
      console.log('')

      if (!opts.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        const answer = await new Promise<string>((res) => {
          rl.question(`Delete ${orphans.length} orphaned director${orphans.length === 1 ? 'y' : 'ies'}? (y/N) `, res)
        })
        rl.close()
        if (answer.toLowerCase() !== 'y') {
          console.log('Aborted.')
          return
        }
      }

      for (const orphan of orphans) {
        await rm(join(memoryRoot, orphan.tier, orphan.scope), { recursive: true, force: true })
      }
      console.log(pc.green(`Deleted ${orphans.length} orphaned director${orphans.length === 1 ? 'y' : 'ies'}.`))
    })

  return cmd
}
