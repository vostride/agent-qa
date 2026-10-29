// A source scanner for the two source-anchored cells in this package.
//
// WHY COMMENTS ARE STRIPPED, and why finding out cost a red. The `.strip()` cell was first written
// as a raw substring search and immediately reported `events.ts` and `ownership-contract.ts` as
// offenders — for the comments that explain why `.strip()` was ABOLISHED. A detector that cannot
// tell a call from a sentence about a call has two failure modes and both are bad: it reds on prose
// (which trains everyone to weaken it), and the natural weakening — an exclusion list of the files
// that talk about the rule — silently stops covering exactly the files most likely to break it.
//
// The same class of false positive is on record one package over: `packages/arch`'s specifier
// extractor keys on `from '...'`, and prose containing that phrase has been parsed as an import.
//
// This module lives under `__tests__` on purpose. It is not shipped: `tsup` bundles from
// `src/index.ts`, `packages/arch`'s scanner skips `__tests__`, and vitest only collects `*.test.ts`.

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
