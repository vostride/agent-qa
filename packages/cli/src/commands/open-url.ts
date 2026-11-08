import { spawn, type SpawnOptions } from 'node:child_process'

export interface BrowserOpenerChild {
  on(event: 'error', listener: (error: Error) => void): unknown
  unref(): void
}

export interface BrowserOpener {
  readonly platform: NodeJS.Platform
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => BrowserOpenerChild
}

// Anything here could leave cmd.exe's quotes or expand a variable inside them.
const CMD_UNQUOTABLE = /["%^|<>!\u0000-\u001F\u007F]/u

function detached(child: BrowserOpenerChild): void {
  // A missing opener is not a failure: the page can still be opened by hand.
  child.on('error', () => {})
  child.unref()
}

// No shell on any platform: the address is one argument, never a command line.
export function openUrlWithoutShell(url: string, opener: BrowserOpener): void {
  if (opener.platform === 'win32') {
    if (CMD_UNQUOTABLE.test(url)) {
      throw new Error(
        'Refusing to open the page through cmd.exe: its address holds a character cmd.exe ' +
          'would act on.',
      )
    }
    // Verbatim, so cmd reads `start "" "<url>"` and an `&` in the URL stays inside the quotes.
    detached(
      opener.spawn('cmd', ['/d', '/c', 'start', '""', `"${url}"`], {
        shell: false,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      }),
    )
    return
  }
  const command = opener.platform === 'darwin' ? 'open' : 'xdg-open'
  detached(opener.spawn(command, [url], { shell: false, stdio: 'ignore' }))
}

// Reached at call time, so a module graph that stubs child processes can still load this one.
export const systemBrowserOpener: BrowserOpener = {
  platform: process.platform,
  spawn: (command, args, options) => spawn(command, [...args], options),
}

// A sign-in address carries percent escapes cmd.exe would expand, so Windows hands such an
// address to the URL handler as one argument instead.
export function openInBrowser(url: string, opener: BrowserOpener = systemBrowserOpener): void {
  if (opener.platform === 'win32' && CMD_UNQUOTABLE.test(url)) {
    detached(
      opener.spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
        shell: false,
        stdio: 'ignore',
      }),
    )
    return
  }
  openUrlWithoutShell(url, opener)
}
