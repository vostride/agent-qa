import { Command } from 'commander'
import pc from 'picocolors'
import { flushAnalytics } from '@vostride/agent-qa-core'
import { resolveConfig } from '../config.js'

export function createMcpCommand(): Command {
  const cmd = new Command('mcp')
    .description('Start MCP (Model Context Protocol) server over stdio')
    .action(async (command: Command) => {
      try {
        const program = command.parent
        const globalOpts = program?.opts<{ config?: string }>() ?? {}
        let config: Awaited<ReturnType<typeof resolveConfig>> | undefined
        try {
          config = await resolveConfig({ configPath: globalOpts.config })
        } catch {
          config = undefined
        }

        const { startMcpServer } = await import('@vostride/agent-qa-mcp')
        try {
          await startMcpServer({ analyticsConfig: config })
        } finally {
          await flushAnalytics(config ? { config } : undefined).catch(() => {})
        }
      } catch (err) {
        console.error(pc.red('Failed to start MCP server:'), err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  return cmd
}
