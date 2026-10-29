// Lock-free like the ordinal counter: a lost write is restored on the next observation.

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BUILD_ORDINALS_FILE } from './build-ordinal.js'

/** The project-local state file holding product -> tag -> first-seen ordinal. */
export const BUILD_TAGS_FILE = 'build-tags.json'

export type BuildTagMap = Record<string, Record<string, number>>

export async function recordBuildTag(opts: {
  root: string
  product: string
  tag: string
  ordinal: number
}): Promise<void> {
  const map = readBuildTagMap({ root: opts.root })
  const productTags = Object.prototype.hasOwnProperty.call(map, opts.product)
    ? map[opts.product]
    : undefined

  if (productTags && Object.prototype.hasOwnProperty.call(productTags, opts.tag)) return

  const nextMap: BuildTagMap = {
    ...map,
    [opts.product]: {
      ...productTags,
      [opts.tag]: opts.ordinal,
    },
  }
  const file = join(opts.root, BUILD_TAGS_FILE)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(nextMap)}\n`, 'utf-8')
  renameSync(tmp, file)
}

export function resolveBuildTag(opts: {
  root: string
  product: string
  tag: string
}): number | undefined {
  return readBuildTagMap({ root: opts.root })[opts.product]?.[opts.tag]
}

/** Pure read of the current per-product ordinal; never advances build-ordinals.json. */
export function latestBuildOrdinal(opts: { root: string; product: string }): number {
  const parsed = readJsonRecord(join(opts.root, BUILD_ORDINALS_FILE))
  const value = parsed?.[opts.product]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Best-effort, sanitized read: missing, corrupt, and non-object state starts empty. */
export function readBuildTagMap(opts: { root: string }): BuildTagMap {
  const parsed = readJsonRecord(join(opts.root, BUILD_TAGS_FILE))
  if (!parsed) return {}

  const products: Array<[string, Record<string, number>]> = []
  for (const [product, tags] of Object.entries(parsed)) {
    if (!isRecord(tags)) continue

    const validTags = Object.fromEntries(
      Object.entries(tags).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]),
      ),
    )
    products.push([product, validTags])
  }

  return Object.fromEntries(products)
}

function readJsonRecord(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
