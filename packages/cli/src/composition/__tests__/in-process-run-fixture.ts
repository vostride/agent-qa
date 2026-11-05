// The model points at an unbindable port, so a planner retry never lands in the target's `hits`.

import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { getAgentQaVersion, getAgentQaVersionCheckCachePath } from '@vostride/agent-qa-core'
import { generateHookId, generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'

import { createRunRecord, doorRunAttributes } from '../../commands/run.js'
import type { RunRecord } from '../../commands/run.js'
import { removeTempRoots } from '../../__tests__/temp-roots.js'

export {
  CountingTarget,
  auditRows,
  buildOrdinalsExist,
  eventTypes,
  runDirs,
} from '../../commands/__tests__/suite-run-fixture.js'
export type { AuditRow, FixtureEnvironment } from '../../commands/__tests__/suite-run-fixture.js'

export interface InProcessFixture {
  /** The project directory, real-pathed (macOS `/var` → `/private/var`). */
  readonly project: string
  /** The absolute config path a door hands the producer. */
  readonly configPath: string
  /** `<configDir>/.agent-qa`, the root the evidence check reads. */
  readonly agentQaRoot: string
  /** The workspace-relative path of the standalone test file. */
  readonly testPattern: string
  /** The workspace-relative path of the suite file. */
  readonly suitePattern: string
  /** The suite member's own test id, so a cell can assert the MEMBER ran. */
  readonly memberTestId: string
  /** The second suite member's test id, present only under `secondSuiteMember`. */
  readonly secondMemberTestId?: string
  /** The standalone test's id. */
  readonly directTestId: string
  /** The name the one target is declared under — `IN_PROCESS_TARGET_NAME`, carried per fixture. */
  readonly targetName: string
  /** The second target's name, present only under `secondTarget` — `SECOND_TARGET_NAME`. */
  readonly secondTargetName?: string
  /** The second standalone test on the remote device, only under `remoteDevice.secondTest`. */
  readonly secondDirectTestPattern?: string
  /** The workspace-relative path of the test naming the second target, under `secondTarget`. */
  readonly secondTestPattern?: string
}

export interface InProcessFixtureInput {
  readonly origin: string
  // `undefined` writes no declaration at all: the undeclared case.
  readonly environment?: 'local' | 'shared' | undefined
  /** Omit the env file, so the input preflight has a real refusal to make. */
  readonly omitEnvFile?: boolean
  /** Omit the hooks file. */
  readonly omitHooksFile?: boolean
  /** Omit the secrets file. */
  readonly omitSecretsFile?: boolean
  // Plants one declared secret so masking checks are not vacuous; `omitSecretsFile` overrides it.
  readonly plantedSecret?: string
  /** The path the first target's URL carries after the origin. Defaults to `/in-process-thing`. */
  readonly targetPath?: string
  /** The one step every test the fixture writes carries, in place of the default `Verify` step. */
  readonly stepText?: string
  readonly emptyTestFile?: boolean
  // A door that resolves config before refusing reports `PluginNotInstalledError` instead.
  readonly declareUninstalledAuthPlugin?: boolean
  // Both targets share one explicit `product:`, or `requireSingleInvocationProduct` refuses first.
  readonly secondTarget?: boolean
  // Headed, because `chromium.executablePath()` names only the headed binary the cell plants.
  readonly headedBrowser?: boolean
  // A second member, so a cancel that skips it differs from a run that finishes and publishes it.
  readonly secondSuiteMember?: boolean
  // `use.parallel` in the config, so two triggered runs overlap and so do their confirms.
  readonly parallelRuns?: boolean
  // The explicit-count arm; `parallelRuns` alone is the default-ceiling arm.
  readonly workerCount?: number
  /** Write `use.cache: false` in the config, so every test the fixture writes runs with the cache off. */
  readonly cacheOff?: boolean
  /** With `secondTarget`, the suite's `target:` names the second target while its member keeps the first. */
  readonly suiteOnSecondTarget?: boolean
  /** One `registry.remotes` entry, which the config's `use.browser.remote` picks. */
  readonly remote?: {
    readonly name: string
    readonly protocol: 'playwright' | 'cdp'
    readonly url: string
    readonly headers?: Readonly<Record<string, string>>
  }
  /** With `remote`, the config declares it but does not pick it, so tests launch here. */
  readonly remoteUnpicked?: boolean
  /**
   * With `remote` and its `headers`, the remote's url and headers are anchors under
   * `registry.devices.pixel.capabilities`, and the entry aliases them.
   */
  readonly remoteAnchoredInDevices?: boolean
  /**
   * With `remote`, the `remotes` key is an alias of a scalar anchored under
   * `registry.devices.pixel.capabilities`.
   */
  readonly remotesKeyAliased?: boolean
  /** The suite's own `use.browser.remote`. */
  readonly suitePick?: string
  /** The direct test's own `use.browser.remote`. */
  readonly directTestPick?: string
  /** With `secondTarget`, the second test's own `use.browser.remote`. */
  readonly secondTestPick?: string
  /** More declared secrets, appended to the secrets file after `plantedSecret`. */
  readonly extraSecrets?: Readonly<Record<string, string>>
  /** One `print-env` hook in `hooks.yaml`, listed under the direct test's or the suite's `setup`. */
  readonly setupHook?: 'test' | 'suite'
  /** An OpenAI-compatible model the config declares and uses in place of the unreachable one. */
  readonly model?: { readonly baseUrl: string; readonly id: string }
  /**
   * An appium remote, a device described by model on it and an Android target; the standalone test
   * targets that app on that device.
   */
  readonly remoteDevice?: {
    readonly url: string
    readonly headers?: Readonly<Record<string, string>>
    readonly model: string
    readonly os?: string
    /** An iPhone and an iOS target in place of the Android device and target. */
    readonly platform?: 'ios'
    /** The standalone test's `use.mobile.appState`; `preserve` when absent. */
    readonly appState?: 'reset'
    /** The device's own `capabilities`, written as JSON. */
    readonly capabilities?: Readonly<Record<string, unknown>>
    /** The remote's `basicAuth`. */
    readonly basicAuth?: { readonly user: string; readonly password: string }
    /** The remote's `connectTimeout`, such as `1s`. */
    readonly connectTimeout?: string
    /** The target's `app.path`, written as an empty file in the project, and no `app.ref`. */
    readonly appPath?: string
    /** The target's `app.ref`. */
    readonly appRef?: string
    /** A second standalone test, `tests/direct-2.yaml`, on the same device. */
    readonly secondTest?: boolean
  }
  /** With `remoteDevice`, its target names the remote device and the standalone test names none. */
  readonly deviceOnTarget?: boolean
  /** A device here, `pixel`, described by model `Pixel 8` with no remote. */
  readonly localDevice?: boolean
  /** With `localDevice`, its own `capabilities`, written as JSON. */
  readonly localDeviceCapabilities?: Readonly<Record<string, unknown>>
  /**
   * With `remoteDevice`, the suite and two members run on its target, and each member's
   * `use.device` is the name given (none when undefined).
   */
  readonly suiteMemberDevices?: readonly [string | undefined, string | undefined]
  /** With `suiteMemberDevices`, the suite's own `use.device`. */
  readonly suiteDevice?: string
  /**
   * A device here, `keyed-phone`, whose `appium:keystorePassword` capability is this text, and an
   * android target, `keyed-shop`, whose app.ref is that text; no test the fixture writes uses them.
   */
  readonly connectionOnlyReferences?: { readonly capability: string; readonly appRef: string }
}

/**
 * The package the knob above declares. A fixture project lives under the OS temp dir, so this
 * package never resolves from it.
 */
export const UNINSTALLED_AUTH_PLUGIN_PACKAGE = '@vostride/agent-qa-subscription-auth'

// Exported so cells read the name the config writer interpolates rather than retyping it.
export const IN_PROCESS_TARGET_NAME = 'in-process-thing'

/** The second target's name, declared only when `secondTarget` is set. Its own one definition. */
export const SECOND_TARGET_NAME = 'the-second-thing'

/** The name `plantedSecret` declares its value under. One definition, so a cell need not retype it. */
export const PLANTED_SECRET_NAME = 'AGENT_QA_PLANTED_SECRET'

// The names `remoteDevice` writes, so cells read them rather than retyping them.
export const REMOTE_DEVICE_REMOTE_NAME = 'farm'
export const REMOTE_DEVICE_NAME = 'galaxy-farm'
export const REMOTE_DEVICE_TARGET_NAME = 'shop-android'
export const REMOTE_DEVICE_APP_PACKAGE = 'com.example.shop'
export const REMOTE_IOS_DEVICE_NAME = 'iphone-farm'
export const REMOTE_IOS_TARGET_NAME = 'shop-ios'
export const LOCAL_DEVICE_NAME = 'pixel'
export const LOCAL_DEVICE_MODEL = 'Pixel 8'

const createdProjects: string[] = []

// No hook here, because other test files import this module inside cells.
export function removeInProcessFixtures(): void {
  removeTempRoots(createdProjects.splice(0))
}

/**
 * A temporary HOME whose update-check cache is fresh. The run command's update notice reads
 * `~/.agent-qa/version-check.json` and fetches the registry once that cache is a day old, so a cell
 * that points HOME here answers from the cache: no network, and nothing written to the real home.
 * The cell stubs HOME to it and removes it with its other roots.
 */
export function freshUpdateCheckHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'in-process-home-')))
  createdProjects.push(home)
  const now = new Date().toISOString()
  const cachePath = getAgentQaVersionCheckCachePath(home)
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, `${JSON.stringify({ latestVersion: getAgentQaVersion(), checkedAt: now, lastAttemptedAt: now })}\n`)
  return home
}

