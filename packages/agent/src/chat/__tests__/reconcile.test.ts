// Count and binding are asserted apart, so the right op run with the model's arguments still fails.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { deterministicOverrideStrategy } from '../reconcile.js'
import { readBackPlan } from '../planner-stage.js'
import { ANSWER_ONLY_INPUT_SCHEMA } from '../planner-tools.js'
import type {
  ChatClause,
  PlannerStageOutcome,
  ReconcileInput,
  ReconcileVerdict,
  ResolvedClause,
} from '../ports.js'
import {
  ANSWER_ONLY_TOOL_NAME,
  MARK_UNHANDLED_TOOL_NAME,
  toToolName,
} from '../tool-names.js'

const RUNS_START = 'runs.start'
const RUNS_DIGEST = 'runs.digest'
const PROPOSALS_LIST = 'proposals.list'

function clause(text: string, index: number): ChatClause {
  return { text, index }
}

function mappedTo(target: ChatClause, functionId: string, args: unknown): ResolvedClause {
  return { clause: target, functionId, args }
}

function planned(outcome: Partial<PlannerStageOutcome> = {}): PlannerStageOutcome {
  return { toolCalls: [], ...outcome }
}

function inputOf(
  clauses: readonly ChatClause[],
  mapped: readonly ResolvedClause[],
  outcome: PlannerStageOutcome = planned(),
): ReconcileInput {
  return { clauses, mapped, planned: outcome }
}

