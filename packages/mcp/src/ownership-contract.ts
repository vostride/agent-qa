import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_MCP_PACKAGE_NAME = '@vostride/agent-qa-mcp'
export const AGENT_QA_MCP_PACKAGE_DIR = 'packages/mcp'
export const AGENT_QA_MCP_PACKAGE_CLASSES = ['adapter', 'surface'] as const
// re-stated for the write surface. The old line said
// "MCP server exposing the typed function layer", which was true of the v1 server only in the sense
// that it sat beside it — that server owned thirty-three handlers of its own and reached data
// through the dashboard's REST API. What this package owns now is a PROJECTION: declared tool->op
// data, two pure predicates over it, and a factory whose handlers do nothing but validate and call
// `invokeFunction`.
export const AGENT_QA_MCP_ALLOWED_RESPONSIBILITIES = [
  'projecting registered function-layer ops onto MCP tools: the declared tool->op mapping, the '
    + 'scope-visibility predicate, the contract->registerTool derivation, and the per-caller server '
    + 'factory over them',
] as const
// The forbidden line likewise predated the write surface: it named a knowledge-write path, from an
// era when the only danger this package could pose was reading too much. A write surface's danger
// is different in kind — it is a handler that DOES something instead of forwarding — so the
// prohibition is stated as the property the projection must keep rather than as one bad path.
export const AGENT_QA_MCP_FORBIDDEN_RESPONSIBILITIES = [
  'any capability of its own: a tool handler that does anything but validate and call '
    + '`invokeFunction`, any data path that reaches storage or a service without crossing the '
    + 'function layer, any host API (process, filesystem, environment), and any socket of its own '
    + '- the HTTP face it builds is a request function; binding and listening belong to the host',
] as const
// D-20's 16 -> 2 collapse, enforced by `validate:arch` and by nothing bespoke. Both entries are
// protocol packages: `/server` carries `McpServer`, `registerTool` and the stdio serving entry;
// `/node` carries the Node adapter for the loopback HTTP surface. Both speak the stateless wire
// SEP-2575 defines, which is the whole reason the v1 family could not be migrated in place.
// A validator library is deliberately absent — the tools' schemas are the ops' OWN contracts,
// imported from the schema package, and the SDK converts them itself under SEP-2106's full JSON
// Schema 2020-12 posture, so a second conversion recipe here would be a second answer to a question
// the SDK already answers.
export const AGENT_QA_MCP_EXTERNAL_DEPENDENCIES = [
  '@modelcontextprotocol/node',
  '@modelcontextprotocol/server',
] as const
// `core` and `ids` are GONE, and not merely unused — they left with
// the v1 server that named them, together with the five surface-firewall ledger rows that had
// waived their presence here since 384. `schema` is NEW and is the contract vocabulary the mapping
// table's op contracts come from; `agent` is the function layer this package projects.
export const AGENT_QA_MCP_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-agent',
  '@vostride/agent-qa-schema',
] as const

export const AGENT_QA_MCP_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_MCP_PACKAGE_NAME,
  packageDir: AGENT_QA_MCP_PACKAGE_DIR,
  packageClasses: AGENT_QA_MCP_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_MCP_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_MCP_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_MCP_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_MCP_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
