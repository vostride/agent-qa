// The clause verdicts for the config answers — one union, one fold each.
//
// the config ops answer `ConfigChangeOutput`, what they wrote in the call,
// and fold through `classifyConfigChangeOutput`. 2026-10-01, 432-17 D-05/D-09: `config.undo.propose`
// and the `ConfigProposeOutput` union it alone still answered are deleted, and its fold with them.
//
// THE CONFIG OPS SHARE ONE FOLD, because six copies of one mapping is the drift this project refuses
// everywhere else it has a shared vocabulary: a later edit that taught `config.target.create` to
// report a guardrail block as `refused` and left `config.auth.set` reporting `executed` would be a
// security control that works on some doors. The arms belong to `ConfigChangeOutputSchema`, so the
// fold over them belongs beside it too — not inside whichever op happened to need it first.
//
// IT READS DISCRIMINANTS AND THE ARM'S OWN NAMED REASON, AND NOTHING ELSE. D-01 rejected chat-side
// value-pattern matching by name — "a rule that can only refuse what it can NAME cannot be driven to
// zero by naming more things" — and a fold that sniffed strings out of a payload would be that same
// door-enumeration failure moved one file over. `refusal-classifiers.test.ts` scans this file's
// executable text for every value-inspecting operator and requires none.
//
// IT DECIDES NOTHING. The op has run (no gate and no execution-audit row since 432-13/432-19). This
// is the REPORT, and its only job is to stop the report saying `executed` over a refusal.

import type { ConfigChangeOutput } from '@vostride/agent-qa-schema'

import type { ClauseVerdict } from '../spec.js'

/**
 * Fold one `ConfigChangeOutput` into the verdict its own arm states.
 *
 * `applied` and `no-change` are `executed`: the file holds the change. `blocked` and `refused` are
 * `refused`, with their own reason, and nothing was written. `interrupted` is `failed`: some files
 * hold the change and one did not, so success is the one thing this report must not say.
 */
export function classifyConfigChangeOutput(output: ConfigChangeOutput): ClauseVerdict {
  switch (output.outcome) {
    case 'applied':
      return { status: 'executed', outcome: `applied: ${output.files.join(', ')}` }
    case 'no-change':
      return { status: 'executed', outcome: `no change: ${output.path} already holds that value` }
    case 'blocked':
      return { status: 'refused', outcome: output.blockedReason }
    case 'refused':
      return { status: 'refused', outcome: output.reason }
    case 'interrupted':
      return { status: 'failed', outcome: `interrupted at ${output.failed.path}: ${output.failed.reason}` }
  }
}
