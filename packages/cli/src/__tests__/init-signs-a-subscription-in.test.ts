// An interactive init signs a subscription in on the rail through the project's installed plugin.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  clearLLMAuthProviderPlugins,
  clearLoadedLLMAuthPluginModules,
  getAgentQaVersion,
  getAuthPath,
} from '@vostride/agent-qa-core'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { createInitCommand } from '../commands/init.js'
import { installedAgentQaVersion } from '../commands/package-json-plan.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { PromptCancelled } from '../composition/cli-refusal.js'
import { fakeInitUi, type FakeInitUi } from './fake-init-ui.js'
import {
  cleanupTempProjects,
  fakeRunner,
  tempProject,
  writeInstalledPackage,
} from './project-fixtures.js'
import { takeGuardedCalls } from './test-side-effect-guard.js'

const spawned = vi.hoisted(() => [] as string[])

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const record =
    <T extends (...args: never[]) => unknown>(fn: T) =>
    (...args: Parameters<T>): ReturnType<T> => {
      spawned.push(String(args[0]))
      return fn(...args) as ReturnType<T>
    }
  return {
    ...real,
    spawn: record(real.spawn),
    spawnSync: record(real.spawnSync),
    exec: record(real.exec),
    execFile: record(real.execFile),
  }
})

const SUBSCRIPTION_AUTH_PACKAGE = '@vostride/agent-qa-subscription-auth'
const PASTE_THE_CODE = 'Paste the code (Enter to sign in later)'
const WAITING_FOR_THE_BROWSER = 'Waiting for the browser (Enter to sign in later)'
const SIGN_IN_PAGE_OPEN = 'The sign-in page is open in your browser.'
const CONTROL = Symbol.for('agent-qa.fake-subscription-plugin')
const AUTHORIZE_URL = 'https://auth.example.test/authorize?state=SESSION-STATE-5d1e'
const FAKE_TOKEN = 'FAKE-OAUTH-TOKEN-4b8c'
const PASTED_CODE = 'PASTED-CODE-91f2'
const LOGIN = 'npx agent-qa auth login --config claude-code'
const WEB = [
  '--platform',
  'web',
  '--llm',
  'claude-code',
  '--no-browsers',
  '--agents',
  'none',
  '--pm',
  'npm',
]
const TOKENS = { access: FAKE_TOKEN, refresh: FAKE_TOKEN, expires: 4_102_444_800_000 }

interface PluginControl {
  mode: 'manual-code' | 'browser-poll'
  startAuth: (ctx: { configName: string }) => Promise<unknown>
  exchangeCode: (ctx: { code: string; sessionState: unknown }) => Promise<unknown>
}

function control(): PluginControl {
  return (globalThis as unknown as Record<symbol, PluginControl>)[CONTROL]!
}

function setControl(next: Partial<PluginControl>): PluginControl {
  const value: PluginControl = {
    mode: 'manual-code',
    startAuth: vi.fn(async () => ({ authorizeUrl: AUTHORIZE_URL, sessionState: 'session-1' })),
    exchangeCode: vi.fn(async () => TOKENS),
    ...next,
  }
  ;(globalThis as unknown as Record<symbol, PluginControl>)[CONTROL] = value
  return value
}

// A stand-in for the subscription plugin: the test drives it, and it makes no call of its own.
function installFakeSubscriptionPlugin(root: string): void {
  writeInstalledPackage(root, SUBSCRIPTION_AUTH_PACKAGE, getAgentQaVersion().trim(), {
    packageJson: { type: 'module', exports: './index.js' },
    files: {
      'index.js': [
        "const control = () => globalThis[Symbol.for('agent-qa.fake-subscription-plugin')]",
        'export const providers = [{',
        "  providerId: 'anthropic-subscription',",
        "  credentialProviderId: 'anthropic-subscription',",
        "  label: 'Claude subscription',",
        "  modelAdapter: 'anthropic-messages',",
        '  dashboardAuth: { mode: control().mode },',
        '  startAuth: (ctx) => control().startAuth(ctx),',
        '  exchangeCode: (ctx) => control().exchangeCode(ctx),',
        '  createAuthFetch: () => async () => {',
        "    throw new Error('the fake plugin made a call')",
        '  },',
        '}]',
        '',
      ].join('\n'),
    },
  })
}

function installAgentQa(root: string, version = installedAgentQaVersion()): void {
  writeInstalledPackage(root, 'agent-qa', version, {
    packageJson: { bin: { 'agent-qa': 'cli.js' } },
    files: { 'cli.js': '' },
  })
}

interface Project {
  root: string
  home: string
  authPath: string
}

