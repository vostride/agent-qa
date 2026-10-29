import { canonicalJson } from './canonical-json'
import { sha256hex } from './sha256'

// Parameters arrive already converted to plain JSON Schema by the runner's `describeBoundSurface`.
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

// Object keys and tool names are sorted; array order is semantic and kept.
export function computeToolSchemaDigest(tools: readonly ToolSurfaceEntry[]): string {
  const body = [...tools].sort(compareTool).map(toolRecord).join('')
  return sha256hex(`${text('tool-schema-digest')}${body}`)
}
