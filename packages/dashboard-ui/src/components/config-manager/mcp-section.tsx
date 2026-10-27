// MCP access: the section edits the services.mcp server switch and port, and nothing else.

import { ConfigField } from "@/components/config-manager/config-field"
import { MCP_FIELD_HELP, MCP_FIELD_LABELS } from "@/lib/config-copy"

function mcpField(...rest: string[]) {
  return { segments: ["services", "mcp", ...rest], tab: "advanced" as const, pattern: ["services", "mcp", ...rest].join(".") }
}

export function McpSection() {
  return (
    <>
      <ConfigField
        field={mcpField("enabled")}
        label={MCP_FIELD_LABELS.enabled}
        kind="switch"
        help={MCP_FIELD_HELP.enabled}
        defaultChecked
      />
      <ConfigField
        field={mcpField("port")}
        label={MCP_FIELD_LABELS.port}
        kind="number"
        placeholder="3471"
        number={{ min: 1, max: 65535, integer: true }}
      />
    </>
  )
}
