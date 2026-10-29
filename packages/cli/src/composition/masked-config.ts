// The `config.get` view. Every leaf is rendered to a string
// and passed through the host's declared-secret mask, and nothing else decides what is shown: no
// path map, no URL reduction, no placeholder. `masked` is true exactly when the mask changed the
// value.

import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type {
  ConfigValueSource,
  MaskFn,
  MaskedConfigEntry,
  MaskedResolvedConfig,
} from '@vostride/agent-qa-schema'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function renderValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
}

// Arrays are descended into with numeric index segments; empty containers stay leaves.
function flatten(value: unknown): Map<string, unknown> {
  const flat = new Map<string, unknown>()

  const visit = (node: unknown, path: string): void => {
    if (isPlainObject(node) && Object.keys(node).length > 0) {
      for (const [key, child] of Object.entries(node)) {
        visit(child, path === '' ? key : `${path}.${key}`)
      }
      return
    }
    if (Array.isArray(node) && node.length > 0) {
      node.forEach((child, index) => {
        visit(child, path === '' ? String(index) : `${path}.${index}`)
      })
      return
    }
    if (path !== '') flat.set(path, node)
  }

  visit(value, '')
  return flat
}

export interface ConfigLayer {
  source: ConfigValueSource
  /** The raw, unflattened contribution of this layer. */
  values: unknown
}

export interface BuildMaskedResolvedConfigInput {
  /** The configuration file the read resolved against, as the caller addressed it. */
  configPath: string
  /** The merged, schema-validated configuration the entries describe. */
  resolved: unknown
  /**
   * Contributing layers in ASCENDING precedence order — the last layer carrying a key owns
   * its provenance. A key no layer supplied came from a schema default.
   */
  layers: readonly ConfigLayer[]
  mask: MaskFn
}

export function buildMaskedResolvedConfig(
  input: BuildMaskedResolvedConfigInput,
): MaskedResolvedConfig {
  const layers = input.layers.map((layer) => ({
    source: layer.source,
    keys: new Set(flatten(layer.values).keys()),
  }))

  const entries: MaskedConfigEntry[] = [...flatten(input.resolved).entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, leaf]) => {
      const rendered = renderValue(leaf)
      const value = input.mask(rendered)
      let source: ConfigValueSource = 'default'
      for (const layer of layers) {
        if (layer.keys.has(key)) source = layer.source
      }
      return { key, value, source, masked: value !== rendered }
    })

  return {
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: input.configPath,
    entries,
  }
}
