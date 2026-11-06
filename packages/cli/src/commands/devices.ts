import { Command } from 'commander'
import pc from 'picocolors'
import {
  guardJsonText,
  printRunText,
  reserveStdoutForData,
} from '@vostride/agent-qa-core/run-text-output'
import { resolveConfig } from '../config.js'
import { describeDevices, describeDevicesHere, type DevicesHereLister } from './run.js'

const DEVICES_INIT_REMOVED =
  'agent-qa devices init was removed: devices are found by model and os, so nothing needs binding. Run agent-qa devices to see what this machine has.'

export interface DevicesCommandOptions {
  readonly listDevicesHere?: DevicesHereLister
}

async function listDevices(options: DevicesCommandOptions, json: boolean): Promise<void> {
  let config
  try {
    config = await resolveConfig({})
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    printRunText(pc.red(`Config error: ${message}`), (text) => console.error(text))
    process.exitCode = 1
    return
  }

  const listing =
    options.listDevicesHere === undefined ? {} : { listDevicesHere: options.listDevicesHere }
  if (json) {
    const releaseStdout = reserveStdoutForData()
    try {
      console.log(guardJsonText(JSON.stringify(await describeDevices(config, listing), null, 2)))
    } finally {
      releaseStdout()
    }
    return
  }

  const devices = config.registry?.devices
  if (!devices || Object.keys(devices).length === 0) {
    console.log(pc.yellow('No devices configured in registry.devices'))
  }

  const lines = await describeDevicesHere(config, listing)
  printRunText(lines.map((line) => `  ${line}`).join('\n'), (text) => console.log(text))
}

export function createDevicesCommand(options: DevicesCommandOptions = {}): Command {
  const cmd = new Command('devices').description(
    'Show where each device runs and what this machine has',
  )

  cmd
    .command('list', { isDefault: true })
    .description('Show what each configured device finds here or the remote it runs on')
    .option('--json', 'emit each device and what this machine has as JSON')
    .action((flags: { json?: boolean }) => listDevices(options, flags.json === true))

  cmd.command('init', { hidden: true }).action(() => {
    console.error(DEVICES_INIT_REMOVED)
    process.exitCode = 1
  })

  return cmd
}