function project(
  options: { plugin?: boolean; agentQa?: 'running' | 'none' | 'older' } = {},
): Project {
  const { root, home } = tempProject('sign-in')
  if (options.plugin !== false) installFakeSubscriptionPlugin(root)
  const agentQa = options.agentQa ?? 'running'
  if (agentQa === 'running') installAgentQa(root)
  if (agentQa === 'older') {
    installAgentQa(root, '0.0.1')
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ devDependencies: { 'agent-qa': 'file:./vendor/agent-qa' } })}\n`,
    )
  }
  if (agentQa === 'none') {
    writeInstalledPackage(root, 'agent-qa', installedAgentQaVersion())
  }
  return { root, home, authPath: getAuthPath({ env: {}, homeDir: home }) }
}

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_init-sign-in', runtimeContext: 'user' }),
  })

interface InitRun {
  error: unknown
  opened: string[]
}

async function init(
  { root, home }: Project,
  ui: FakeInitUi,
  options: { args?: readonly string[]; isTTY?: boolean; opener?: 'fake' | 'none' } = {},
): Promise<InitRun> {
  const opened: string[] = []
  const parent = new Command()
  const command = createInitCommand({
    cwd: root,
    host: {
      homedir: home,
      env: {},
      run: fakeRunner(({ args }) => ({
        code: 0,
        signal: null,
        output: args[0] === '--version' ? '10.0.0\n' : '',
      })),
    },
    isTTY: options.isTTY ?? true,
    ui,
    composeAnalytics: silentAnalytics,
    ...(options.opener === 'none' ? {} : { openUrl: (url: string) => void opened.push(url) }),
  })
  parent.exitOverride()
  command.exitOverride()
  parent.addCommand(command)
  const error = await parent
    .parseAsync(['node', 'test', 'init', ...(options.args ?? WEB)])
    .then(
      () => undefined,
      (caught: unknown) => caught,
    )
  return { error, opened }
}

function stored(authPath: string): unknown {
  return existsSync(authPath) ? JSON.parse(readFileSync(authPath, 'utf8')) : undefined
}

function signInEntries(ui: FakeInitUi) {
  return ui.entries.filter(
    (entry) =>
      (entry.kind === 'done' && entry.text.startsWith('Signed in')) ||
      ((entry.kind === 'skipped' || entry.kind === 'failed') && /^Sign-in|sign/u.test(entry.text)),
  )
}

function nextSteps(ui: FakeInitUi): string[] {
  const note = ui.entries.find((entry) => entry.kind === 'note' && entry.text === 'Next steps')
  return note?.kind === 'note' ? note.lines : []
}

function filesUnder(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

let stdout: MockInstance<typeof process.stdout.write>
let stderr: MockInstance<typeof process.stderr.write>

function expectNoSecretOutside({ root, home, authPath }: Project, ui: FakeInitUi): void {
  const outputs = [
    ui.output(),
    JSON.stringify(ui.entries),
    ...[...stdout.mock.calls, ...stderr.mock.calls].map((call) => String(call[0])),
  ]
  const files = [...filesUnder(root), ...filesUnder(home)].filter((path) => path !== authPath)
  for (const text of [...outputs, ...files.map((path) => readFileSync(path, 'utf8'))]) {
    expect(text).not.toContain(FAKE_TOKEN)
    expect(text).not.toContain(PASTED_CODE)
  }
}

beforeEach(() => {
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  setControl({})
})

afterEach(() => {
  vi.restoreAllMocks()
  clearLLMAuthProviderPlugins()
  clearLoadedLLMAuthPluginModules()
  spawned.length = 0
  cleanupTempProjects()
})

describe('manual-code sign-in', () => {
  it('a pasted code is exchanged, stored under the model name and the model is ready', async () => {
    const proj = project()
    const ui = fakeInitUi({ [PASTE_THE_CODE]: PASTED_CODE })

    const { error, opened } = await init(proj, ui)

    expect(error).toBeUndefined()
    expect(opened.join(' ')).toBe(AUTHORIZE_URL)
    expect(control().startAuth).toHaveBeenCalledWith({ configName: 'claude-code' })
    expect(control().exchangeCode).toHaveBeenCalledWith({
      code: PASTED_CODE,
      sessionState: 'session-1',
    })
    expect(stored(proj.authPath)).toEqual({
      'claude-code': { type: 'oauth', provider: 'anthropic-subscription', tokens: TOKENS },
    })
    expect(ui.entries).toContainEqual({ kind: 'line', text: SIGN_IN_PAGE_OPEN })
    expect(signInEntries(ui)).toEqual([{ kind: 'done', text: 'Signed in: claude-code' }])
    expect(nextSteps(ui)).not.toContain(LOGIN)
    expectNoSecretOutside(proj, ui)
  })

  it('Enter signs in later: skipped, nothing stored, the login command in the next steps', async () => {
    const proj = project()
    const ui = fakeInitUi({ [PASTE_THE_CODE]: '' })

    const { error } = await init(proj, ui)

    expect(error).toBeUndefined()
    expect(control().exchangeCode).not.toHaveBeenCalled()
    expect(stored(proj.authPath)).toBeUndefined()
    expect(signInEntries(ui)).toEqual([{ kind: 'skipped', text: 'Sign-in: later' }])
    expect(nextSteps(ui)).toContain(LOGIN)
  })

  it('a rejected code fails the step with the masked message and the login command, exit 3', async () => {
    const proj = project()
    setControl({
      exchangeCode: vi.fn(async ({ code }: { code: string }) => {
        throw new Error(`The code ${code} was refused`)
      }),
    })
    const ui = fakeInitUi({ [PASTE_THE_CODE]: PASTED_CODE })

    const { error } = await init(proj, ui)

    expect(error).toMatchObject({ name: 'CliRefusal', exitCode: 3 })
    expect(signInEntries(ui)).toEqual([
      { kind: 'failed', text: 'The code *** was refused', command: LOGIN },
    ])
    expect(stored(proj.authPath)).toBeUndefined()
    expect(nextSteps(ui)).toContain(LOGIN)
    expectNoSecretOutside(proj, ui)
  })
})

describe('browser-poll sign-in', () => {
  it('tokens from the browser win: they are stored and the prompt is aborted without a cancel', async () => {
    const proj = project()
    const cleanup = vi.fn()
    setControl({
      mode: 'browser-poll',
      startAuth: vi.fn(async () => ({
        authorizeUrl: AUTHORIZE_URL,
        waitForTokens: new Promise((resolve) => setTimeout(() => resolve(TOKENS), 20)),
        cleanup,
      })),
    })
    const ui = fakeInitUi()
    let aborted = false
    ui.text = (q) =>
      new Promise((_resolve, reject) => {
        q.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new PromptCancelled())
        })
      })

    const { error } = await init(proj, ui)

    expect(error).toBeUndefined()
    expect(aborted).toBe(true)
    expect(stored(proj.authPath)).toEqual({
      'claude-code': { type: 'oauth', provider: 'anthropic-subscription', tokens: TOKENS },
    })
    expect(signInEntries(ui)).toEqual([{ kind: 'done', text: 'Signed in: claude-code' }])
    expect(ui.output()).not.toContain('Cancelled.')
    expect(cleanup).toHaveBeenCalledTimes(1)
    expectNoSecretOutside(proj, ui)
  })

  it('Enter wins: cleanup runs once, a late rejection raises nothing and init exits 0', async () => {
    const proj = project()
    const cleanup = vi.fn()
    let rejectLate: (error: Error) => void = () => {}
    setControl({
      mode: 'browser-poll',
      startAuth: vi.fn(async () => ({
        authorizeUrl: AUTHORIZE_URL,
        waitForTokens: new Promise((_resolve, reject) => {
          rejectLate = reject
        }),
        cleanup,
      })),
    })
    const ui = fakeInitUi({ [WAITING_FOR_THE_BROWSER]: '' })

    const { error } = await init(proj, ui)
    rejectLate(new Error('the callback server closed'))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(error).toBeUndefined()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(stored(proj.authPath)).toBeUndefined()
    expect(signInEntries(ui)).toEqual([{ kind: 'skipped', text: 'Sign-in: later' }])
    expect(nextSteps(ui)).toContain(LOGIN)
  })
})

function saveSignIn(proj: Project): void {
  mkdirSync(dirname(proj.authPath), { recursive: true })
  writeFileSync(
    proj.authPath,
    JSON.stringify({
      'claude-code': { type: 'oauth', provider: 'anthropic-subscription', tokens: TOKENS },
    }),
  )
}

describe('when init does not sign in', () => {
  it.each([
    {
      name: 'the model is signed in already',
      proj: () => {
        const proj = project()
        saveSignIn(proj)
        return proj
      },
      skipped: 'Sign-in: skipped (already signed in)',
      login: false,
    },
    {
      name: 'the subscription plugin is not installed',
      proj: () => project({ plugin: false }),
      args: [...WEB.slice(0, -1), 'none'],
      skipped: 'Sign-in: skipped (the subscription plugin is not installed)',
      login: true,
    },
    {
      name: "the project's agent-qa is another version",
      proj: () => project({ agentQa: 'older' }),
      skipped: "Sign-in: skipped (the project's agent-qa differs from this one)",
      login: true,
    },
    {
      name: 'the project has no agent-qa of its own',
      proj: () => project({ agentQa: 'none' }),
      skipped: 'Sign-in: skipped (the project has no agent-qa installed)',
      login: true,
    },
    {
      name: '--yes',
      proj: () => project(),
      args: [...WEB, '--yes'],
      skipped: 'Sign-in: skipped (not interactive)',
      login: true,
    },
    {
      name: '--json',
      proj: () => project(),
      args: [...WEB, '--json'],
      skipped: 'Sign-in: skipped (not interactive)',
      login: true,
    },
    {
      name: 'no terminal',
      proj: () => project(),
      isTTY: false,
      skipped: 'Sign-in: skipped (not interactive)',
      login: true,
    },
  ])('$name: skipped without starting a sign-in', async (cell) => {
    const proj = cell.proj()
    const ui = fakeInitUi({ [PASTE_THE_CODE]: PASTED_CODE })

    const { error, opened } = await init(proj, ui, {
      ...(cell.args === undefined ? {} : { args: cell.args }),
      ...(cell.isTTY === undefined ? {} : { isTTY: cell.isTTY }),
    })

    expect(error).toBeUndefined()
    expect(control().startAuth).not.toHaveBeenCalled()
    expect(opened).toEqual([])
    expect(signInEntries(ui)).toEqual([{ kind: 'skipped', text: cell.skipped }])
    expect(nextSteps(ui).includes(LOGIN)).toBe(cell.login)
  })
})

describe('the sign-in page in a test', () => {
  it('without hooks.openUrl the real opener is refused before any child starts and the step fails', async () => {
    const proj = project()
    const ui = fakeInitUi({ [PASTE_THE_CODE]: PASTED_CODE })

    const { error } = await init(proj, ui, { opener: 'none' })

    expect(takeGuardedCalls()).toEqual(['open https://auth.example.test'])
    expect(spawned.filter((command) => /^(open|xdg-open|cmd|rundll32)$/u.test(command))).toEqual(
      [],
    )
    expect(error).toMatchObject({ name: 'CliRefusal', exitCode: 3 })
    expect(signInEntries(ui)).toEqual([
      {
        kind: 'failed',
        text: 'A test reached the real browser opener. Inject hooks.openUrl.',
        command: LOGIN,
      },
    ])
  })
})

describe('the sign-in page opens without a shell', () => {
  interface Spawned {
    command: string
    args: readonly string[]
    shell: unknown
    verbatim: unknown
  }

  function recordingOpener(platform: NodeJS.Platform) {
    const calls: Spawned[] = []
    const opener = {
      platform,
      spawn: (
        command: string,
        args: readonly string[],
        options: { shell?: unknown; windowsVerbatimArguments?: unknown },
      ) => {
        calls.push({
          command,
          args,
          shell: options.shell,
          verbatim: options.windowsVerbatimArguments,
        })
        return { on: () => undefined, unref: () => {} }
      },
    }
    return { opener, calls }
  }

  it.each([
    { platform: 'darwin' as const, command: 'open', args: [AUTHORIZE_URL] },
    { platform: 'linux' as const, command: 'xdg-open', args: [AUTHORIZE_URL] },
  ])('$platform runs $command with the address as one argument', async ({ platform, command, args }) => {
    const { opener, calls } = recordingOpener(platform)

    const { openInBrowser } = await import('../commands/open-url.js')
    openInBrowser(AUTHORIZE_URL, opener)

    expect(calls).toEqual([{ command, args, shell: false, verbatim: undefined }])
  })

  it('Windows starts a plain address through cmd start, verbatim and without a shell', async () => {
    const { opener, calls } = recordingOpener('win32')

    const { openInBrowser } = await import('../commands/open-url.js')
    openInBrowser(AUTHORIZE_URL, opener)

    expect(calls).toEqual([
      {
        command: 'cmd',
        args: ['/d', '/c', 'start', '""', `"${AUTHORIZE_URL}"`],
        shell: false,
        verbatim: true,
      },
    ])
  })

  it('Windows hands an address with percent escapes to the URL handler as one argument', async () => {
    const { opener, calls } = recordingOpener('win32')
    const url = `${AUTHORIZE_URL}&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback`

    const { openInBrowser } = await import('../commands/open-url.js')
    openInBrowser(url, opener)

    expect(calls).toEqual([
      { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url], shell: false, verbatim: undefined },
    ])
  })
})
