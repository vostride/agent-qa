// Transport only: one `createModel` handle, temperature 0, no retries, and it never throws.

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
  // A second profile, never the replay planner's, so judge and planner families differ.
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

// `Output.object` validates inside `generateText`; the `safeParse` below re-checks defensively.
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

// A fresh profile copy, because `createModel` mutates `profile.capabilities`; one shared handle.
export function bindJudgePort(input: JudgeBindingInput): JudgePort {
  const profileCopy: ModelProfile = {
    ...input.profile,
    ...(input.profile.capabilities !== undefined
      ? { capabilities: { ...input.profile.capabilities } }
      : {}),
  }
  // The judge leg's only `createModel` call and only egress path.
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
        // Temperature 0 rides the call; `stripUnsupportedParamsMiddleware` drops it where rejected.
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
