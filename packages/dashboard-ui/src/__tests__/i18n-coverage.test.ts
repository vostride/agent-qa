import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import zhCN from "@/lib/locales/zh-CN"

// Contract: every statically translated string in the dashboard UI must have a zh-CN entry,
// so a new t("...") call can never silently fall back to English. Interpolated template
// literals are dynamic and deliberately out of scope: they cannot be matched against a
// static catalogue key.
const SRC_ROOT = path.resolve(__dirname, "..")

// The AST migration uses the local alias tI18n in files that already bind a local t.
// Interpolation params are allowed, so the first argument only needs to be followed by a
// comma or the closing parenthesis: t("Total {count}", { count }).
const CALL = /(?:^|[^A-Za-z0-9_$.])(?:t|tI18n)\(\s*(["\x27\x60])((?:\\.|(?!\1)[^\\])*)\1\s*(?:,|\))/g

// Drop line-leading // comments and /* */ block comments so commented-out examples and
// prose never count as call sites. Only line-leading // is removed: a naive mid-line
// strip would eat URLs inside string literals.
function stripComments(text: string): string {
  return text
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
}

const IGNORED_DIRS = new Set(["locales", "__tests__", "node_modules"])
const BACKTICK = String.fromCharCode(96)

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (IGNORED_DIRS.has(entry)) continue
      out.push(...sourceFiles(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue
    if (/\.test\.(ts|tsx)$/.test(entry)) continue
    out.push(full)
  }
  return out
}

function unescapeKey(raw: string): string {
  return raw.replace(/\\(["\x27\x60\\])/g, "$1")
}

function collectFrom(text: string): string[] {
  const found: string[] = []
  CALL.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CALL.exec(text)) !== null) {
    const raw = match[2]
    // Skip interpolated / dynamic templates.
    if (match[1] === BACKTICK && raw.includes("${")) continue
    const key = unescapeKey(raw)
    if (key.trim() === "") continue
    found.push(key)
  }
  return found
}

function collectedKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>()
  for (const file of sourceFiles(SRC_ROOT)) {
    const text = stripComments(readFileSync(file, "utf8"))
    for (const key of collectFrom(text)) {
      const list = keys.get(key)
      if (list) list.push(path.relative(SRC_ROOT, file))
      else keys.set(key, [path.relative(SRC_ROOT, file)])
    }
  }
  return keys
}

const catalogue = new Set(Object.keys(zhCN as Record<string, string>))

// Fragment keys are stored with their surrounding spaces. A call site may carry the same
// key trimmed (or the other way round), so compare both spellings.
function covered(raw: string): boolean {
  const trimmed = raw.trim()
  return (
    catalogue.has(raw) ||
    catalogue.has(trimmed) ||
    catalogue.has(" " + trimmed) ||
    catalogue.has(trimmed + " ")
  )
}

// The config pages are module-scope constant tables: the largest block of user-facing copy.
// config-copy.ts owns every config sentence and calls t() directly. config-tabs.ts owns ids,
// aliases and state words only, and reaches the UI copy through the CONFIG_SECTION_LABELS
// bridge exported by config-copy.ts, so the guard for it is that bridge import, not a t() count.
const CONFIG_COPY_SOURCE = "lib/config-copy.ts"
const CONFIG_TABS_SOURCE = "lib/config-tabs.ts"

describe("zh-CN catalogue coverage", () => {
  const keys = collectedKeys()

  it("scans translated call sites", () => {
    expect(keys.size).toBeGreaterThan(200)
  })

  it("has a zh-CN entry for every statically translated key", () => {
    const missing: string[] = []
    for (const [raw, files] of keys) {
      if (covered(raw)) continue
      missing.push(raw + "  <- " + files[0])
    }
    expect(missing.sort()).toEqual([])
  })

  it("keeps the config copy tables translated", () => {
    const copy = stripComments(readFileSync(path.join(SRC_ROOT, CONFIG_COPY_SOURCE), "utf8"))
    expect(
      collectFrom(copy).length,
      CONFIG_COPY_SOURCE + " must consume at least one translated string",
    ).toBeGreaterThan(0)

    const tabs = stripComments(readFileSync(path.join(SRC_ROOT, CONFIG_TABS_SOURCE), "utf8"))
    expect(
      tabs.includes("CONFIG_SECTION_LABELS") && tabs.includes("config-copy"),
      CONFIG_TABS_SOURCE + " must keep reading section labels through the config-copy bridge",
    ).toBe(true)
  })
})
