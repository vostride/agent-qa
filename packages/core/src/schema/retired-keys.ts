import { z } from 'zod'

// Refusals for removed config keys. This scan is a zod pipe PRE-stage in front of the strict root
// schema — a superRefine chained after .strict() never runs when strict rejects a value (verified
// on zod 4.6.7), so these messages must fire first. The scan only ADDS issues; the strict stage-B
// parse remains the acceptance authority. Every issue carries params.retired. Keys removed in v2
// also carry params.hardCut, so the CLI closes the error with the hard-cut steps; any other removed
// key closes with the ordinary key fix.
const RETIRED_MEMORY_KEY_MESSAGES: Record<string, string> = {
  dir: 'services.memory.dir was removed in v2 — use knowledge.dir (default agent-qa-knowledge)',
  enabled: 'services.memory.enabled was removed in v2 — memory is always on; delete this key (no disable switch)',
  provider: 'services.memory.provider was removed in v2 — internalized — delete this key',
  minTrust: 'services.memory.minTrust was removed in v2 — internalized — delete this key',
  maxInjections: 'services.memory.maxInjections was removed in v2 — internalized — delete this key',
  curatorEnabled: 'services.memory.curatorEnabled was removed in v2 — internalized — delete this key',
  curatorLockTimeout: 'services.memory.curatorLockTimeout was removed in v2 — internalized — delete this key',
  trustConfirmDelta: 'services.memory.trustConfirmDelta was removed in v2 — internalized — delete this key',
  trustContradictDelta: 'services.memory.trustContradictDelta was removed in v2 — internalized — delete this key',
  ablationEnabled: 'services.memory.ablationEnabled was removed — no ablation exists',
  circuitBreakerEnabled: 'services.memory.circuitBreakerEnabled was removed — no circuit breaker exists',
  circuitBreakerWindowSize: 'services.memory.circuitBreakerWindowSize was removed — no circuit breaker exists',
  circuitBreakerBaselineSize: 'services.memory.circuitBreakerBaselineSize was removed — no circuit breaker exists',
  circuitBreakerThreshold: 'services.memory.circuitBreakerThreshold was removed — no circuit breaker exists',
}

const RETIRED_EVAL_KEY_MESSAGES: Record<string, string> = {
  gate1: 'eval.gate1 was removed: memory is no longer screened by replay before promotion. Delete this block.',
  gate2: 'eval.gate2 was removed: completed runs no longer replay served memory. Delete this block.',
  adversarial: 'eval.adversarial was removed: runs no longer stage adversarial probes. Delete this block.',
  seeding: 'eval.seeding was removed: runs no longer seed an eval corpus. Delete this block.',
  judge: 'eval.judge was removed: pass --judge <name> to agent-qa eval replay. Delete this key.',
  judges: 'eval.judges was removed: repeat --judge <name> on agent-qa eval replay. Delete this key.',
  judgeAllowSameFamily:
    'eval.judgeAllowSameFamily was removed: pass --judge-allow-same-family to agent-qa eval replay. Delete this key.',
  k: 'eval.k was removed: pass --k <n> to agent-qa eval replay. Delete this key.',
  seed: 'eval.seed was removed: pass --seed <n> to agent-qa eval replay. Delete this key.',
}

const RETIRED_EVAL_BLOCK_MESSAGE =
  'eval was removed: agent-qa eval replay takes its settings as flags. Delete this block.'

// The old refilling planner key is cut with no alias, migration or fallback. The same message
// fires for the project config and for test and suite `use` overrides.
export const RETIRED_MAX_SUB_ACTIONS_MESSAGE =
  'use.planner.maxSubActions was removed in v2 — it was a refilling iteration count; set use.planner.maxActions (default 30) and use.planner.maxPlanningTurns (default 30)'

const RETIRED_PLANNER_KEY = 'maxSubActions'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasRetiredPlannerKey(use: unknown): boolean {
  return isPlainObject(use) && isPlainObject(use.planner) && Object.hasOwn(use.planner, RETIRED_PLANNER_KEY)
}

export const retiredKeyScan = z.any().superRefine((value, ctx) => {
  if (!isPlainObject(value)) return

  if (isPlainObject(value.services) && value.services.memory !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { retired: true, hardCut: true },
      path: ['services', 'memory'],
      message: 'services.memory was removed in v2 — the memory config surface collapsed into the top-level knowledge block',
    })
    const memory = value.services.memory
    if (isPlainObject(memory)) {
      for (const key of Object.keys(memory)) {
        const message = RETIRED_MEMORY_KEY_MESSAGES[key]
        if (message) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            params: { retired: true, hardCut: true },
            path: ['services', 'memory', key],
            message,
          })
        }
      }
    }
  }

  if (isPlainObject(value.workspace) && value.workspace.agentRules !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { retired: true, hardCut: true },
      path: ['workspace', 'agentRules'],
      message: 'workspace.agentRules was removed in v2 — rules dissolve into agent-qa-knowledge/policies/<scope>.md files',
    })
  }

  if (Object.hasOwn(value, 'eval')) {
    let named = 0
    if (isPlainObject(value.eval)) {
      for (const key of Object.keys(value.eval)) {
        if (Object.hasOwn(RETIRED_EVAL_KEY_MESSAGES, key)) {
          named++
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            params: { retired: true },
            path: ['eval', key],
            message: RETIRED_EVAL_KEY_MESSAGES[key],
          })
        }
      }
    }
    if (named === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { retired: true },
        path: ['eval'],
        message: RETIRED_EVAL_BLOCK_MESSAGE,
      })
    }
  }

  if (hasRetiredPlannerKey(value.use)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { retired: true, hardCut: true },
      path: ['use', 'planner', RETIRED_PLANNER_KEY],
      message: RETIRED_MAX_SUB_ACTIONS_MESSAGE,
    })
  }
})

// The pre-stage for a test or suite `use` override, for the same strict-parse reason as above.
export const retiredUseKeyScan = z.any().superRefine((value, ctx) => {
  if (hasRetiredPlannerKey(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      params: { retired: true, hardCut: true },
      path: ['planner', RETIRED_PLANNER_KEY],
      message: RETIRED_MAX_SUB_ACTIONS_MESSAGE,
    })
  }
})
