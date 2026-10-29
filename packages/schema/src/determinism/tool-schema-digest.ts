import { canonicalJson } from './canonical-json'
import { sha256hex } from './sha256'

/**
 * One model-visible tool definition with parameters already converted to plain JSON Schema.
 * The runner-side `describeBoundSurface` producer converts with `z.toJSONSchema`; Zod never
 * enters this browser-safe schema package.
 */
export interface ToolSurfaceEntry {
  name: string
  description: string
  parameters: unknown
}

function text(input: string): string {
  return `${input.length}:${input}`
}

function compareTool(left: ToolSurfaceEntry, right: ToolSurfaceEntry): number {
  if (left.name === right.name) {
    return 0
  }
  return left.name < right.name ? -1 : 1
}

function toolRecord(input: ToolSurfaceEntry): string {
  return text(
    canonicalJson({
      name: input.name,
      description: input.description,
      parameters: input.parameters,
    }),
  )
}

/**
 * Hash the complete model-visible tool surface using deterministic canonical JSON.
 * Object keys and tool names are sorted; array order remains semantic and is preserved.
 */
export function computeToolSchemaDigest(tools: readonly ToolSurfaceEntry[]): string {
  const body = [...tools].sort(compareTool).map(toolRecord).join('')
  return sha256hex(`${text('tool-schema-digest')}${body}`)
}
