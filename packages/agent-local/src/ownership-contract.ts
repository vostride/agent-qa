import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_AGENT_LOCAL_PACKAGE_NAME = '@vostride/agent-qa-agent-local'
export const AGENT_QA_AGENT_LOCAL_PACKAGE_DIR = 'packages/agent-local'
export const AGENT_QA_AGENT_LOCAL_PACKAGE_CLASSES = ['storageImplementation'] as const
// the conversation responsibility is struck from the line
// below. D-06 deleted those methods from the neutral port and chat's state of record is the
// session log, so the claim named a responsibility with no port to reach — and, worse, was
// the written justification a later refactor would have cited for unifying chat into the
// agent job queue.
// the composition responsibilities below are new, and the
// package's name understates it now — this is the local host's composition root as well as its
// store. The two run-composition lines say what the composition may assemble; they do not license
// deciding anything, which is why the forbidden set keeps its planning and curation entries intact.
export const AGENT_QA_AGENT_LOCAL_ALLOWED_RESPONSIBILITIES = [
  'local agent persistence-store implementation for jobs, checkpoints, approvals, and patches',
  'filesystem access for local agent persistence stores',
  'sqlite access for local agent persistence stores',
  'host-neutral run composition: assembling injected adapters, models and ports into a runnable run config',
  'run-scoped knowledge serving composition: budget derivation and read-only reader binding',
  'marks ledger persistence beside each recorded run',
] as const
// 'platform-adapter execution' was too blunt to survive the
// dissection honestly. The composition builds handler closures that DELEGATE to an adapter it was
// handed — wiring a driver, never being one — so the claim is narrowed to owning an implementation,
// which stays forbidden. Provider invocation is untouched: model handles arrive already
// constructed and no model is created here.
export const AGENT_QA_AGENT_LOCAL_FORBIDDEN_RESPONSIBILITIES = [
  'provider invocation ownership',
  'platform-adapter implementation',
  'agent decision or planning logic',
  'knowledge curation semantics',
] as const
// zod validates the marks ledger's intent and lock-owner files.
export const AGENT_QA_AGENT_LOCAL_EXTERNAL_DEPENDENCIES = ['zod'] as const
// `schema` joins the internal set. The agent job store
// persists and re-reads `Job` rows, and it parses each row back through the shipped
// `jobSchema` at the boundary rather than casting — an opaque payload column and a row a
// second process may have written are exactly the inputs that should be validated, not
// assumed. Both entries are workspace-internal links, so the external set stays empty and
// the zero-new-runtime-dependency commitment is unaffected.
// the seven entries below arrive with the dissected run
// composition — the loop config it assembles, the local run adapters and compressor it constructs,
// the masking/audit/hook pipeline it wires, the token ceilings it sizes budgets against, the
// read-only knowledge reader it binds, and the accessibility check it loads on demand. Every one is
// a workspace link, so the external set stays empty and nothing was installed.
//
// This edge set is the honest cost of one composition root, and it is scoped rather than merely
// declared: the arch rule named composition-carveout confines all seven to the composition subtree,
// so a store file that reaches for any of them fails the build with the rationale attached. Reading
// this list as licence for the store to use them is precisely the misreading that rule forecloses.
export const AGENT_QA_AGENT_LOCAL_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-agent',
  '@vostride/agent-qa-knowledge-local',
  '@vostride/agent-qa-model',
  '@vostride/agent-qa-runner',
  '@vostride/agent-qa-runner-local',
  '@vostride/agent-qa-safety',
  '@vostride/agent-qa-safety-local',
  '@vostride/agent-qa-schema',
  '@vostride/agent-qa-web',
] as const

export const AGENT_QA_AGENT_LOCAL_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_AGENT_LOCAL_PACKAGE_NAME,
  packageDir: AGENT_QA_AGENT_LOCAL_PACKAGE_DIR,
  packageClasses: AGENT_QA_AGENT_LOCAL_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_AGENT_LOCAL_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_AGENT_LOCAL_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_AGENT_LOCAL_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_AGENT_LOCAL_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