/**
 * Write a project with one target, one standalone test and one suite over its own member.
 *
 * Every knob above changes EXACTLY ONE thing, which is what lets a denial cell and its allow
 * control differ in one field and nothing else.
 */
export function createInProcessFixture(input: InProcessFixtureInput): InProcessFixture {
  const step = input.stepText === undefined
    ? '  - Verify the page says "Example"'
    : `  - ${JSON.stringify(input.stepText)}`
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'in-process-run-')))
  createdProjects.push(project)
  mkdirSync(join(project, 'tests'), { recursive: true })
  mkdirSync(join(project, 'suites'), { recursive: true })

  const directTestId = generateTestId()
  const memberTestId = generateTestId()
  const remoteDevice = input.remoteDevice
  const remoteOnIOS = remoteDevice?.platform === 'ios'
  const remoteDeviceName = remoteOnIOS ? REMOTE_IOS_DEVICE_NAME : REMOTE_DEVICE_NAME
  const remoteTargetName = remoteOnIOS ? REMOTE_IOS_TARGET_NAME : REMOTE_DEVICE_TARGET_NAME
  const pixelDevice =
    input.remote !== undefined &&
    (input.remoteAnchoredInDevices === true || input.remotesKeyAliased === true)
  const keyed = input.connectionOnlyReferences
  const anyDevice =
    pixelDevice || remoteDevice !== undefined || input.localDevice === true || keyed !== undefined
  const remoteEntryLines = (remote: {
    readonly name: string
    readonly protocol: string
    readonly url: string
    readonly headers?: Readonly<Record<string, string>>
    readonly basicAuth?: { readonly user: string; readonly password: string }
    readonly connectTimeout?: string
  }): string[] => [
    `    - name: ${remote.name}`,
    `      protocol: ${remote.protocol}`,
    `      url: ${JSON.stringify(remote.url)}`,
    ...(remote.headers === undefined
      ? []
      : [
          '      headers:',
          ...Object.entries(remote.headers).map(
            ([name, value]) => `        ${name}: ${JSON.stringify(value)}`,
          ),
        ]),
    ...(remote.basicAuth === undefined
      ? []
      : [
          '      basicAuth:',
          `        user: ${JSON.stringify(remote.basicAuth.user)}`,
          `        password: ${JSON.stringify(remote.basicAuth.password)}`,
        ]),
    ...(remote.connectTimeout === undefined
      ? []
      : [`      connectTimeout: ${remote.connectTimeout}`]),
  ]

  writeFileSync(
    join(project, 'agent-qa.config.yaml'),
    [
      'workspace:',
      '  testMatch:',
      "    - 'tests/**/*.yaml'",
      '  suiteMatch:',
      "    - 'suites/**/*.suite.yaml'",
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'registry:',
      ...(anyDevice ? ['  devices:'] : []),
      ...(input.remote !== undefined && pixelDevice
        ? [
            '    pixel:',
            '      platform: android',
            '      capabilities:',
            ...(input.remoteAnchoredInDevices === true
              ? [
                  `        appium:avd: &grid ${JSON.stringify(input.remote.url)}`,
                  ...(input.remote.headers === undefined
                    ? []
                    : [
                        '        appium:serial: &hdrs',
                        ...Object.entries(input.remote.headers).map(
                          ([name, value]) => `          ${name}: ${JSON.stringify(value)}`,
                        ),
                      ]),
                ]
              : []),
            ...(input.remotesKeyAliased === true
              ? ['        appium:appPackage: &key remotes']
              : []),
          ]
        : []),
      ...(remoteDevice === undefined
        ? []
        : [
            `    ${remoteDeviceName}:`,
            `      platform: ${remoteOnIOS ? 'ios' : 'android'}`,
            `      model: ${JSON.stringify(remoteDevice.model)}`,
            ...(remoteDevice.os === undefined
              ? []
              : [`      os: ${JSON.stringify(remoteDevice.os)}`]),
            `      remote: ${REMOTE_DEVICE_REMOTE_NAME}`,
            ...(remoteDevice.capabilities === undefined
              ? []
              : [`      capabilities: ${JSON.stringify(remoteDevice.capabilities)}`]),
          ]),
      ...(input.localDevice === true
        ? [
            `    ${LOCAL_DEVICE_NAME}:`,
            '      platform: android',
            `      model: ${JSON.stringify(LOCAL_DEVICE_MODEL)}`,
            ...(input.localDeviceCapabilities === undefined
              ? []
              : [`      capabilities: ${JSON.stringify(input.localDeviceCapabilities)}`]),
          ]
        : []),
      ...(keyed === undefined
        ? []
        : [
            '    keyed-phone:',
            '      platform: android',
            '      model: Pixel 9',
            '      capabilities:',
            `        appium:keystorePassword: ${JSON.stringify(keyed.capability)}`,
          ]),
      '  targets:',
      `    ${IN_PROCESS_TARGET_NAME}:`,
      '      platform: web',
      `      url: ${input.origin}${input.targetPath ?? '/in-process-thing'}`,
      ...(input.environment === undefined ? [] : [`      environment: ${input.environment}`]),
      // Only under the knob, so the default fixture's bytes are exactly what they were.
      ...(input.secondTarget === true ? ['      product: one-product'] : []),
      ...(input.secondTarget === true
        ? [
            `    ${SECOND_TARGET_NAME}:`,
            '      platform: web',
            `      url: ${input.origin}/the-second-thing`,
            '      environment: local',
            '      product: one-product',
          ]
        : []),
      ...(remoteDevice === undefined
        ? []
        : [
            `    ${remoteTargetName}:`,
            ...(remoteOnIOS
              ? ['      platform: ios', `      bundleId: ${REMOTE_DEVICE_APP_PACKAGE}`]
              : ['      platform: android', `      appPackage: ${REMOTE_DEVICE_APP_PACKAGE}`]),
            ...(input.deviceOnTarget === true ? [`      device: ${remoteDeviceName}`] : []),
            ...(remoteDevice.appPath === undefined
              ? []
              : ['      app:', `        path: ${JSON.stringify(remoteDevice.appPath)}`]),
            ...(remoteDevice.appRef === undefined
              ? []
              : ['      app:', `        ref: ${JSON.stringify(remoteDevice.appRef)}`]),
          ]),
      ...(keyed === undefined
        ? []
        : [
            '    keyed-shop:',
            '      platform: android',
            '      appPackage: com.example.keyed',
            '      app:',
            `        ref: ${JSON.stringify(keyed.appRef)}`,
          ]),
      '  llms:',
      ...(input.model === undefined
        ? [
            '    - name: unreachable',
            '      provider: openai-compatible',
            '      model: gpt-4o-mini',
            '      baseURL: http://127.0.0.1:1/v1',
          ]
        : [
            '    - name: reachable',
            '      provider: openai-compatible',
            `      model: ${input.model.id}`,
            `      baseURL: ${input.model.baseUrl}`,
          ]),
      ...(input.remote === undefined && remoteDevice === undefined
        ? []
        : [input.remotesKeyAliased === true ? '  *key :' : '  remotes:']),
      ...(remoteDevice === undefined
        ? []
        : remoteEntryLines({
            name: REMOTE_DEVICE_REMOTE_NAME,
            protocol: 'appium',
            url: remoteDevice.url,
            ...(remoteDevice.headers === undefined ? {} : { headers: remoteDevice.headers }),
            ...(remoteDevice.basicAuth === undefined ? {} : { basicAuth: remoteDevice.basicAuth }),
            ...(remoteDevice.connectTimeout === undefined
              ? {}
              : { connectTimeout: remoteDevice.connectTimeout }),
          })),
      ...(input.remote === undefined
        ? []
        : [
            `    - name: ${input.remote.name}`,
            `      protocol: ${input.remote.protocol}`,
            input.remoteAnchoredInDevices === true
              ? '      url: *grid'
              : `      url: ${JSON.stringify(input.remote.url)}`,
            ...(input.remote.headers === undefined
              ? []
              : input.remoteAnchoredInDevices === true
                ? ['      headers: *hdrs']
                : [
                    '      headers:',
                    ...Object.entries(input.remote.headers).map(
                      ([name, value]) => `        ${name}: ${JSON.stringify(value)}`,
                    ),
                  ]),
          ]),
      ...(input.declareUninstalledAuthPlugin === true
        ? ['plugins:', '  - name: subscription', `    package: '${UNINSTALLED_AUTH_PLUGIN_PACKAGE}'`]
        : []),
      'use:',
      ...(input.headedBrowser === true || input.remote !== undefined
        ? [
            '  browser:',
            '    name: chromium',
            `    headless: ${input.headedBrowser === true ? 'false' : 'true'}`,
            ...(input.remote === undefined || input.remoteUnpicked === true
              ? []
              : [`    remote: ${input.remote.name}`]),
          ]
        : []),
      ...(input.parallelRuns === true ? ['  parallel: true'] : []),
      ...(input.workerCount === undefined ? [] : [`  workers: ${input.workerCount}`]),
      ...(input.cacheOff === true ? ['  cache: false'] : []),
      `  llm: ${input.model === undefined ? 'unreachable' : 'reachable'}`,
      '  mobile:',
      '    appState: preserve',
      '',
    ].join('\n'),
  )
  const hookId = input.setupHook === undefined ? undefined : generateHookId()
  if (input.omitHooksFile !== true) {
    writeFileSync(
      join(project, 'hooks.yaml'),
      hookId === undefined
        ? 'hooks: []\n'
        : [
            'hooks:',
            `  - id: ${hookId}`,
            '    name: print-env',
            '    runtime: node',
            '    file: hooks/print-env.js',
            '    timeout: 30s',
            '',
          ].join('\n'),
    )
  }
  if (hookId !== undefined) {
    mkdirSync(join(project, 'hooks'), { recursive: true })
    // Names only, so the hook's own output never carries a value.
    writeFileSync(
      join(project, 'hooks', 'print-env.js'),
      "console.log(Object.keys(process.env).sort().join('\\n'))\n",
    )
  }
  const setupLines = (scope: 'test' | 'suite'): string[] =>
    hookId !== undefined && input.setupHook === scope ? ['setup:', `  - ${hookId}`] : []
  if (input.omitEnvFile !== true) writeFileSync(join(project, '.env'), '')
  if (input.omitSecretsFile !== true) {
    writeFileSync(
      join(project, '.env.secrets.local'),
      [
        ...(input.plantedSecret === undefined ? [] : [`${PLANTED_SECRET_NAME}=${input.plantedSecret}\n`]),
        ...Object.entries(input.extraSecrets ?? {}).map(([name, value]) => `${name}=${value}\n`),
      ].join(''),
    )
  }

  writeFileSync(
    join(project, 'tests', 'direct.yaml'),
    input.emptyTestFile === true
      ? '# a file that parses to zero runnable tests\n'
      : [
          `test-id: ${directTestId}`,
          'name: the standalone test',
          `target: ${
            remoteDevice === undefined ? IN_PROCESS_TARGET_NAME : remoteTargetName
          }`,
          ...(input.directTestPick === undefined && remoteDevice === undefined ? [] : ['use:']),
          ...(input.directTestPick === undefined
            ? []
            : ['  browser:', `    remote: ${input.directTestPick}`]),
          ...(remoteDevice === undefined
            ? []
            : [
                ...(input.deviceOnTarget === true ? [] : [`  device: ${remoteDeviceName}`]),
                '  mobile:',
                `    appState: ${remoteDevice.appState ?? 'preserve'}`,
              ]),
          ...setupLines('test'),
          'steps:',
          step,
          '',
        ].join('\n'),
  )
  if (remoteDevice?.appPath !== undefined) {
    mkdirSync(dirname(join(project, remoteDevice.appPath)), { recursive: true })
    writeFileSync(join(project, remoteDevice.appPath), '')
  }
  if (remoteDevice?.secondTest === true) {
    writeFileSync(
      join(project, 'tests', 'direct-2.yaml'),
      [
        `test-id: ${generateTestId()}`,
        'name: the second standalone test',
        `target: ${remoteTargetName}`,
        'use:',
        `  device: ${remoteDeviceName}`,
        '  mobile:',
        `    appState: ${remoteDevice.appState ?? 'preserve'}`,
        'steps:',
        step,
        '',
      ].join('\n'),
    )
  }
  const secondTestId = generateTestId()
  if (input.secondTarget === true) {
    writeFileSync(
      join(project, 'tests', 'second.yaml'),
      [
        `test-id: ${secondTestId}`,
        'name: the second target\'s test',
        `target: ${SECOND_TARGET_NAME}`,
        ...(input.secondTestPick === undefined
          ? []
          : ['use:', '  browser:', `    remote: ${input.secondTestPick}`]),
        'steps:',
        step,
        '',
      ].join('\n'),
    )
  }

  const memberDevices = remoteDevice === undefined ? undefined : input.suiteMemberDevices
  const memberTarget = memberDevices === undefined ? IN_PROCESS_TARGET_NAME : remoteTargetName
  const memberDeviceLines = (device: string | undefined): string[] =>
    device === undefined ? [] : ['use:', `  device: ${device}`]
  writeFileSync(
    join(project, 'tests', 'member.yaml'),
    [
      `test-id: ${memberTestId}`,
      'name: the suite member',
      `target: ${memberTarget}`,
      ...memberDeviceLines(memberDevices?.[0]),
      'steps:',
      step,
      '',
    ].join('\n'),
  )
  const secondMemberTestId = generateTestId()
  const withSecondMember = input.secondSuiteMember === true || memberDevices !== undefined
  if (withSecondMember) {
    writeFileSync(
      join(project, 'tests', 'member-2.yaml'),
      [
        `test-id: ${secondMemberTestId}`,
        'name: the second suite member',
        `target: ${memberTarget}`,
        ...memberDeviceLines(memberDevices?.[1]),
        'steps:',
        step,
        '',
      ].join('\n'),
    )
  }
  writeFileSync(
    join(project, 'suites', 'gate.suite.yaml'),
    [
      `suite-id: ${generateSuiteId()}`,
      'name: the in-process suite',
      `target: ${
        memberDevices !== undefined
          ? remoteTargetName
          : input.secondTarget === true && input.suiteOnSecondTarget === true
            ? SECOND_TARGET_NAME
            : IN_PROCESS_TARGET_NAME
      }`,
      ...(input.suitePick === undefined
        ? []
        : ['use:', '  browser:', `    remote: ${input.suitePick}`]),
      ...(memberDevices === undefined || input.suiteDevice === undefined
        ? []
        : ['use:', `  device: ${input.suiteDevice}`]),
      ...setupLines('suite'),
      'tests:',
      '  - test: tests/member.yaml',
      `    id: ${memberTestId}`,
      ...(withSecondMember
        ? ['  - test: tests/member-2.yaml', `    id: ${secondMemberTestId}`]
        : []),
      '',
    ].join('\n'),
  )

  return {
    project,
    configPath: join(project, 'agent-qa.config.yaml'),
    agentQaRoot: join(project, '.agent-qa'),
    testPattern: 'tests/direct.yaml',
    suitePattern: 'suites/gate.suite.yaml',
    memberTestId,
    ...(withSecondMember ? { secondMemberTestId } : {}),
    directTestId,
    targetName: IN_PROCESS_TARGET_NAME,
    ...(input.secondTarget === true
      ? { secondTargetName: SECOND_TARGET_NAME, secondTestPattern: 'tests/second.yaml' }
      : {}),
    ...(remoteDevice?.secondTest === true
      ? { secondDirectTestPattern: 'tests/direct-2.yaml' }
      : {}),
  }
}

