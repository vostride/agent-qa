import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_MCP_PACKAGE_NAME = '@vostride/agent-qa-mcp'
export const AGENT_QA_MCP_PACKAGE_DIR = 'packages/mcp'
export const AGENT_QA_MCP_PACKAGE_CLASSES = ['adapter', 'surface'] as const
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
// Two protocol packages speaking the stateless SEP-2575 wire; the SDK converts schemas itself.
export const AGENT_QA_MCP_EXTERNAL_DEPENDENCIES = [
  '@modelcontextprotocol/node',
  '@modelcontextprotocol/server',
] as const
// `schema` supplies the op contracts; `agent` is the function layer this package projects.
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
