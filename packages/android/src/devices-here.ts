import { execFile } from 'node:child_process'
import { readdir as fsReaddir, readFile as fsReadFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AndroidHere, AttachedAndroid, AvdHere } from '@vostride/agent-qa-core'

export type ListingExec = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string }>

export interface ListAndroidDevicesHereOptions {
  exec?: ListingExec
  env?: Record<string, string | undefined>
  home?: string
  readFile?: (path: string) => Promise<string>
  readdir?: (path: string) => Promise<string[]>
}

const LISTING_TIMEOUT_MS = 10_000

const execFileAsync = promisify(execFile)

const defaultExec: ListingExec = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  })
  return { stdout }
}

type ExecOutcome =
  | { stdout: string }
  | { failure: 'missing' | 'timeout' | 'failed'; detail: string }

async function run(exec: ListingExec, file: string, args: string[]): Promise<ExecOutcome> {
  try {
    return await exec(file, args, { timeout: LISTING_TIMEOUT_MS })
  } catch (error) {
    const err = error as { code?: unknown; killed?: unknown; stderr?: unknown; message?: unknown }
    if (err.code === 'ENOENT') return { failure: 'missing', detail: '' }
    if (err.killed === true || err.code === 'ETIMEDOUT') return { failure: 'timeout', detail: '' }
    const text = [err.stderr, err.message].find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    )
    const line = text?.trim().split(/\r?\n/)[0] ?? 'unknown error'
    return { failure: 'failed', detail: line.slice(0, 200) }
  }
}

function setting(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

function sdkRoots(env: Record<string, string | undefined>, home: string): string[] {
  const roots = [setting(env, 'ANDROID_HOME'), setting(env, 'ANDROID_SDK_ROOT')].filter(
    (root): root is string => root !== undefined,
  )
  const defaults = [join(home, 'Library', 'Android', 'sdk'), join(home, 'Android', 'Sdk')]
  return [...new Set([...roots, ...defaults])]
}

function parseProperties(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const equals = trimmed.indexOf('=')
    if (equals <= 0) continue
    values.set(trimmed.slice(0, equals).trim(), trimmed.slice(equals + 1).trim())
  }
  return values
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

interface AdbLine {
  serial: string
  state: string
  model?: string
}

function parseAdbDevices(stdout: string): AdbLine[] {
  const devices: AdbLine[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('*') || trimmed.startsWith('List of devices')) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 2) continue
    const [serial, first, second] = parts as [string, string, string | undefined]
    const state = first === 'no' && second === 'permissions' ? 'no permissions' : first
    const model = trimmed.match(/\bmodel:(\S+)/)?.[1]
    devices.push({ serial, state, ...(model === undefined ? {} : { model }) })
  }
  return devices
}

const timedOut = (what: string) => `${what} did not answer within ${LISTING_TIMEOUT_MS / 1000} s`

async function findAdb(
  exec: ListingExec,
  env: Record<string, string | undefined>,
): Promise<{ adb: string; outcome: ExecOutcome } | undefined> {
  const candidates = [setting(env, 'ANDROID_HOME'), setting(env, 'ANDROID_SDK_ROOT')]
    .filter((root): root is string => root !== undefined)
    .map((root) => join(root, 'platform-tools', 'adb'))
  for (const adb of [...new Set(candidates), 'adb']) {
    const outcome = await run(exec, adb, ['devices', '-l'])
    if ('failure' in outcome && outcome.failure === 'missing') continue
    return { adb, outcome }
  }
  return undefined
}

async function describeAttached(
  exec: ListingExec,
  adb: string,
  line: AdbLine,
  problems: string[],
): Promise<AttachedAndroid> {
  if (line.state !== 'device') return { serial: line.serial, state: line.state }
  const shell = async (args: string[]): Promise<string | undefined> => {
    const outcome = await run(exec, adb, ['-s', line.serial, ...args])
    if ('failure' in outcome) {
      if (outcome.failure === 'timeout') problems.push(timedOut(`adb -s ${line.serial}`))
      return undefined
    }
    return nonEmpty(outcome.stdout.split(/\r?\n/)[0]?.trim())
  }
  const [model, os] = await Promise.all([
    shell(['shell', 'getprop', 'ro.product.model']),
    shell(['shell', 'getprop', 'ro.build.version.release']),
  ])
  let avd: string | undefined
  if (line.serial.startsWith('emulator-')) {
    const named = await shell(['emu', 'avd', 'name'])
    avd =
      named !== undefined && named !== 'OK' && !named.startsWith('KO')
        ? named
        : await shell(['shell', 'getprop', 'ro.boot.qemu.avd_name'])
  }
  const reported = model ?? line.model
  return {
    serial: line.serial,
    state: line.state,
    ...(reported === undefined ? {} : { model: reported }),
    ...(os === undefined ? {} : { os }),
    ...(avd === undefined ? {} : { avd }),
  }
}