describe('deterministicOverrideStrategy: the table wins, and an unroutable clause costs the turn', () => {
  describe('the override wins on the action set AND on the bound arguments', () => {
    // ONE input, TWO tests. The model plans a THIRD action and mis-binds the first; the two
    // failures a broken override produces (an extra action; the model's argument) are different
    // defects, so they get different tests over the same fixture.
    const first = clause('run test 42', 0)
    const second = clause('show me the digest', 1)
    const mapperArgs = { testId: 'TST-42' }
    const contested = inputOf(
      [first, second],
      [mappedTo(first, RUNS_START, mapperArgs), mappedTo(second, RUNS_DIGEST, {})],
      planned({
        toolCalls: [
          // The model's version of a clause the table already proved: wrong target argument.
          { toolName: toToolName(RUNS_START), input: { testId: 'TST-999' } },
          { toolName: toToolName(RUNS_DIGEST), input: {} },
          // And one more action nobody asked for.
          { toolName: toToolName(PROPOSALS_LIST), input: {} },
        ],
      }),
    )

    it('binds the mapper arguments, never the model ones', () => {
      const verdict = deterministicOverrideStrategy(contested)

      expect(verdict.kind).toBe('execute')
      if (verdict.kind !== 'execute') return
      expect(verdict.plan[0]?.functionId).toBe(RUNS_START)
      // The binding claim, alone: the identical object the table produced, not a look-alike.
      expect(verdict.plan[0]?.args).toEqual(mapperArgs)
      expect(JSON.stringify(verdict.plan)).not.toContain('TST-999')
    })

    it('executes exactly the table\'s action set — the model\'s extra call is discarded', () => {
      const verdict = deterministicOverrideStrategy(contested)

      expect(verdict.kind).toBe('execute')
      if (verdict.kind !== 'execute') return
      expect(verdict.plan).toHaveLength(2)
      expect(verdict.plan.map((action) => action.functionId)).toEqual([RUNS_START, RUNS_DIGEST])
      expect(verdict.plan.map((action) => action.functionId)).not.toContain(PROPOSALS_LIST)
    })

    it('marks both table-bound actions as resolver-produced, so the engine mints human', () => {
      const verdict = deterministicOverrideStrategy(contested)

      expect(verdict.kind).toBe('execute')
      if (verdict.kind !== 'execute') return
      expect(verdict.plan.map((action) => action.source)).toEqual(['resolver', 'resolver'])
    })
  })

  describe('utterance order and the mixed merge', () => {
    it('keeps clauses in utterance order even when the model answered out of order', () => {
      const first = clause('run test 42', 0)
      const second = clause('show me the digest', 1)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [first, second],
          // The mapper set is deliberately supplied BACKWARDS: order comes from the clauses.
          [mappedTo(second, RUNS_DIGEST, {}), mappedTo(first, RUNS_START, { testId: 'TST-42' })],
        ),
      )

      expect(verdict.kind).toBe('execute')
      if (verdict.kind !== 'execute') return
      expect(verdict.plan.map((action) => action.clause.text)).toEqual([
        'run test 42',
        'show me the digest',
      ])
    })

    it('aligns a non-table clause to the model action call in its position', () => {
      const first = clause('proposals', 0)
      const second = clause('summarise the last failure', 1)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [first, second],
          [mappedTo(first, PROPOSALS_LIST, {})],
          planned({ toolCalls: [{ toolName: toToolName(RUNS_DIGEST), input: { limit: 1 } }] }),
        ),
      )

      expect(verdict.kind).toBe('execute')
      if (verdict.kind !== 'execute') return
      expect(verdict.plan).toHaveLength(2)
      expect(verdict.plan[1]).toMatchObject({
        functionId: RUNS_DIGEST,
        args: { limit: 1 },
        source: 'planner',
      })
      expect(verdict.plan[1]?.clause.text).toBe('summarise the last failure')
    })

    it('aligns several non-table clauses to the model calls in the order they arrived', () => {
      const first = clause('summarise the last failure', 0)
      const second = clause('list what is quarantined', 1)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [first, second],
          [],
          planned({
            toolCalls: [
              { toolName: toToolName(RUNS_DIGEST), input: {} },
              { toolName: toToolName(PROPOSALS_LIST), input: {} },
            ],
          }),
        ),
      )

      expect(verdict.kind).toBe('execute')
      if (verdict.kind !== 'execute') return
      expect(verdict.plan.map((action) => [action.clause.index, action.functionId])).toEqual([
        [0, RUNS_DIGEST],
        [1, PROPOSALS_LIST],
      ])
      expect(verdict.plan.map((action) => action.source)).toEqual(['planner', 'planner'])
    })

    it('never reverses a meta-tool name into a function id', () => {
      const only = clause('what can you do', 0)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [only],
          [],
          planned({
            toolCalls: [
              {
                toolName: ANSWER_ONLY_TOOL_NAME,
                input: { clause: 'what can you do', text: 'quite a lot' },
              },
            ],
          }),
        ),
      )

      // `fromToolName` THROWS on the two orchestration names by design, so a merge that reversed
      // every call without checking would crash here rather than fail an assertion.
      expect(verdict.kind).toBe('execute')
      if (verdict.kind !== 'execute') return
      expect(verdict.plan).toHaveLength(0)
      expect(verdict.answer).toBe('quite a lot')
    })

    it('runs the same path on a single-clause turn', () => {
      const only = clause('proposals', 0)
      const verdict = deterministicOverrideStrategy(
        inputOf([only], [mappedTo(only, PROPOSALS_LIST, {})]),
      )

      expect(verdict.kind).toBe('execute')
      if (verdict.kind !== 'execute') return
      expect(verdict.plan).toEqual([
        { clause: only, functionId: PROPOSALS_LIST, args: {}, source: 'resolver' },
      ])
    })
  })

  describe('the two fail-closed arms', () => {
    it('refuses the whole turn when a clause is unmapped and unplanned, naming it', () => {
      const first = clause('proposals', 0)
      const second = clause('write a test for two factor auth', 1)
      const verdict = deterministicOverrideStrategy(
        inputOf([first, second], [mappedTo(first, PROPOSALS_LIST, {})]),
      )

      expect(verdict.kind).toBe('unhandled')
      if (verdict.kind !== 'unhandled') return
      expect(verdict.clause.text).toBe('write a test for two factor auth')
      expect(verdict.reason).toContain('write a test for two factor auth')
    })

    it('refuses the whole turn on mark_unhandled, even when every clause resolved', () => {
      const first = clause('proposals', 0)
      const second = clause('write a test for two factor auth', 1)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [first, second],
          [mappedTo(first, PROPOSALS_LIST, {}), mappedTo(second, RUNS_DIGEST, {})],
          planned({
            toolCalls: [
              {
                toolName: MARK_UNHANDLED_TOOL_NAME,
                input: {
                  clause: 'write a test for two factor auth',
                  reason: 'no authoring capability has shipped.',
                },
              },
            ],
          }),
        ),
      )

      expect(verdict.kind).toBe('unhandled')
      if (verdict.kind !== 'unhandled') return
      expect(verdict.clause.text).toBe('write a test for two factor auth')
      expect(verdict.reason).toContain('no authoring capability has shipped.')
    })

    it('ATTRIBUTES the model tail rather than asserting it as a fact about this build', () => {
      const invented =
        'A test-authoring capability is available, but it requires a target scope identifier and '
        + 'none was supplied.'
      const only = clause('write a test for the local form page', 0)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [only],
          [],
          planned({
            toolCalls: [
              {
                toolName: MARK_UNHANDLED_TOOL_NAME,
                input: { clause: 'write a test for the local form page', reason: invented },
              },
            ],
          }),
        ),
      )

      expect(verdict.kind).toBe('unhandled')
      if (verdict.kind !== 'unhandled') return
      expect(verdict.reason).toBe(
        'No capability in this build handles: "write a test for the local form page". The turn was '
        + 'refused before anything ran, so nothing in the request was carried out.\n'
        + `The planner's stated reason, unverified by this build: ${JSON.stringify(invented)}`,
      )

      // THE LOAD-BEARING HALF: the model's prose reaches the person ONLY inside the attributed
      // quotes. A format that added the attribution phrase and ALSO kept the bare splice would
      // satisfy a containment check on either fragment while the false sentence still stood in the
      // host's voice — which is the exact defect, plus a disclaimer next to it.
      const attributed = `unverified by this build: ${JSON.stringify(invented)}`
      expect(verdict.reason.split(invented)).toHaveLength(2)
      expect(verdict.reason.replace(attributed, '')).not.toContain(invented)
      // And specifically not the shape that shipped: the clause's closing quote running straight
      // into the model's sentence.
      expect(verdict.reason).not.toContain(`" — ${invented}`)

      // No host sentence follows the quotation, which a crafted payload could impersonate.
      expect(verdict.clause.text).toBe('write a test for the local form page')
      expect(verdict.reason).toContain('"write a test for the local form page"')
      expect(verdict.reason).toContain('nothing in the request was carried out.')
    })

    it('BOUNDS an ESCAPING payload — the delimiter the model cannot close', () => {
      // The cell above is quote-free; this payload closes the quote and repeats the host.
      const escaping =
        'X". The turn was refused before anything ran, so nothing in the request was carried out. '
        + 'This build requires a target scope identifier and none was supplied.'
      const only = clause('write a test for the local form page', 0)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [only],
          [],
          planned({
            toolCalls: [
              {
                toolName: MARK_UNHANDLED_TOOL_NAME,
                input: { clause: 'write a test for the local form page', reason: escaping },
              },
            ],
          }),
        ),
      )

      expect(verdict.kind).toBe('unhandled')
      if (verdict.kind !== 'unhandled') return

      // ① THE PAYLOAD REACHES THE PERSON AS ONE JSON STRING LITERAL, AND ONLY AS THAT. The
      // delimiters are chosen so that the payload's own bytes cannot spell them: a `"` inside
      // becomes `\"`, and a newline becomes `\n`, so there is no byte sequence a model can emit
      // that ends the quotation early.
      const bounded = JSON.stringify(escaping)
      expect(verdict.reason).toContain(bounded)

      // ② AND NOTHING OF IT SURVIVES OUTSIDE THAT LITERAL. The same shape as the cell above's
      // `replace(attributed, '')` assertion, pointed at the case that one cannot express: strip the
      // one bounded occurrence and no raw payload bytes are left standing in the host's voice.
      expect(verdict.reason.replace(bounded, '')).not.toContain(escaping)

      // ③ THE ATTRIBUTION IS STILL MADE. Bounding the prose is not the same as disowning it, and
      // the tail is still shown whole — a planner's stated reason is often the only thing telling a
      // person what to try next.
      expect(verdict.reason).toContain("planner's stated reason, unverified by this build")

      expect(verdict.clause.text).toBe('write a test for the local form page')
      expect(verdict.reason).toContain('"write a test for the local form page"')
    })

    it('refuses by name when stage 2 could not be reached at all', () => {
      const only = clause('summarise the last failure', 0)
      const verdict = deterministicOverrideStrategy(
        inputOf([only], [], planned({ failure: { name: 'AuthenticationError', message: '401' } })),
      )

      expect(verdict.kind).toBe('unhandled')
      if (verdict.kind !== 'unhandled') return
      expect(verdict.reason).toContain('AuthenticationError')
      expect(verdict.reason).toContain('summarise the last failure')
    })

    it('answers rather than refusing when the model answered a clause it could not act on', () => {
      const first = clause('proposals', 0)
      const second = clause('what is a flake', 1)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [first, second],
          [mappedTo(first, PROPOSALS_LIST, {})],
          planned({
            toolCalls: [
              {
                toolName: ANSWER_ONLY_TOOL_NAME,
                input: { clause: 'what is a flake', text: 'a test that…' },
              },
            ],
          }),
        ),
      )

      expect(verdict.kind).toBe('execute')
      if (verdict.kind !== 'execute') return
      expect(verdict.plan).toHaveLength(1)
      expect(verdict.answer).toBe('a test that…')
    })
  })

  // Verdict kind, not plan length, separates a silent drop from an answered question.
  describe('answer_only consumes the clause it NAMES, and no other', () => {
    it('refuses when an unbound ACTION clause was never named, however well the other was answered', () => {
      // Clause 1 is table-bound, clause 2 an unroutable action, and the model answered clause 1.
      const first = clause('run test 42', 0)
      const second = clause('delete the knowledge root', 1)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [first, second],
          [mappedTo(first, RUNS_START, { testId: 'TST-42' })],
          planned({
            toolCalls: [
              {
                toolName: ANSWER_ONLY_TOOL_NAME,
                input: { clause: 'run test 42', text: 'test 42 is the checkout smoke.' },
              },
            ],
          }),
        ),
      )

      expect(verdict.kind).toBe('unhandled')
      if (verdict.kind !== 'unhandled') return
      expect(verdict.clause.text).toBe('delete the knowledge root')
      expect(verdict.reason).toContain('delete the knowledge root')
    })

    it('covers nothing when the clause claim matches no splitter output (guard rejection)', () => {
      // The asymmetry this file's helper records, asserted: `modelMarkedUnhandled` may fall back to
      // "the first unmapped clause" because refusing MORE is fail-safe, and an answer claim may not,
      // because completing more is fail-dangerous. A claim nobody typed covers nothing at all.
      const only = clause('delete the knowledge root', 0)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [only],
          [],
          planned({
            toolCalls: [
              {
                toolName: ANSWER_ONLY_TOOL_NAME,
                input: { clause: 'a clause nobody typed', text: 'done!' },
              },
            ],
          }),
        ),
      )

      expect(verdict.kind).toBe('unhandled')
      if (verdict.kind !== 'unhandled') return
      expect(verdict.clause.text).toBe('delete the knowledge root')
    })

    it('covers the clause whose text it quotes verbatim, executing nothing for it', () => {
      const only = clause('what is a flake', 0)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [only],
          [],
          planned({
            toolCalls: [
              {
                toolName: ANSWER_ONLY_TOOL_NAME,
                input: { clause: 'what is a flake', text: 'a test that…' },
              },
            ],
          }),
        ),
      )

      expect(verdict.kind).toBe('execute')
      if (verdict.kind !== 'execute') return
      expect(verdict.plan).toHaveLength(0)
      expect(verdict.answer).toBe('a test that…')
    })

    it('mixes a table-bound clause with an explicitly answered one', () => {
      const first = clause('proposals', 0)
      const second = clause('what is a flake', 1)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [first, second],
          [mappedTo(first, PROPOSALS_LIST, {})],
          planned({
            toolCalls: [
              {
                toolName: ANSWER_ONLY_TOOL_NAME,
                input: { clause: 'what is a flake', text: 'a test that…' },
              },
            ],
          }),
        ),
      )

      expect(verdict.kind).toBe('execute')
      if (verdict.kind !== 'execute') return
      expect(verdict.plan).toHaveLength(1)
      expect(verdict.plan[0]?.functionId).toBe(PROPOSALS_LIST)
      expect(verdict.answer).toBe('a test that…')
    })

    it('treats an answer_only with no clause field as covering nothing (old-shape call)', () => {
      // The shape a model that has not read the new contract emits. It is not charitably widened to
      // "the turn" — the whole defect was a turn-level fact standing in for a per-clause one.
      const only = clause('delete the knowledge root', 0)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [only],
          [],
          planned({
            toolCalls: [{ toolName: ANSWER_ONLY_TOOL_NAME, input: { text: 'done!' } }],
          }),
        ),
      )

      expect(verdict.kind).toBe('unhandled')
      if (verdict.kind !== 'unhandled') return
      expect(verdict.clause.text).toBe('delete the knowledge root')
    })

    it('states the contract in the schema: {clause, text} parses, {text} alone is refused', () => {
      // The schema is the half of the fix the MODEL sees. A reconciler that required a clause
      // against a tool whose contract never asked for one would fail closed on every informational
      // turn, so the two halves are asserted together rather than in two files.
      expect(
        ANSWER_ONLY_INPUT_SCHEMA.safeParse({ clause: 'what is a flake', text: 'a test that…' })
          .success,
      ).toBe(true)
      expect(ANSWER_ONLY_INPUT_SCHEMA.safeParse({ text: 'a test that…' }).success).toBe(false)
    })
  })

  // Every `planned` comes from the real `readBackPlan`, so no fixture is unproducible.
  describe('a claim covers a clause only when it NAMES it and SAYS something', () => {
    const fromCalls = (
      calls: readonly { readonly toolName: string; readonly input: unknown }[],
    ): PlannerStageOutcome => readBackPlan(calls)

    it('(a) refuses when the claim naming the unbound ACTION clause carries EMPTY prose', () => {
      // Path (1), byte for byte: `{clause: "delete the knowledge root", text: ""}` is schema-valid
      // and names a clause the person really typed, so the coverage predicate accepted it — and
      // the request to delete a knowledge root stopped being mentioned on a `completed` turn.
      const first = clause('run test 42', 0)
      const second = clause('delete the knowledge root', 1)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [first, second],
          [mappedTo(first, RUNS_START, { testId: 'TST-42' })],
          fromCalls([
            {
              toolName: ANSWER_ONLY_TOOL_NAME,
              input: { clause: 'delete the knowledge root', text: '' },
            },
          ]),
        ),
      )

      expect(verdict.kind).toBe('unhandled')
      if (verdict.kind !== 'unhandled') return
      expect(verdict.clause.text).toBe('delete the knowledge root')
      expect(verdict.reason).toContain('delete the knowledge root')
    })

    it('(a2) refuses when the prose is whitespace only — the reader is stricter than the schema', () => {
      // The reader deliberately does not agree with `min(1)` at the boundary. Both directions of
      // the disagreement were available and only one of them is fail-safe: a reader that accepted
      // `" "` would let one space stand in for an answer, and the person would read nothing.
      const only = clause('delete the knowledge root', 0)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [only],
          [],
          fromCalls([
            {
              toolName: ANSWER_ONLY_TOOL_NAME,
              input: { clause: 'delete the knowledge root', text: '   \n ' },
            },
          ]),
        ),
      )

      expect(verdict.kind).toBe('unhandled')
      if (verdict.kind !== 'unhandled') return
      expect(verdict.clause.text).toBe('delete the knowledge root')
    })

    it('(b) asks coverage BEFORE spending a proposal, so the action binds the UNANSWERED clause', () => {
      // Paths (2) and (3) are ONE misordering seen from two sides. With the coverage question
      // asked after the proposal is taken, clause 1 — the one the model answered — ate the action
      // call, and clause 2 — the one the model actually bound — was refused by name.
      const first = clause('what is a flake', 0)
      const second = clause('summarise the last failure', 1)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [first, second],
          [],
          fromCalls([
            {
              toolName: ANSWER_ONLY_TOOL_NAME,
              input: { clause: 'what is a flake', text: 'PROSE-ONE' },
            },
            { toolName: toToolName(RUNS_DIGEST), input: { limit: 1 } },
          ]),
        ),
      )

      expect(verdict.kind).toBe('execute')
      if (verdict.kind !== 'execute') return
      expect(verdict.plan).toHaveLength(1)
      expect(verdict.plan[0]?.clause.text).toBe('summarise the last failure')
      expect(verdict.plan[0]?.functionId).toBe(RUNS_DIGEST)
      // And the answered clause's prose still reaches the person on the same verdict.
      expect(verdict.answer).toContain('PROSE-ONE')
    })

    it('(c) carries EVERY consumed claim\'s prose, in utterance order', () => {
      // Path (4): keeping only the first call's text answers two clauses with one.
      const first = clause('what is a flake', 0)
      const second = clause('what is a run', 1)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [first, second],
          [],
          fromCalls([
            {
              toolName: ANSWER_ONLY_TOOL_NAME,
              input: { clause: 'what is a flake', text: 'ANSWER-ONE' },
            },
            {
              toolName: ANSWER_ONLY_TOOL_NAME,
              input: { clause: 'what is a run', text: 'ANSWER-TWO' },
            },
          ]),
        ),
      )

      expect(verdict.kind).toBe('execute')
      if (verdict.kind !== 'execute') return
      expect(verdict.plan).toHaveLength(0)
      const answer = verdict.answer ?? ''
      expect(answer).toContain('ANSWER-ONE')
      expect(answer).toContain('ANSWER-TWO')
      // A person reading two answers needs them in the order they asked.
      expect(answer.indexOf('ANSWER-ONE')).toBeLessThan(answer.indexOf('ANSWER-TWO'))
    })

    it('consumes ONE occurrence per claim when the same clause text repeats', () => {
      // The ACCEPT half and the REJECT half of the same guard in one case: occurrence 0 IS covered
      // by the single well-formed claim, and occurrence 1 is NOT. `answered` was a set of clause
      // TEXT while `mapped` was keyed by clause INDEX, so one claim spoke for both.
      const first = clause('run test 42', 0)
      const second = clause('run test 42', 1)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [first, second],
          [],
          fromCalls([
            {
              toolName: ANSWER_ONLY_TOOL_NAME,
              input: { clause: 'run test 42', text: 'test 42 is the checkout smoke.' },
            },
          ]),
        ),
      )

      expect(verdict.kind).toBe('unhandled')
      if (verdict.kind !== 'unhandled') return
      expect(verdict.clause.index).toBe(1)
      expect(verdict.clause.text).toBe('run test 42')
    })

    it('requires prose in the schema the MODEL sees, in the same commit as the reader', () => {
      // The two-sided pin. A reader that required prose against a tool whose contract accepted
      // `""` would leave the model free to emit the one call that erases a clause, and the two
      // halves would be one edit apart forever.
      expect(ANSWER_ONLY_INPUT_SCHEMA.safeParse({ clause: 'x', text: '' }).success).toBe(false)
      expect(ANSWER_ONLY_INPUT_SCHEMA.safeParse({ clause: 'x', text: 'y' }).success).toBe(true)
    })

    it('requires a NAMED clause in the schema too, the last one-sided field pinned', () => {
      expect(ANSWER_ONLY_INPUT_SCHEMA.safeParse({ clause: '', text: 'y' }).success).toBe(false)
    })
  })

  // An action call carries no clause, so a surplus or deficit is refused rather than guessed.
  describe('arity accounting: an unattributable plan is a NAMED refusal, never a positional guess', () => {
    const fromCalls = (
      calls: readonly { readonly toolName: string; readonly input: unknown }[],
    ): PlannerStageOutcome => readBackPlan(calls)

    // One shape, so a failure shows which clause bound to which call, carrying whose arguments.
    const shapeOf = (verdict: ReconcileVerdict): unknown =>
      verdict.kind === 'unhandled'
        ? { kind: 'unhandled', clause: verdict.clause.text }
        : {
            kind: 'execute',
            plan: verdict.plan.map((action) => ({
              clause: action.clause.text,
              functionId: action.functionId,
              args: action.args,
              source: action.source,
            })),
            answer: verdict.answer,
          }

    describe('surplus from a MAPPED clause — the verifier\'s case, verbatim', () => {
      // The model made a call about "run test 42", which the TABLE had already resolved. That call
      // is never removed from `proposed` and the mapped clause never advances the cursor, so the
      // next clause needing a proposal pops it: "summarise the last failure" was executed as
      // `runs.start` with the model's own patterns, on a turn reported `completed`.
      const first = clause('run test 42', 0)
      const second = clause('summarise the last failure', 1)
      const contested = inputOf(
        [first, second],
        [mappedTo(first, RUNS_START, { patterns: ['test 42'] })],
        fromCalls([
          { toolName: toToolName(RUNS_START), input: { patterns: ['tests/everything.spec.ts'] } },
          { toolName: toToolName(RUNS_DIGEST), input: { runId: 'RUN-1' } },
        ]),
      )

      it('(arity) refuses the turn by NAME instead of binding the clause to a call about another', () => {
        expect(shapeOf(deterministicOverrideStrategy(contested))).toEqual({
          kind: 'unhandled',
          clause: 'summarise the last failure',
        })
      })

      it('(sentence) states the count disagreement in the words the person reads', () => {
        // The guard's proof is the sentence, not the comparison existing. A refusal that said only
        // "I could not do that" would make a mis-binding and a fail-closed turn read identically.
        const verdict = deterministicOverrideStrategy(contested)

        expect(verdict.kind).toBe('unhandled')
        if (verdict.kind !== 'unhandled') return
        expect(verdict.reason).toBe(
          'The plan proposed 2 actions for 1 clauses that needed one, so no call could be '
          + 'attributed to "summarise the last failure". The turn was refused before anything ran, '
          + 'so nothing in the request was carried out.',
        )
      })
    })

    describe('surplus with the MIDDLE clause mapped — two clauses mis-bound', () => {
      // A surplus call misbinds clauses before the mapped one too, not only after it.
      const zeroth = clause('run test 42', 0)
      const first = clause('show me the digest', 1)
      const secondClause = clause('list proposals', 2)
      const contested = inputOf(
        [zeroth, first, secondClause],
        [mappedTo(first, RUNS_DIGEST, { runId: 'TABLE' })],
        fromCalls([
          { toolName: toToolName(RUNS_START), input: { testId: 'MODEL-A' } },
          { toolName: toToolName(RUNS_DIGEST), input: { runId: 'MODEL-B' } },
          { toolName: toToolName(PROPOSALS_LIST), input: { from: 'MODEL-C' } },
        ]),
      )

      it('(arity) refuses naming the FIRST clause that needed a proposal', () => {
        expect(shapeOf(deterministicOverrideStrategy(contested))).toEqual({
          kind: 'unhandled',
          clause: 'run test 42',
        })
      })

      it('(binding) carries none of the model\'s arguments into a verdict', () => {
        const verdict = deterministicOverrideStrategy(contested)

        expect(JSON.stringify(verdict)).not.toContain('MODEL-A')
        expect(JSON.stringify(verdict)).not.toContain('MODEL-B')
        expect(JSON.stringify(verdict)).not.toContain('MODEL-C')
      })
    })

    it('refuses a surplus that arises beside an ANSWERED clause', () => {
      // Two action calls for one needy clause: nothing shows which clause the first was about.
      const first = clause('what is a flake', 0)
      const second = clause('summarise the last failure', 1)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [first, second],
          [],
          fromCalls([
            {
              toolName: ANSWER_ONLY_TOOL_NAME,
              input: { clause: 'what is a flake', text: 'PROSE' },
            },
            { toolName: toToolName(RUNS_DIGEST), input: { runId: 'RUN-1' } },
            { toolName: toToolName(PROPOSALS_LIST), input: {} },
          ]),
        ),
      )

      expect(shapeOf(verdict)).toEqual({
        kind: 'unhandled',
        clause: 'summarise the last failure',
      })
    })

    it('refuses a DUPLICATE-call surplus aimed at one clause', () => {
      // Two calls, one clause: binding the first and dropping the second runs a discarded attempt.
      const only = clause('summarise the last failure', 0)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [only],
          [],
          fromCalls([
            { toolName: toToolName(RUNS_DIGEST), input: { runId: 'A' } },
            { toolName: toToolName(RUNS_DIGEST), input: { runId: 'B' } },
          ]),
        ),
      )

      expect(shapeOf(verdict)).toEqual({
        kind: 'unhandled',
        clause: 'summarise the last failure',
      })
    })

    it('discards a leftover WHOLE when no clause needs a proposal', () => {
      // THE ASYMMETRY'S MODEL-FACING HALF, and the reason the accounting is not simply
      // `proposed.length === 0 || refuse`. With zero needy clauses no call can be popped by
      // anybody, so a surplus mis-binds nothing and there is no subject to name a refusal about.
      // The model loses a proposal; nobody loses a request.
      const first = clause('run test 42', 0)
      const second = clause('what is a flake', 1)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [first, second],
          [mappedTo(first, RUNS_START, { patterns: ['test 42'] })],
          fromCalls([
            { toolName: ANSWER_ONLY_TOOL_NAME, input: { clause: 'what is a flake', text: 'PROSE' } },
            { toolName: toToolName(RUNS_DIGEST), input: { runId: 'SPURIOUS' } },
          ]),
        ),
      )

      expect(shapeOf(verdict)).toEqual({
        kind: 'execute',
        plan: [
          {
            clause: 'run test 42',
            functionId: RUNS_START,
            args: { patterns: ['test 42'] },
            source: 'resolver',
          },
        ],
        answer: 'PROSE',
      })
    })

    it('refuses a DEFICIT at the clause the supply exhausts at, sentence unchanged', () => {
      // The mid-mapped deficit — also unmeasured, and here to pin what the accounting must NOT
      // change. The person's half of the asymmetry: a request may never be lost, so every deficit
      // keeps naming the same clause with the same words it has always used.
      const zeroth = clause('summarise the last failure', 0)
      const first = clause('run test 42', 1)
      const secondClause = clause('list proposals', 2)
      const verdict = deterministicOverrideStrategy(
        inputOf(
          [zeroth, first, secondClause],
          [mappedTo(first, RUNS_START, { patterns: ['test 42'] })],
          fromCalls([{ toolName: toToolName(RUNS_DIGEST), input: { runId: 'X' } }]),
        ),
      )

      expect(shapeOf(verdict)).toEqual({ kind: 'unhandled', clause: 'list proposals' })
      if (verdict.kind !== 'unhandled') return
      expect(verdict.reason).toBe(
        'No capability in this build handles: "list proposals". The turn was refused before '
        + 'anything ran, so nothing in the request was carried out.',
      )
    })

    describe('equality beside a mapped clause BINDS', () => {
      const first = clause('run test 42', 0)
      const second = clause('summarise the last failure', 1)
      const digestCall = {
        toolName: toToolName(RUNS_DIGEST),
        input: { runId: 'RUN-1' },
      }

      it('binds the table\'s clause from the table and the needy clause from the model', () => {
        const verdict = deterministicOverrideStrategy(
          inputOf(
            [first, second],
            [mappedTo(first, RUNS_START, { patterns: ['test 42'] })],
            fromCalls([digestCall]),
          ),
        )

        expect(shapeOf(verdict)).toEqual({
          kind: 'execute',
          plan: [
            {
              clause: 'run test 42',
              functionId: RUNS_START,
              args: { patterns: ['test 42'] },
              source: 'resolver',
            },
            {
              clause: 'summarise the last failure',
              functionId: RUNS_DIGEST,
              args: { runId: 'RUN-1' },
              source: 'planner',
            },
          ],
          answer: undefined,
        })
      })

      it('does not let a claim naming the MAPPED clause reduce the count that needs a proposal', () => {
        // The disposition pass may consume a claim only for a clause the TABLE did not bind, and
        // this is where that ordering is observable as arithmetic rather than as a plan shape: if
        // the claim were consumed, the needy count would fall to zero, the equality arm would
        // become the whole-discard arm, and the clause the model DID plan for would stop running.
        const verdict = deterministicOverrideStrategy(
          inputOf(
            [first, second],
            [mappedTo(first, RUNS_START, { patterns: ['test 42'] })],
            fromCalls([
              digestCall,
              { toolName: ANSWER_ONLY_TOOL_NAME, input: { clause: 'run test 42', text: 'PROSE' } },
            ]),
          ),
        )

        expect(shapeOf(verdict)).toEqual({
          kind: 'execute',
          plan: [
            {
              clause: 'run test 42',
              functionId: RUNS_START,
              args: { patterns: ['test 42'] },
              source: 'resolver',
            },
            {
              clause: 'summarise the last failure',
              functionId: RUNS_DIGEST,
              args: { runId: 'RUN-1' },
              source: 'planner',
            },
          ],
          answer: undefined,
        })
      })
    })
  })

  describe('the strategy is pure — which is what makes the differential meaningful', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../reconcile.ts', import.meta.url)),
      'utf8',
    )

    it('acquires nothing but local contract modules', () => {
      const specifiers = [...source.matchAll(/^import[^']*'([^']+)'/gm)].map((match) => match[1])

      expect(specifiers.length).toBeGreaterThan(0)
      for (const specifier of specifiers) {
        expect(specifier?.startsWith('./')).toBe(true)
      }
    })

    it('reads no clock and no environment', () => {
      expect(source).not.toMatch(/Date\.now|new Date|process\.env|Math\.random/)
    })

    it('returns the same verdict for the same input, called twice', () => {
      const only = clause('proposals', 0)
      const request = inputOf([only], [mappedTo(only, PROPOSALS_LIST, {})])

      expect(deterministicOverrideStrategy(request)).toEqual(
        deterministicOverrideStrategy(request),
      )
    })
  })
})
