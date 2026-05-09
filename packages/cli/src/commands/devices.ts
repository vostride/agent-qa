import { Command } from 'commander'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'
import pc from 'picocolors'
import { resolveConfig } from '../config.js'
import { loadLocalBindings } from '../devices.js'

function formatStatus(
  transport: string,
  localBinding: Record<string, unknown> | null,
): string {
  if (transport !== 'local') {
    return pc.green('Ready') + pc.dim(' (no local binding required)')
  }
  if (!localBinding) {
    return pc.red('UNBOUND') + pc.yellow(' - run `agent-qa devices init`')
  }
  const keys = Object.entries(localBinding).slice(0, 2)
  const details = keys.map(([k, v]) => `${k}: ${v}`).join(', ')
  return pc.green('Bound') + pc.dim(` (${details})`)
}

async function listDevices(): Promise<void> {
  let config
  try {
    config = await resolveConfig({})
  } catch (err) {
    console.error(pc.red(`Config error: ${err instanceof Error ? err.message : String(err)}`))
    process.exitCode = 1
    return
  }

  const devices = (config as any).registry?.devices
  if (!devices || Object.keys(devices).length === 0) {
    console.log(pc.yellow('No devices configured in registry.devices'))
    return
  }

  const localBindings = loadLocalBindings()

  const nameWidth = Math.max(12, ...Object.keys(devices).map(n => n.length))
  const platWidth = 10
  const transWidth = 14

  console.log('')
  console.log(pc.bold('  Configured Devices'))
  console.log('')
  console.log(
    `  ${pc.dim('Name'.padEnd(nameWidth))}  ${pc.dim('Platform'.padEnd(platWidth))}  ${pc.dim('Transport'.padEnd(transWidth))}  ${pc.dim('Status')}`,
  )
  console.log(
    `  ${pc.dim('─'.repeat(nameWidth))}  ${pc.dim('─'.repeat(platWidth))}  ${pc.dim('─'.repeat(transWidth))}  ${pc.dim('─'.repeat(30))}`,
  )

  for (const [name, profile] of Object.entries(devices) as [string, any][]) {
    const localBinding = localBindings?.devices?.[name] as Record<string, unknown> | undefined ?? null
    const status = formatStatus(profile.transport, localBinding)
    console.log(
      `  ${name.padEnd(nameWidth)}  ${profile.platform.padEnd(platWidth)}  ${profile.transport.padEnd(transWidth)}  ${status}`,
    )
  }
  console.log('')
}

interface AdbDevice {
  serial: string
  model: string
}

interface SimctlDevice {
  name: string
  udid: string
  state: string
}

function scanAdbDevices(): AdbDevice[] {
  try {
    const output = execSync('adb devices -l', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    const lines = output.split('\n').slice(1)
    const results: AdbDevice[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('*')) continue
      const parts = trimmed.split(/\s+/)
      if (parts.length < 2 || parts[1] !== 'device') continue
      const serial = parts[0]
      const modelMatch = trimmed.match(/model:(\S+)/)
      results.push({ serial, model: modelMatch?.[1] ?? serial })
    }
    return results
  } catch {
    return []
  }
}

function scanSimctlDevices(): SimctlDevice[] {
  try {
    const output = execSync('xcrun simctl list devices --json', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const data = JSON.parse(output)
    const results: SimctlDevice[] = []
    for (const runtime of Object.values(data.devices) as any[][]) {
      for (const device of runtime) {
        if (device.isAvailable !== false) {
          results.push({ name: device.name, udid: device.udid, state: device.state })
        }
      }
    }
    return results
  } catch {
    return []
  }
}

function appendGitignoreEntry(dir: string, entry: string): void {
  const gitignorePath = join(dir, '.gitignore')
  let existing = ''
  if (existsSync(gitignorePath)) {
    existing = readFileSync(gitignorePath, 'utf-8')
  }
  if (existing.includes(entry)) return
  const append = (existing.length > 0 && !existing.endsWith('\n') ? '\n' : '') + entry + '\n'
  writeFileSync(gitignorePath, existing + append)
}

async function initDevices(): Promise<void> {
  const dir = process.cwd()
  const localFilePath = join(dir, 'agent-qa.local.yaml')

  if (existsSync(localFilePath)) {
    console.log(pc.yellow('agent-qa.local.yaml already exists. Skipping generation.'))
    return
  }

  console.log(pc.bold('\n  Scanning for connected devices...\n'))

  const adbDevices = scanAdbDevices()
  const simctlDevices = scanSimctlDevices()

  if (adbDevices.length > 0) {
    console.log(`  ${pc.green('Android:')} found ${adbDevices.length} device(s)`)
    for (const d of adbDevices) {
      console.log(`    ${pc.dim('•')} ${d.model} (${d.serial})`)
    }
  } else {
    console.log(`  ${pc.dim('Android:')} no devices found (adb not available or no devices connected)`)
  }

  if (simctlDevices.length > 0) {
    const booted = simctlDevices.filter(d => d.state === 'Booted')
    console.log(`  ${pc.green('iOS:')} found ${simctlDevices.length} simulator(s) (${booted.length} booted)`)
    for (const d of booted) {
      console.log(`    ${pc.dim('•')} ${d.name} (${d.udid})`)
    }
  } else {
    console.log(`  ${pc.dim('iOS:')} no simulators found (simctl not available or none installed)`)
  }

  let config
  try {
    config = await resolveConfig({})
  } catch {
    config = null
  }

  const registryDevices = (config as any)?.registry?.devices ?? {}
  const localDevices: Record<string, Record<string, string>> = {}
  let bindCount = 0

  for (const [name, profile] of Object.entries(registryDevices) as [string, any][]) {
    if (profile.transport !== 'local') continue

    if (profile.platform === 'android' && adbDevices.length > 0) {
      const device = adbDevices[0]
      localDevices[name] = { avd: device.model }
      bindCount++
    } else if (profile.platform === 'ios' && simctlDevices.length > 0) {
      const booted = simctlDevices.find(d => d.state === 'Booted')
      const device = booted ?? simctlDevices[0]
      localDevices[name] = { udid: device.udid }
      bindCount++
    } else {
      localDevices[name] = {}
    }
  }

  const localFileContent = {
    devices: Object.keys(localDevices).length > 0 ? localDevices : {},
    providers: {},
  }

  const yamlContent =
    '# Generated by agent-qa devices init\n' +
    '# Edit device bindings for your local machine\n' +
    stringify(localFileContent)

  writeFileSync(localFilePath, yamlContent)

  appendGitignoreEntry(dir, 'agent-qa.local.yaml')

  console.log('')
  console.log(pc.green(`  Generated agent-qa.local.yaml with ${bindCount} device binding(s)`))
  console.log(pc.dim('  Added agent-qa.local.yaml to .gitignore'))
  console.log('')
}

export function createDevicesCommand(): Command {
  const cmd = new Command('devices')
    .description('Manage device profiles and local bindings')

  cmd
    .command('list')
    .description('Show configured devices with merged shared + local view')
    .action(listDevices)

  cmd
    .command('init')
    .description('Scan connected devices and generate agent-qa.local.yaml')
    .action(initDevices)

  return cmd
}