function avdHomeOf(env: Record<string, string | undefined>, home: string): string {
  const avdHome = setting(env, 'ANDROID_AVD_HOME')
  if (avdHome !== undefined) return avdHome
  const emulatorHome = setting(env, 'ANDROID_EMULATOR_HOME')
  if (emulatorHome !== undefined) return join(emulatorHome, 'avd')
  return join(home, '.android', 'avd')
}

async function firstReadable(
  readFile: (path: string) => Promise<string>,
  paths: string[],
): Promise<string | undefined> {
  for (const path of paths) {
    try {
      return await readFile(path)
    } catch {
      continue
    }
  }
  return undefined
}

async function readAvd(
  name: string,
  iniText: string,
  avdHome: string,
  sdks: string[],
  readFile: (path: string) => Promise<string>,
): Promise<AvdHere> {
  const ini = parseProperties(iniText)
  const dirs = [nonEmpty(ini.get('path')), join(avdHome, `${name}.avd`)].filter(
    (dir): dir is string => dir !== undefined,
  )
  const configText = await firstReadable(readFile, dirs.map((dir) => join(dir, 'config.ini')))
  if (configText === undefined) return { name }
  const config = parseProperties(configText)
  const profile = nonEmpty(config.get('hw.device.name'))
  const displayName = nonEmpty(config.get('avd.ini.displayname'))
  const sysdir = nonEmpty(config.get('image.sysdir.1'))
  let os: string | undefined
  let apiLevel: string | undefined
  if (sysdir !== undefined) {
    const buildProp = await firstReadable(
      readFile,
      sdks.map((sdk) => join(sdk, sysdir, 'build.prop')),
    )
    os = nonEmpty(
      buildProp === undefined
        ? undefined
        : parseProperties(buildProp).get('ro.build.version.release'),
    )
    if (os === undefined) {
      const source = await firstReadable(
        readFile,
        sdks.map((sdk) => join(sdk, sysdir, 'source.properties')),
      )
      apiLevel = nonEmpty(
        source === undefined ? undefined : parseProperties(source).get('AndroidVersion.ApiLevel'),
      )
    }
  }
  return {
    name,
    ...(profile === undefined ? {} : { profile }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(os === undefined ? {} : { os }),
    ...(apiLevel === undefined ? {} : { apiLevel }),
  }
}

async function listAvds(
  env: Record<string, string | undefined>,
  home: string,
  readFile: (path: string) => Promise<string>,
  readdir: (path: string) => Promise<string[]>,
): Promise<AvdHere[]> {
  const avdHome = avdHomeOf(env, home)
  let entries: string[]
  try {
    entries = await readdir(avdHome)
  } catch {
    return []
  }
  const sdks = sdkRoots(env, home)
  const avds: AvdHere[] = []
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith('.ini')) continue
    let iniText: string
    try {
      iniText = await readFile(join(avdHome, entry))
    } catch {
      continue
    }
    avds.push(await readAvd(entry.slice(0, -'.ini'.length), iniText, avdHome, sdks, readFile))
  }
  return avds
}

async function listAttached(
  exec: ListingExec,
  env: Record<string, string | undefined>,
): Promise<{ attached: AttachedAndroid[]; problem?: string }> {
  const found = await findAdb(exec, env)
  if (found === undefined) return { attached: [], problem: 'adb not found (set ANDROID_HOME)' }
  const { adb, outcome } = found
  if ('failure' in outcome) {
    const problem =
      outcome.failure === 'timeout'
        ? timedOut('adb devices')
        : `adb devices failed: ${outcome.detail}`
    return { attached: [], problem }
  }
  const problems: string[] = []
  const attached = await Promise.all(
    parseAdbDevices(outcome.stdout).map((line) => describeAttached(exec, adb, line, problems)),
  )
  return problems.length === 0 ? { attached } : { attached, problem: problems[0] }
}

export async function listAndroidDevicesHere(
  options: ListAndroidDevicesHereOptions = {},
): Promise<AndroidHere> {
  const exec = options.exec ?? defaultExec
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const readFile = options.readFile ?? ((path: string) => fsReadFile(path, 'utf8'))
  const readdir = options.readdir ?? ((path: string) => fsReaddir(path))
  const [attached, avds] = await Promise.all([
    listAttached(exec, env),
    listAvds(env, home, readFile, readdir),
  ])
  return {
    attached: attached.attached,
    avds,
    ...(attached.problem === undefined ? {} : { problem: attached.problem }),
  }
}
