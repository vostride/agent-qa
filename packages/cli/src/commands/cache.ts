import { Command } from 'commander'
import pc from 'picocolors'
import { dirname, resolve } from 'node:path'
import { purgeActionCache } from '@vostride/agent-qa-agent-local'
import { DEFAULT_AGENT_QA_CACHE_DIR } from '@vostride/agent-qa-core'
import { resolveConfig } from '../config.js'

const CACHE_DIR_FALLBACK = DEFAULT_AGENT_QA_CACHE_DIR || '.agent-qa/cache'

// Running `cache purge --all` is the intent: there is no confirmation step.
export async function purgeAll(cacheDir: string): Promise<number> {
  return purgeActionCache(resolve(cacheDir))
}

export function createCacheCommand(): Command {
  const cmd = new Command('cache').description('Manage action cache')

  cmd
    .command('purge')
    .description('Clear cached action plans')
    .option('--all', 'purge all cached plans')
    .action(async (opts) => {
      if (!opts.all) {
        console.error(pc.red('Specify --all'))
        process.exitCode = 1
        return
      }

      const parentOpts = cmd.parent?.opts() ?? {}
      const configPath = (parentOpts.config as string | undefined) ?? 'agent-qa.config.yaml'
      const config = await resolveConfig({ configPath })
      const configDir = dirname(resolve(configPath))

      const count = await purgeAll(
        resolve(configDir, config.services?.cache?.dir ?? CACHE_DIR_FALLBACK),
      )
      if (count === 0) {
        console.log(pc.dim('No cached plans found'))
      } else {
        console.log(pc.green(`Purged ${count} cached plans (all)`))
      }
    })

  return cmd
}
