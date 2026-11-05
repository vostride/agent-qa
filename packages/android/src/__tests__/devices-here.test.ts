import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findDeviceHere } from '@vostride/agent-qa-core'
import { listAndroidDevicesHere } from '../devices-here.js'
import type { ListingExec } from '../devices-here.js'

type Reply = string | { error: Record<string, unknown> }

function fakeExec(replies: Record<string, Reply>) {
  const calls: string[] = []
  const exec: ListingExec = async (file, args, options) => {
    expect(options.timeout).toBe(10_000)
    const key = [file, ...args].join(' ')
    calls.push(key)
    const reply = replies[key]
    if (reply === undefined) {
      if (file.endsWith('adb')) {
        throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })
      }
      throw new Error(`unexpected command: ${key}`)
    }
    if (typeof reply === 'string') return { stdout: reply }
    throw Object.assign(new Error('command failed'), reply.error)
  }
  return { exec, calls }
}

const ADB_DEVICES = [
  'List of devices attached',
  '37281FDJH00123         device usb:1-1 product:husky model:Pixel_8 device:husky transport_id:1',
  'R58M41ABCDE            device usb:1-2 product:e1sxeea model:SM_S921B device:e1s transport_id:2',
  'emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64',
  '',
].join('\n')

let root: string
let sdk: string
let avdHome: string

