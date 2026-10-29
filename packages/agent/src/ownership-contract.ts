import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_AGENT_PACKAGE_NAME = '@vostride/agent-qa-agent'
export const AGENT_QA_AGENT_PACKAGE_DIR = 'packages/agent'
export const AGENT_QA_AGENT_PACKAGE_CLASSES = ['providerNeutral', 'storageNeutral'] as const
export const AGENT_QA_AGENT_ALLOWED_RESPONSIBILITIES = [
  'provider-neutral and storage-neutral knowledge write/curation port contract',
  'provider-neutral and storage-neutral tools execution port contract',
  'provider-neutral and storage-neutral agent persistence-store port contract',
  'provider-neutral and storage-neutral approvals gating port contract',
  'provider-neutral and storage-neutral clock port contract',
  'typed function layer: FunctionSpec/FunctionRegistry/invokeFunction, the single surface-capability gate call-site',
] as const
export const AGENT_QA_AGENT_FORBIDDEN_RESPONSIBILITIES = [
  'filesystem, database, or process access',
  'provider invocation ownership',
  'local runtime persistence',
  'concrete platform-adapter, knowledge-store, tool-store, or agent-store implementations',
] as const
// zod is the one external dependency — a pure validation library, legal under
// providerNeutral/storageNeutral, and the source of the JSON-Schema projection the MCP
// and catalog surfaces consume.
//
// `ai` joins it, and the class rules already say this is allowed —
// `providerNeutral` permits the orchestration package by name and forbids only the
// `@ai-sdk/*` vendor adapters. The distinction is exactly the one CHAT-06 is about: the
// orchestration package can DESCRIBE a tool set and issue a call against a model it was
// handed, and it cannot construct a provider client. The chat planner stage uses three of
// its values — `generateText`, `tool`, `jsonSchema` — and receives its LanguageModel
// already built by `createModel` at the host. The chat-model rollcall in `packages/arch`
// pins that: a provider-SDK import anywhere under the chat subtree reds the build.
export const AGENT_QA_AGENT_EXTERNAL_DEPENDENCIES = ['ai', 'zod'] as const
// `runner` arrives with the stream op — the layer consumes the runner-owned
// event-log replay contract (`EventLogPort.read` / `ReplayIncompleteError`) rather than
// restating it, so the resume-token semantics cannot fork between the two. Runner is
// itself providerNeutral + storageNeutral, so the direction rule stays satisfied.
// `@vostride/agent-qa-safety` is gone; its last import was the
// registry's `AuditSink` option. Agent tests still read it, so it stays a devDependency.
export const AGENT_QA_AGENT_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-runner',
  '@vostride/agent-qa-schema',
] as const

export const AGENT_QA_AGENT_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_AGENT_PACKAGE_NAME,
  packageDir: AGENT_QA_AGENT_PACKAGE_DIR,
  packageClasses: AGENT_QA_AGENT_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_AGENT_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_AGENT_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_AGENT_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_AGENT_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
