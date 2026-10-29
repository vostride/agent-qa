// Comments are stripped so prose about a forbidden call is not read as the call.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every shipped `.ts` module in this package's `src/`, repo-package-relative, `__tests__` excluded. */
export function packageSourceFiles(dir: string = PACKAGE_SRC_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        return entry.name === '__tests__' ? [] : packageSourceFiles(path)
      }
      return entry.name.endsWith('.ts') ? [path] : []
    })
    .sort()
}

export function relativeToSrc(file: string): string {
  return file.slice(PACKAGE_SRC_DIR.length + 1)
}

/**
 * The source with line and block comments removed, and string/template literals left intact.
 *
 * Literals are preserved deliberately: a token inside a string is data the module really carries —
 * it can be printed, matched or sent — so it is a hit, while a token inside a comment cannot be
 * any of those things. The scanner tracks quoting so that a `//` inside a URL is not read as the
 * start of a comment, which is the one case a naive line-stripper gets wrong in this package (the
 * PostHog host constant is `https://us.i.posthog.com`).
 */
export function withoutComments(source: string): string {
  let out = ''
  let index = 0
  let quote: string | null = null

  while (index < source.length) {
    const char = source[index] as string
    const next = source[index + 1]

    if (quote !== null) {
      out += char
      if (char === '\\') {
        out += source[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      index += 1
      continue
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }

    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }

    out += char
    index += 1
  }

  return out
}

/** The shipped modules whose CODE (not prose) contains `token`, named relative to `src/`. */
export function sourceModulesContaining(token: string): string[] {
  return packageSourceFiles()
    .filter((file) => withoutComments(readFileSync(file, 'utf8')).includes(token))
    .map(relativeToSrc)
}
