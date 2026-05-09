import { Command } from 'commander'
import pc from 'picocolors'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { parse } from 'yaml'
import { join, resolve, basename } from 'node:path'
import { createInterface } from 'node:readline'
import { DEFAULT_AGENT_QA_CACHE_DIR, hashStepInstruction } from '@vostride/agent-qa-core'
import { resolveConfig } from '../config.js'

const CACHE_DIR_FALLBACK = DEFAULT_AGENT_QA_CACHE_DIR || '.agent-qa/cache'

export async function purgeTest(testPath: string, cacheDir: string, configContent = ''): Promise<number> {
  const content = await readFile(testPath, 'utf-8')
  const doc = parse(content)
  const platform: string = doc.platform ?? 'web'
  const steps: string[] = (doc.steps ?? []).map((s: unknown) =>
    typeof s === 'string' ? s : (s as Record<string, string>).step,
  )

  const resolvedCacheDir = resolve(cacheDir)
  let purged = 0

  for (let i = 0; i < steps.length; i++) {
    const stepHash = hashStepInstruction(steps[i], platform, configContent, content, i)
    const dirPath = join(resolvedCacheDir, stepHash)
    try {
      await stat(dirPath)
      await rm(dirPath, { recursive: true, force: true })
      purged++
    } catch {
      // directory doesn't exist — skip
    }
  }

  return purged
}

export async function purgeAll(cacheDir: string, force: boolean): Promise<number> {
  const resolvedDir = resolve(cacheDir)
  let entries: string[]
  try {
    entries = await readdir(resolvedDir)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }

  if (entries.length === 0) return 0

  if (!force) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>((res) => {
      rl.question(`About to delete ${entries.length} cached plans. Continue? (y/N) `, res)
    })
    rl.close()
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.')
      return 0
    }
  }

  for (const entry of entries) {
    await rm(join(resolvedDir, entry), { recursive: true, force: true })
  }

  return entries.length
}

export function createCacheCommand(): Command {
  const cmd = new Command('cache').description('Manage action cache')

  cmd
    .command('purge')
    .description('Clear cached action plans')
    .option('--test <path>', 'purge cache for a specific test file')
    .option('--all', 'purge all cached plans')
    .option('--force', 'skip confirmation prompt')
    .action(async (opts) => {
      if (!opts.test && !opts.all) {
        console.error(pc.red('Specify --test <path> or --all'))
        process.exitCode = 1
        return
      }

      const parentOpts = cmd.parent?.opts() ?? {}
      const config = await resolveConfig({
        configPath: parentOpts.config as string | undefined,
      })
      const cacheDir = config.services?.cache?.dir ?? CACHE_DIR_FALLBACK

      // Read raw config file content for cache key scoping
      const configPath = (parentOpts.config as string | undefined) ?? 'agent-qa.config.yaml'
      let configContent = ''
      try {
        configContent = await readFile(configPath, 'utf-8')
      } catch { /* config file may not exist */ }

      if (opts.test) {
        const count = await purgeTest(opts.test, cacheDir, configContent)
        if (count === 0) {
          console.log(pc.dim('No cached plans found'))
        } else {
          console.log(pc.green(`Purged ${count} cached plans for ${basename(opts.test)}`))
        }
      } else if (opts.all) {
        const count = await purgeAll(cacheDir, !!opts.force)
        if (count === 0) {
          console.log(pc.dim('No cached plans found'))
        } else {
          console.log(pc.green(`Purged ${count} cached plans (all)`))
        }
      }
    })

  return cmd
}
