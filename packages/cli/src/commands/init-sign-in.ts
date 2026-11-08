import {
  getLLMAuthProviderPlugin,
  loadLLMAuthPlugins,
  writeAuth,
  type LLMAuthProviderPlugin,
  type OAuthTokens,
  type StartAuthResult,
} from '@vostride/agent-qa-core'
import { SUBSCRIPTION_AUTH_ENTRY_NAME } from '@vostride/agent-qa-schema'

import type { InitUi } from '../init-ui/init-ui.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from './scaffold-content.js'

export const PASTE_THE_CODE = 'Paste the code (Enter to sign in later)'
export const WAITING_FOR_THE_BROWSER = 'Waiting for the browser (Enter to sign in later)'
export const OPENING_THE_SIGN_IN_PAGE = 'Opening your browser. If it does not open, go to:'

export type InitSignInOutcome = 'signed-in' | 'deferred'

function cannotSignIn(plugin: LLMAuthProviderPlugin): Error {
  return new Error(`The ${plugin.label} plugin cannot sign in from the command line.`)
}

// A plugin may split a `code#state` paste and echo either part, raw or URL-encoded, in its
// error. The whole value, each `#` part and their encoded forms are masked, longest first.
function maskPasted(message: string, pasted: string): string {
  const parts = [pasted, ...pasted.split('#')].filter((part) => part !== '')
  const forms = [...new Set(parts.flatMap((part) => [part, encodeURIComponent(part)]))]
  forms.sort((a, b) => b.length - a.length)
  return forms.reduce((text, form) => text.replaceAll(form, '***'), message)
}

// The pasted code never leaves this function, not even inside an error message.
async function pasteTheCode(
  ui: InitUi,
  plugin: LLMAuthProviderPlugin,
  started: StartAuthResult,
): Promise<OAuthTokens | undefined> {
  if (plugin.exchangeCode === undefined) throw cannotSignIn(plugin)
  const code = (await ui.text({ message: PASTE_THE_CODE, defaultValue: '', secret: true })).trim()
  if (code === '') return undefined
  try {
    return await plugin.exchangeCode({ code, sessionState: started.sessionState })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(maskPasted(message, code))
  }
}

type BrowserResult = { tokens: OAuthTokens } | { error: unknown }
type PromptResult = { later: true } | { cancelled: unknown }

// Whichever comes first wins: the browser's tokens abort the prompt, Enter leaves the browser.
async function raceTheBrowser(
  ui: InitUi,
  waitForTokens: Promise<OAuthTokens>,
): Promise<OAuthTokens | undefined> {
  const controller = new AbortController()
  const browser: Promise<BrowserResult> = waitForTokens.then(
    (tokens) => ({ tokens }),
    (error: unknown) => ({ error }),
  )
  const prompt: Promise<PromptResult> = ui
    .text({ message: WAITING_FOR_THE_BROWSER, defaultValue: '', signal: controller.signal })
    .then(
      () => ({ later: true }) as const,
      (cancelled: unknown) => ({ cancelled }),
    )
  const first = await Promise.race([browser, prompt])
  if ('later' in first) return undefined
  if ('cancelled' in first) throw first.cancelled
  controller.abort()
  // The prompt ends on the abort; a cancel it reports then is the abort's, not the person's.
  await prompt
  if ('error' in first) throw first.error
  return first.tokens
}

// The project's own installed plugin, loaded from the project folder.
export async function loadSubscriptionPlugin(input: {
  provider: string
  projectDir: string
  configPath: string
}): Promise<LLMAuthProviderPlugin> {
  await loadLLMAuthPlugins(
    [{ name: SUBSCRIPTION_AUTH_ENTRY_NAME, package: SUBSCRIPTION_AUTH_PACKAGE }],
    { baseDir: input.projectDir, configPath: input.configPath },
  )
  const plugin = getLLMAuthProviderPlugin(input.provider)
  if (plugin === undefined) {
    throw new Error(`The subscription plugin has no sign-in for ${input.provider}.`)
  }
  return plugin
}

export async function runInitSignIn(input: {
  ui: InitUi
  plugin: LLMAuthProviderPlugin
  configName: string
  authPath: string
  openUrl: (url: string) => void
}): Promise<InitSignInOutcome> {
  const { ui, plugin, configName, authPath, openUrl } = input
  if (plugin.startAuth === undefined) throw cannotSignIn(plugin)
  const started = await plugin.startAuth({ configName })
  // Whatever happens below, a callback server that fails late is not an unhandled rejection.
  started.waitForTokens?.catch(() => undefined)
  try {
    // The opener cannot tell whether a page opened, so the address is always shown.
    ui.line(OPENING_THE_SIGN_IN_PAGE)
    ui.copyable(started.authorizeUrl)
    openUrl(started.authorizeUrl)
    let tokens: OAuthTokens | undefined
    if (started.waitForTokens !== undefined) {
      tokens = await raceTheBrowser(ui, started.waitForTokens)
    } else if (plugin.dashboardAuth.mode === 'manual-code') {
      tokens = await pasteTheCode(ui, plugin, started)
    } else {
      throw cannotSignIn(plugin)
    }
    if (tokens === undefined) return 'deferred'
    await writeAuth(
      configName,
      { type: 'oauth', provider: plugin.credentialProviderId, tokens },
      authPath,
    )
    return 'signed-in'
  } finally {
    started.cleanup?.()
  }
}
