import { Command } from 'commander'
import pc from 'picocolors'
import { printRunText } from '@vostride/agent-qa-core/run-text-output'
import { resolveConfig } from '../config.js'
import { describeDevicesHere, type DevicesHereLister } from './run.js'

const DEVICES_INIT_REMOVED =
  'agent-qa devices init was removed: devices are found by model and os, so nothing needs binding. Run agent-qa devices to see what this machine has.'

export interface DevicesCommandOptions {
  readonly listDevicesHere?: DevicesHereLister
}

async function listDevices(options: DevicesCommandOptions): Promise<void> {
  let config
  try {
    config = await resolveConfig({})
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    printRunText(pc.red(`Config error: ${message}`), (text) => console.error(text))
    process.exitCode = 1
    return
  }

  const devices = config.registry?.devices
  if (!devices || Object.keys(devices).length === 0) {
    console.log(pc.yellow('No devices configured in registry.devices'))
    return
  }

  const lines = await describeDevicesHere(config, {
    ...(options.listDevicesHere === undefined ? {} : { listDevicesHere: options.listDevicesHere }),
  })
  printRunText(lines.map((line) => `  ${line}`).join('\n'), (text) => console.log(text))
}

export function createDevicesCommand(options: DevicesCommandOptions = {}): Command {
  const cmd = new Command('devices').description(
    'Show where each device runs and what this machine has',
  )

  cmd
    .command('list', { isDefault: true })
    .description('Show what each configured device finds here or the remote it runs on')
    .action(() => listDevices(options))

  cmd.command('init', { hidden: true }).action(() => {
    console.error(DEVICES_INIT_REMOVED)
    process.exitCode = 1
  })

  return cmd
}