async function writeAvd(
  name: string,
  config: Record<string, string>,
  options: { ini?: boolean } = {},
): Promise<void> {
  const dir = join(avdHome, `${name}.avd`)
  await mkdir(dir, { recursive: true })
  const lines = Object.entries(config).map(([key, value]) => `${key}=${value}`)
  await writeFile(join(dir, 'config.ini'), `${lines.join('\n')}\n`)
  if (options.ini !== false) {
    await writeFile(join(avdHome, `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${dir}\n`)
  }
}

async function writeImage(sysdir: string, files: Record<string, string>): Promise<void> {
  const dir = join(sdk, sysdir)
  await mkdir(dir, { recursive: true })
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-qa-devices-here-'))
  sdk = join(root, 'sdk')
  avdHome = join(root, 'avd')
  await mkdir(avdHome, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function env(extra: Record<string, string> = {}) {
  return { ANDROID_HOME: sdk, ANDROID_AVD_HOME: avdHome, ...extra }
}

const ADB = () => join(sdk, 'platform-tools', 'adb')

describe('listAndroidDevicesHere', () => {
  it('lists phones by model and version, a running emulator by its AVD, and AVDs by profile', async () => {
    await writeAvd('Pixel_10_Pro', {
      'hw.device.name': 'pixel_10_pro',
      'avd.ini.displayname': 'Pixel 10 Pro',
      'image.sysdir.1': 'system-images/android-37.1/google_apis_ps16k/arm64-v8a/',
    })
    await writeImage('system-images/android-37.1/google_apis_ps16k/arm64-v8a', {
      'build.prop': '# begin build properties\nro.build.version.release=17\n',
    })
    const adb = ADB()
    const { exec } = fakeExec({
      [`${adb} devices -l`]: ADB_DEVICES,
      [`${adb} -s 37281FDJH00123 shell getprop ro.product.model`]: 'Pixel 8\n',
      [`${adb} -s 37281FDJH00123 shell getprop ro.build.version.release`]: '16\n',
      [`${adb} -s R58M41ABCDE shell getprop ro.product.model`]: 'SM-S921B\r\n',
      [`${adb} -s R58M41ABCDE shell getprop ro.build.version.release`]: '14\r\n',
      [`${adb} -s emulator-5554 shell getprop ro.product.model`]: 'sdk_gphone64_arm64\n',
      [`${adb} -s emulator-5554 shell getprop ro.build.version.release`]: '17\n',
      [`${adb} -s emulator-5554 emu avd name`]: 'Pixel_10_Pro\r\nOK\r\n',
    })

    const listing = await listAndroidDevicesHere({ exec, env: env(), home: root })

    expect(listing).toEqual({
      attached: [
        { serial: '37281FDJH00123', state: 'device', model: 'Pixel 8', os: '16' },
        { serial: 'R58M41ABCDE', state: 'device', model: 'SM-S921B', os: '14' },
        {
          serial: 'emulator-5554',
          state: 'device',
          model: 'sdk_gphone64_arm64',
          os: '17',
          avd: 'Pixel_10_Pro',
        },
      ],
      avds: [
        { name: 'Pixel_10_Pro', profile: 'pixel_10_pro', displayName: 'Pixel 10 Pro', os: '17' },
      ],
    })

    const found = findDeviceHere({
      device: 'pixel',
      platform: 'android',
      model: 'Pixel 10 Pro',
      android: listing,
    })
    expect(found).toEqual({
      found: expect.objectContaining({ udid: 'emulator-5554', running: true }),
    })
  })

  it('reads the API level from source.properties when the image has no build.prop', async () => {
    await writeAvd('Medium_Phone', {
      'hw.device.name': 'medium_phone',
      'avd.ini.displayname': 'Medium Phone',
      'image.sysdir.1': 'system-images/android-37.1/google_apis/arm64-v8a/',
    })
    await writeImage('system-images/android-37.1/google_apis/arm64-v8a', {
      'source.properties': 'Pkg.Revision=1\nAndroidVersion.ApiLevel=37.1\n',
    })
    const { exec } = fakeExec({ [`${ADB()} devices -l`]: 'List of devices attached\n\n' })

    const listing = await listAndroidDevicesHere({ exec, env: env(), home: root })

    expect(listing.avds).toEqual([
      {
        name: 'Medium_Phone',
        profile: 'medium_phone',
        displayName: 'Medium Phone',
        apiLevel: '37.1',
      },
    ])
  })

  it('does not list an AVD directory that has no .ini file', async () => {
    await writeAvd('Pixel_6_Pro_API_34', { 'hw.device.name': 'pixel_6_pro' }, { ini: false })
    await writeAvd('Pixel_9', { 'hw.device.name': 'pixel_9' })
    const { exec } = fakeExec({ [`${ADB()} devices -l`]: 'List of devices attached\n' })

    const listing = await listAndroidDevicesHere({ exec, env: env(), home: root })

    expect(listing.avds.map((avd) => avd.name)).toEqual(['Pixel_9'])
  })

  it('lists an unauthorized or offline phone with its state and asks it nothing', async () => {
    const adb = ADB()
    const { exec, calls } = fakeExec({
      [`${adb} devices -l`]: [
        'List of devices attached',
        'R58M41ABCDF            unauthorized usb:1-3 transport_id:4',
        '0A1B2C3D               offline transport_id:5',
        '',
      ].join('\n'),
    })

    const listing = await listAndroidDevicesHere({ exec, env: env(), home: root })

    expect(listing).toEqual({
      attached: [
        { serial: 'R58M41ABCDF', state: 'unauthorized' },
        { serial: '0A1B2C3D', state: 'offline' },
      ],
      avds: [],
    })
    expect(calls).toEqual([`${adb} devices -l`])
  })

  it('reports a missing adb as a problem and still lists the AVDs', async () => {
    await writeAvd('Pixel_9', { 'hw.device.name': 'pixel_9' })
    const { exec, calls } = fakeExec({})

    const listing = await listAndroidDevicesHere({ exec, env: env(), home: root })

    expect(listing).toEqual({
      attached: [],
      avds: [{ name: 'Pixel_9', profile: 'pixel_9' }],
      problem: 'adb not found (set ANDROID_HOME)',
    })
    expect(calls).toEqual([`${ADB()} devices -l`, 'adb devices -l'])
  })

  it('uses the adb on PATH when no SDK is set', async () => {
    const { exec } = fakeExec({
      'adb devices -l': 'List of devices attached\nR58M41ABCDF unauthorized transport_id:4\n',
    })

    const listing = await listAndroidDevicesHere({
      exec,
      env: { ANDROID_AVD_HOME: avdHome },
      home: root,
    })

    expect(listing).toEqual({
      attached: [{ serial: 'R58M41ABCDF', state: 'unauthorized' }],
      avds: [],
    })
  })

  it('reports an adb that does not answer as a problem instead of throwing', async () => {
    const { exec } = fakeExec({
      [`${ADB()} devices -l`]: { error: { killed: true, signal: 'SIGKILL' } },
    })

    const listing = await listAndroidDevicesHere({ exec, env: env(), home: root })

    expect(listing).toEqual({
      attached: [],
      avds: [],
      problem: 'adb devices did not answer within 10 s',
    })
  })

  it('reports a phone whose properties do not answer, still listing it', async () => {
    const adb = ADB()
    const { exec } = fakeExec({
      [`${adb} devices -l`]: 'List of devices attached\nR58M41ABCDE device model:SM_S921B\n',
      [`${adb} -s R58M41ABCDE shell getprop ro.product.model`]: { error: { killed: true } },
      [`${adb} -s R58M41ABCDE shell getprop ro.build.version.release`]: '14\n',
    })

    const listing = await listAndroidDevicesHere({ exec, env: env(), home: root })

    expect(listing).toEqual({
      attached: [{ serial: 'R58M41ABCDE', state: 'device', model: 'SM_S921B', os: '14' }],
      avds: [],
      problem: 'adb -s R58M41ABCDE did not answer within 10 s',
    })
  })

  it('reads a running emulator AVD from its boot property when the console gives no name', async () => {
    const adb = ADB()
    const { exec } = fakeExec({
      [`${adb} devices -l`]: 'List of devices attached\nemulator-5556 device\n',
      [`${adb} -s emulator-5556 shell getprop ro.product.model`]: 'sdk_gphone64_arm64\n',
      [`${adb} -s emulator-5556 shell getprop ro.build.version.release`]: '16\n',
      [`${adb} -s emulator-5556 emu avd name`]: { error: { code: 1, stderr: 'error: closed\n' } },
      [`${adb} -s emulator-5556 shell getprop ro.boot.qemu.avd_name`]: 'Pixel_9\n',
    })

    const listing = await listAndroidDevicesHere({ exec, env: env(), home: root })

    expect(listing.attached).toEqual([
      {
        serial: 'emulator-5556',
        state: 'device',
        model: 'sdk_gphone64_arm64',
        os: '16',
        avd: 'Pixel_9',
      },
    ])
  })

  it('gives no AVDs when the AVD home does not exist', async () => {
    const { exec } = fakeExec({ [`${ADB()} devices -l`]: 'List of devices attached\n' })

    const listing = await listAndroidDevicesHere({
      exec,
      env: env({ ANDROID_AVD_HOME: join(root, 'missing') }),
      home: root,
    })

    expect(listing).toEqual({ attached: [], avds: [] })
  })

  it('finds the AVD home under ANDROID_EMULATOR_HOME, then under the home directory', async () => {
    await writeAvd('Pixel_9', { 'hw.device.name': 'pixel_9' })
    const { exec } = fakeExec({ [`${ADB()} devices -l`]: 'List of devices attached\n' })

    const underEmulatorHome = await listAndroidDevicesHere({
      exec,
      env: { ANDROID_HOME: sdk, ANDROID_EMULATOR_HOME: root },
      home: join(root, 'nobody'),
    })
    const homeAndroid = join(root, 'user')
    await mkdir(join(homeAndroid, '.android'), { recursive: true })
    await symlink(avdHome, join(homeAndroid, '.android', 'avd'))
    const underHome = await listAndroidDevicesHere({
      exec,
      env: { ANDROID_HOME: sdk },
      home: homeAndroid,
    })

    expect(underEmulatorHome.avds.map((avd) => avd.name)).toEqual(['Pixel_9'])
    expect(underHome.avds.map((avd) => avd.name)).toEqual(['Pixel_9'])
  })
})
