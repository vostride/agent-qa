// The eval-local JudgePort binding. The pure eval-core judge
// module builds every prompt; this binding ONLY transports: one createModel handle (the pinned-last
// mask/guardrail middleware stack — the sole egress path, exactly like runCassetteReplay's planner
// leg) executes one generateText + Output.object structured verdict per order-tagged request at
// temperature 0 with maxRetries 0. Structured-output repair is the model package's middleware job
// (repair + extract-json in createModel's stack) — no second application-level retry loop exists
// here. The port NEVER throws: unparseable output and provider failure each mint a
// typed call-error. Invoked only from runCassetteReplay's flow (the ownership
// contract's forbidden provider-invocation clause); 370-07 composes it inside the safety scope.

import { NoObjectGeneratedError, NoOutputGeneratedError, Output, generateText } from 'ai'
import type { SystemModelMessage } from 'ai'
import { z } from 'zod'

import type {
  JudgePanelPort,
  JudgeCallResult,
  JudgePort,
  JudgeTokenUsage,
} from '@vostride/agent-qa-eval'
import { createPanelIdentity } from '@vostride/agent-qa-eval'
import { createModel } from '@vostride/agent-qa-model'
import type {
  ModelCallObservation,
  ModelProfile,
  ModelProviderOverrides,
  ResolvedModelAuth,
} from '@vostride/agent-qa-model'
import type { MaskFn } from '@vostride/agent-qa-schema'

export interface JudgeBindingInput {
  /** The judge model profile — a SECOND profile, never the replay planner's (D-12 disjointness). */
  profile: ModelProfile
  /** Resolved provider auth for the judge model. */
  auth: ResolvedModelAuth
  /** Optional provider overrides — the captured-boundary stub seam for tests (createModel passthrough). */
  modelOverrides?: ModelProviderOverrides
  modelCallObservation?: ModelCallObservation
  mask: MaskFn
}

/** N existing bindings in declaration order, each retaining bindJudgePort's fresh copy. */
export function bindJudgePanel(inputs: readonly JudgeBindingInput[]): JudgePanelPort {
  return { judgeModelId: createPanelIdentity(inputs.map(input => input.profile.model)).judgeModelId,
    members: inputs.map(bindJudgePort) }
}

// The closed D-09 verdict schema: forced explicit-unsure vocabulary + categorical confidence.
// Output.object validates against it inside generateText; the safeParse below re-checks the
// resolved output defensively (never trust free text — the verifier's D-06 posture).
const verdictSchema = z.object({
  verdict: z.enum(['equivalent', 'different', 'unsure']),
  confidence: z.enum(['high', 'medium', 'low']),
  rationale: z.string(),
})

const verdictOutput = Output.object({
  schema: verdictSchema,
  name: 'judge_verdict',
  description: 'Equivalence verdict, confidence category, and rationale for the judged pair',
})

/**
 * Bind the tier-4 JudgePort over the production createModel recipe: a fresh ModelProfile copy
 * (createModel mutates `profile.capabilities` — RESEARCH Pitfall 8), ONE handle built at bind
 * time and shared across calls, model identity from the caller profile only.
 */
export function bindJudgePort(input: JudgeBindingInput): JudgePort {
  const profileCopy: ModelProfile = {
    ...input.profile,
    ...(input.profile.capabilities !== undefined
      ? { capabilities: { ...input.profile.capabilities } }
      : {}),
  }
  // The ONLY createModel call site for the judge leg and its ONLY egress path.
  const model = createModel(profileCopy, input.auth, input.mask, input.modelOverrides ?? {}, input.modelCallObservation)

  return {
    judgeModelId: input.profile.model,
    async call(request): Promise<JudgeCallResult> {
      try {
        // The judge's byte-stable system tier arrives pre-built from JUDGE_CONFIG — it forms its
        // own cache identity, so the single Anthropic ephemeral breakpoint rides it exactly as
        // the verifier's stable tier does (a transparent no-op on other providers).
        const system: SystemModelMessage[] = [
          {
            role: 'system',
            content: request.system,
            providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
          },
        ]
        // temperature 0 through the same mechanism the replay planner rides: passed on the call,
        // stripped by stripUnsupportedParamsMiddleware inside createModel's stack for providers
        // that reject the setting. The prompt is transported verbatim (D-15: templates stay
        // hash-covered pure-side — the binding never assembles or edits prompt content).
        const result = await generateText({
          model,
          maxRetries: 0,
          temperature: 0,
          output: verdictOutput,
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
        })
        const parsed = verdictSchema.safeParse(result.output)
        if (!parsed.success) {
          return {
            kind: 'call-error',
            reason: 'unparseable-output',
            detail: 'judge output failed the closed verdict schema',
          }
        }
        const usage: JudgeTokenUsage = {
          calls: 1,
          // Typed-absent token fields: omit what the provider did not report, never zero-fill.
          ...(result.usage.inputTokens !== undefined
            ? { inputTokens: result.usage.inputTokens }
            : {}),
          ...(result.usage.outputTokens !== undefined
            ? { outputTokens: result.usage.outputTokens }
            : {}),
        }
        return {
          kind: 'verdict',
          verdict: parsed.data.verdict,
          confidence: parsed.data.confidence,
          rationale: parsed.data.rationale,
          usage,
        }
      } catch (error: unknown) {
        // generateText parses Output.object EAGERLY: text that is not valid verdict JSON (after
        // the middleware's extract/repair pass) throws NoObjectGeneratedError from the call
        // itself, and a non-stop finish surfaces as NoOutputGeneratedError at output resolution.
        // Both are the model failing to produce a verdict — unparseable-output, not infra.
        if (NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error)) {
          return {
            kind: 'call-error',
            reason: 'unparseable-output',
            detail: 'judge output failed the closed verdict schema',
          }
        }
        return {
          kind: 'call-error',
          reason: 'provider-error',
          detail: 'judge provider call failed',
        }
      }
    },
  }
}
