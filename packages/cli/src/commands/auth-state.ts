import { createInterface } from 'node:readline/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { Command } from 'commander'
import pc from 'picocolors'
import {
  AUTH_STATE_SCHEMA_VERSION,
  readAuthStateMetadata,
  resolveAuthStatePaths,
  writeAuthStateFiles,
} from '@vostride/agent-qa-core'
import { resolveConfig } from '../config.js'
import { resolveTarget } from '../targets.js'

type BrowserName = 'chromium' | 'firefox' | 'webkit'
type ConfirmationResult = 'confirmed' | 'cancelled' | 'browser-closed'

interface BrowserLike {
  close(): Promise<void>
  on(event: 'disconnected', listener: () => void): unknown
  off?(event: 'disconnected', listener: () => void): unknown
  newContext(): Promise<{
    newPage(): Promise<{ goto(url: string, options?: Record<string, unknown>): Promise<unknown> }>
    storageState(options?: { indexedDB?: boolean }): Promise<unknown>
  }>
}

interface BrowserLauncher {
  launch(options: { headless: boolean }): Promise<BrowserLike>
}

interface PlaywrightLaunchers {
  chromium: BrowserLauncher
  firefox: BrowserLauncher
  webkit: BrowserLauncher
}

export interface CaptureConfirmationInput {
  browser: BrowserLike
  message: string
}

export interface AuthStateCommandDeps {
  launchers?: PlaywrightLaunchers
  waitForConfirmation?: (input: CaptureConfirmationInput) => Promise<ConfirmationResult>
  now?: () => Date
}

function getGlobalConfigPath(command: Command): string | undefined {
  return command.parent?.parent?.opts<{ config?: string }>().config
    ?? command.parent?.opts<{ config?: string }>().config
}

function isBrowserName(value: unknown): value is BrowserName {
  return value === 'chromium' || value === 'firefox' || value === 'webkit'
}

function resolveBrowserName(config: unknown): BrowserName {
  const name = (config as { use?: { browser?: { name?: unknown } } }).use?.browser?.name
  return isBrowserName(name) ? name : 'chromium'
}

async function loadPlaywrightLaunchers(): Promise<PlaywrightLaunchers> {
  const { chromium, firefox, webkit } = await import('playwright-core')
  return { chromium, firefox, webkit }
}

export async function waitForCaptureConfirmation(
  input: CaptureConfirmationInput,
): Promise<ConfirmationResult> {
  console.log(input.message)
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  return await new Promise<ConfirmationResult>((resolve) => {
    let settled = false

    const finish = (result: ConfirmationResult): void => {
      if (settled) return
      settled = true
      process.off('SIGINT', onSigint)
      input.browser.off?.('disconnected', onDisconnected)
      rl.close()
      resolve(result)
    }

    const onSigint = (): void => finish('cancelled')
    const onDisconnected = (): void => finish('browser-closed')

    process.once('SIGINT', onSigint)
    input.browser.on('disconnected', onDisconnected)

    rl.question('')
      .then(() => finish('confirmed'))
      .catch(() => finish('cancelled'))
  })
}

async function authStateExists(paths: Parameters<typeof readAuthStateMetadata>[0]): Promise<boolean> {
  try {
    await readAuthStateMetadata(paths)
    return true
  } catch {
    return false
  }
}

function buildConfirmationMessage(targetName: string, stateName: string, exists: boolean): string {
  const replace = exists ? ' Existing auth state will be replaced.' : ''
  return `Log in in the opened browser, then press Enter to save auth state "${stateName}" for target "${targetName}".${replace} Press Ctrl+C to cancel.`
}

async function closeBrowser(browser: BrowserLike | undefined): Promise<void> {
  if (!browser) return
  try {
    await browser.close()
  } catch {
    // Browser may already be closed by the user.
  }
}

export function createAuthStateCommand(deps: AuthStateCommandDeps = {}): Command {
  const cmd = new Command('auth-state')
    .description('Manage product auth state')

  cmd.addCommand(
    new Command('capture')
      .description('Capture a named web auth state for a target')
      .requiredOption('--target <target>', 'target name from agent-qa config')
      .requiredOption('--name <name>', 'logical auth-state name')
      .action(async (opts: { target: string; name: string }, command: Command) => {
        const configPath = getGlobalConfigPath(command) ?? 'agent-qa.config.yaml'
        const configDir = dirname(resolvePath(configPath))
        let browser: BrowserLike | undefined

        try {
          const config = await resolveConfig({ configPath, loadAuthPlugins: false })
          const target = resolveTarget(config, opts.target)
          const paths = resolveAuthStatePaths({
            configDir,
            authStateDir: config.services?.authState?.dir,
            targetName: target.name,
            stateName: opts.name,
            target: { platform: target.platform },
          })

          if (!target.url) {
            console.error(pc.red(`Target "${target.name}" must define a web URL for auth-state capture.`))
            process.exitCode = 1
            return
          }

          const launchers = deps.launchers ?? await loadPlaywrightLaunchers()
          const browserName = resolveBrowserName(config)
          browser = await launchers[browserName].launch({ headless: false })
          const context = await browser.newContext()
          const page = await context.newPage()
          await page.goto(target.url, { waitUntil: 'domcontentloaded' })

          const exists = await authStateExists(paths)
          const waitForConfirmation = deps.waitForConfirmation ?? waitForCaptureConfirmation
          const confirmation = await waitForConfirmation({
            browser,
            message: buildConfirmationMessage(target.name, opts.name, exists),
          })

          if (confirmation === 'cancelled') {
            await closeBrowser(browser)
            console.log('Auth-state capture cancelled.')
            process.exitCode = 1
            return
          }

          if (confirmation === 'browser-closed') {
            await closeBrowser(browser)
            console.error(pc.red('Browser was closed before auth state was saved.'))
            process.exitCode = 1
            return
          }

          const payload = await context.storageState({ indexedDB: true })
          try {
            await writeAuthStateFiles(paths, {
              payload,
              metadata: {
                version: AUTH_STATE_SCHEMA_VERSION,
                kind: 'web',
                target: target.name,
                name: opts.name,
                capturedAt: (deps.now ?? (() => new Date()))().toISOString(),
              },
            })
          } catch {
            await closeBrowser(browser)
            console.error(pc.red(`Could not save auth state "${opts.name}" for target "${target.name}".`))
            process.exitCode = 1
            return
          }

          await closeBrowser(browser)
          console.log(`Saved auth state "${opts.name}" for target "${target.name}".`)
        } catch (error) {
          await closeBrowser(browser)
          console.error(pc.red(error instanceof Error ? error.message : String(error)))
          process.exitCode = 1
        }
      }),
  )

  return cmd
}
