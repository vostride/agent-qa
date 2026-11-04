import { Command } from 'commander'
import pc from 'picocolors'
import { remoteLabel } from '@vostride/agent-qa-schema'
import { printRunText } from '@vostride/agent-qa-core/run-text-output'
import { resolveConfig } from '../config.js'

const DEVICES_INIT_REMOVED =
  'agent-qa devices init was removed: devices are found by model and os, so nothing needs binding. Run agent-qa devices to see what this machine has.'

interface RemoteEntry {
  name: string
  protocol: string
  url: string
}

async function listDevices(): Promise<void> {
  let config
  try {
    config = await resolveConfig({})
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    printRunText(pc.red(`Config error: ${message}`), (text) => console.error(text))
    process.exitCode = 1
    return
  }

  const devices = (config as any).registry?.devices
  if (!devices || Object.keys(devices).length === 0) {
    console.log(pc.yellow('No devices configured in registry.devices'))
    return
  }
  const remotes: RemoteEntry[] = (config as any).registry?.remotes ?? []

  const nameWidth = Math.max(12, ...Object.keys(devices).map((n) => n.length))
  const platWidth = 10

  console.log('')
  console.log(pc.bold('  Configured Devices'))
  console.log('')
  console.log(
    `  ${pc.dim('Name'.padEnd(nameWidth))}  ${pc.dim('Platform'.padEnd(platWidth))}  ${pc.dim('Remote')}`,
  )
  console.log(
    `  ${pc.dim('─'.repeat(nameWidth))}  ${pc.dim('─'.repeat(platWidth))}  ${pc.dim('─'.repeat(30))}`,
  )

  const rows: string[] = []
  for (const [name, profile] of Object.entries(devices) as [string, any][]) {
    const remoteName: string | undefined = profile.remote
    const remote = remoteName === undefined ? undefined : remotes.find((r) => r.name === remoteName)
    const where = remote ? remoteLabel(remote) : (remoteName ?? '')
    rows.push(
      `  ${name.padEnd(nameWidth)}  ${profile.platform.padEnd(platWidth)}  ${where}`.trimEnd(),
    )
  }
  printRunText(rows.join('\n'), (text) => console.log(text))
  console.log('')
}

export function createDevicesCommand(): Command {
  const cmd = new Command('devices').description('Show the configured device profiles')

  cmd
    .command('list', { isDefault: true })
    .description('Show each configured device and the remote it runs on')
    .action(listDevices)

  cmd.command('init', { hidden: true }).action(() => {
    console.error(DEVICES_INIT_REMOVED)
    process.exitCode = 1
  })

  return cmd
}
