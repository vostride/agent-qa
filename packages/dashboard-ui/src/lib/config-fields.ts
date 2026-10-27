// THE FIELD HELPERS (429-17 · UI-SPEC S2 "Field row", research A1 and Pitfall 1).
//
// These schema blocks have required keys once the block exists, so a leaf-only write into an
// absent one would always fail validation. The write carries the other required siblings at the
// defaults the fields show as placeholders; optional siblings are never materialized (424 note 27).
// The snapshot only offers the defaults; the server writes each one only if the field is absent (429-42).

import type { ConfigChange, ConfigPathSegment } from '@vostride/agent-qa-schema'

import { DURATION_INPUT_ERROR } from './config-copy'

type LeafDefault = string | number | boolean

// prettier-ignore
export const REQUIRED_SIBLING_BLOCKS = {
  'use.timeout': { step: '30s', test: '10m', navigation: '2m' },
  'use.planner': { previousStepCount: 5 },
  'use.logCapture': { console: true, network: true },
  'use.browser': { name: 'chromium', headless: true },
  'use.browser.viewport': { width: 1280, height: 720 },
  'services.cache': { dir: '.agent-qa/cache', ttl: '7d' },
  'services.accessibility': { enabled: false },
} as const satisfies Readonly<Record<string, Readonly<Record<string, LeafDefault>>>>

export type RequiredSiblingBlock = keyof typeof REQUIRED_SIBLING_BLOCKS

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function blockPresent(config: unknown, path: readonly string[]): boolean {
  let node = config
  for (const segment of path) {
    if (!isRecord(node) || !(segment in node)) return false
    node = node[segment]
  }
  return isRecord(node)
}

function startsWith(path: readonly ConfigPathSegment[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment)
}

/** The changes plus, for each set inside an absent all-required block, that block's other required siblings. */
export function completeRequiredSiblings(changes: readonly ConfigChange[], config: unknown): ConfigChange[] {
  const result = [...changes]
  const sets = () => result.filter((change) => change.op === 'set' || change.op === 'set-if-absent')
  for (const change of changes) {
    if (change.op !== 'set') continue
    for (const [block, defaults] of Object.entries(REQUIRED_SIBLING_BLOCKS)) {
      const blockPath = block.split('.')
      if (change.path.length <= blockPath.length || !startsWith(change.path, blockPath)) continue
      if (blockPresent(config, blockPath)) continue
      for (const [key, value] of Object.entries(defaults)) {
        const siblingPath = [...blockPath, key]
        if (sets().some((other) => startsWith(other.path, siblingPath))) continue
        result.push({ op: 'set-if-absent', path: siblingPath, value })
      }
    }
  }
  return result
}

export type DurationInputParse = { valid: true; value: string } | { valid: false; error: string }

// A strict subset of the schema's DurationString (the ms package): a number and one short unit,
// so anything accepted here is accepted by the file's validation too.
const DURATION_PATTERN = /^\d+(?:\.\d+)?(?:ms|s|m|h|d|w|y)$/

export function parseDurationInput(raw: string): DurationInputParse {
  const value = raw.trim()
  return DURATION_PATTERN.test(value) ? { valid: true, value } : { valid: false, error: DURATION_INPUT_ERROR }
}

export function listToText(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => String(item)).join('\n') : ''
}

export function textToList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}
