import {
  AgentQaConfigSchema,
  HooksFileSchema,
  SuiteDefinitionSchema,
  TestDefinitionSchema,
} from '@vostride/agent-qa-core'
import {
  getEntityIdContracts,
  type EntityIdType,
} from '@vostride/agent-qa-ids'

export const SCHEMA_REFERENCE_NAMES = ['config', 'test', 'suite', 'hooks', 'ids'] as const
export type SchemaReferenceName = typeof SCHEMA_REFERENCE_NAMES[number]
export const VALIDATION_KINDS = ['config', 'test', 'suite', 'hooks'] as const
export type ValidationKind = typeof VALIDATION_KINDS[number]

export const AGENT_QA_SCHEMA_REFERENCES = {
  config: {
    name: 'agent-qa config',
    rootKeys: ['workspace', 'services', 'registry', 'use', 'analytics'],
    services: {
      dashboard: ['port', 'dbPath', 'artifactsDir'],
      mcp: ['enabled', 'transport', 'host', 'port', 'path'],
      cache: ['dir', 'ttl'],
      logging: ['level'],
      recording: ['enabled'],
      accessibility: ['enabled', 'standard', 'runAfter', 'failOnViolation', 'disableRules', 'exclude'],
      memory: ['enabled', 'provider', 'dir', 'minTrust', 'maxInjections', 'curatorEnabled'],
    },
    mcpLocalOnly: {
      transports: ['http', 'stdio'],
      hosts: ['localhost', '127.0.0.1', '::1'],
      defaultPort: 3471,
      defaultPath: '/mcp',
    },
  },
  test: {
    name: 'agent-qa test YAML',
    requiredKeys: ['test-id', 'name', 'target', 'steps'],
    optionalKeys: ['context', 'use', 'meta', 'setup', 'teardown'],
    idType: 'test' as EntityIdType,
    hookReferences: 'setup and teardown arrays must contain canonical h_ hook IDs.',
    stepFormats: ['string', 'object with step/timeout/retries/screenshot/capture/maxAttempts'],
  },
  suite: {
    name: 'agent-qa suite YAML',
    requiredKeys: ['name', 'target', 'tests'],
    optionalKeys: ['suite-id', 'context', 'setup', 'teardown', 'use'],
    idType: 'suite' as EntityIdType,
    testReference: 'Each tests[] entry uses { test: path, id: canonical t_ test ID }.',
    hookReferences: 'setup and teardown arrays must contain canonical h_ hook IDs.',
  },
  hooks: {
    name: 'agent-qa hooks file',
    rootKeys: ['hooks'],
    hookKeys: ['id', 'name', 'runtime', 'file', 'deps', 'packageFile', 'timeout', 'network'],
    idType: 'hook' as EntityIdType,
    runtimes: ['node', 'bun', 'python', 'bash'],
  },
  ids: {
    name: 'agent-qa canonical IDs',
    instruction: 'Generate IDs with agent_qa_generate_id or `agent-qa ids generate <type>`; never hand-write IDs.',
    contracts: getEntityIdContracts(),
  },
} as const

const VALIDATION_SCHEMAS = {
  config: AgentQaConfigSchema,
  test: TestDefinitionSchema,
  suite: SuiteDefinitionSchema,
  hooks: HooksFileSchema,
} as const

export interface ValidationIssue {
  path: string
  message: string
}

export interface DefinitionValidationResult {
  valid: boolean
  kind: ValidationKind
  issues: ValidationIssue[]
}

export function validateAgentQaDefinition(
  kind: ValidationKind,
  definition: unknown,
): DefinitionValidationResult {
  const result = VALIDATION_SCHEMAS[kind].safeParse(definition)
  if (result.success) {
    return {
      valid: true,
      kind,
      issues: [],
    }
  }

  return {
    valid: false,
    kind,
    issues: result.error.issues.map(issue => ({
      path: issue.path.map(String).join('.') || '(root)',
      message: issue.message,
    })),
  }
}
