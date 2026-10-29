import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_KNOWLEDGE_LOCAL_PACKAGE_NAME = '@vostride/agent-qa-knowledge-local'
export const AGENT_QA_KNOWLEDGE_LOCAL_PACKAGE_DIR = 'packages/knowledge-local'
export const AGENT_QA_KNOWLEDGE_LOCAL_PACKAGE_CLASSES = ['storageImplementation'] as const
export const AGENT_QA_KNOWLEDGE_LOCAL_ALLOWED_RESPONSIBILITIES = [
  'local memidex knowledge store, index, and IO implementation behind the agent KnowledgePort write seam',
  'local memidex read face behind the runner KnowledgeHintReader',
  'filesystem access for local knowledge storage',
  'sqlite access for local knowledge storage',
] as const
export const AGENT_QA_KNOWLEDGE_LOCAL_FORBIDDEN_RESPONSIBILITIES = [
  'provider invocation ownership',
  'agent decision or planning logic',
  'platform-adapter execution',
] as const
// Native vec0, the embedding runtime and the floor tokenizer stay behind this seam.
export const AGENT_QA_KNOWLEDGE_LOCAL_EXTERNAL_DEPENDENCIES = [
  '@huggingface/tokenizers',
  '@huggingface/transformers',
  'sqlite-vec',
  'zod',
] as const
export const AGENT_QA_KNOWLEDGE_LOCAL_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-agent',
  '@vostride/agent-qa-runner',
  '@vostride/agent-qa-schema',
  '@vostride/agent-qa-safety',
] as const

export const AGENT_QA_KNOWLEDGE_LOCAL_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_KNOWLEDGE_LOCAL_PACKAGE_NAME,
  packageDir: AGENT_QA_KNOWLEDGE_LOCAL_PACKAGE_DIR,
  packageClasses: AGENT_QA_KNOWLEDGE_LOCAL_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_KNOWLEDGE_LOCAL_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_KNOWLEDGE_LOCAL_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_KNOWLEDGE_LOCAL_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_KNOWLEDGE_LOCAL_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