const MARKER_AUTH_PLUGIN_PACKAGE = '@vostride/agent-qa-marker-auth'

/**
 * Installs and declares an auth plugin that writes `<project>/plugin-loaded.marker` when it is
 * imported, and returns that marker's path.
 */
export function declareMarkerAuthPlugin(fixture: InProcessFixture): string {
  const marker = join(fixture.project, 'plugin-loaded.marker')
  const packageDir = join(
    fixture.project,
    'node_modules',
    ...MARKER_AUTH_PLUGIN_PACKAGE.split('/'),
  )
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: MARKER_AUTH_PLUGIN_PACKAGE,
      version: '0.0.0',
      type: 'module',
      exports: './index.mjs',
      'agent-qa': { plugin: { kind: 'model-auth', runs: 'in-process', entry: './index.mjs' } },
    }),
  )
  writeFileSync(
    join(packageDir, 'index.mjs'),
    [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(marker)}, String(process.pid))`,
      'export const providers = []',
      '',
    ].join('\n'),
  )
  appendFileSync(
    fixture.configPath,
    `plugins:\n  - name: marker\n    package: "${MARKER_AUTH_PLUGIN_PACKAGE}"\n`,
  )
  return marker
}

const openTestRunRecords: RunRecord[] = []

/** A run record for a cell that calls the drive directly; `closeTestRunRecords` closes it. */
export function testRunRecord(): RunRecord {
  const record = createRunRecord({ attributes: doorRunAttributes('cli'), warn: () => {} })
  openTestRunRecords.push(record)
  return record
}

export function closeTestRunRecords(): void {
  for (const record of openTestRunRecords.splice(0)) record.close()
}
