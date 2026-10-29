// Stage 3's whole contract.
//
// THE OVERRIDE CLAIM IS A DIFFERENTIAL, NOT AN ASSERTION, and this file is written to make that
// structural. "The mapper's verdict beats the model's" is two separate claims — one about the
// ACTION SET (how many, and which) and one about the BOUND ARGUMENTS — and a suite that asserted
// only the first would pass against a reconciler that executed the right op with the model's
// arguments, which is precisely the defect D-12 names ("run test 42" executing TST-999). So the
// count and the binding are asserted apart, against the SAME input, in tests that can fail
// independently.
//
// THE INPUTS ARE BUILT THE WAY THE ENGINE BUILDS THEM. `mapped` carries the table's own bindings
// and `planned` carries raw unexecuted tool calls with `input` typed `unknown` — the exact shapes
// stage 1 and stage 2 hand over. The one thing deliberately NOT reproduced here is the engine's
// choice of which clauses to ask the planner about; that belongs to the engine's suite, and mixing
// it in here would leave both files asserting halves of each other's mechanism.

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
      // The COUNT claim, alone. Every clause is accounted for; what was dropped is a model CALL,
      // not a clause, which is the distinction T-392-25 turns on.
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
      // 394-30's live refusal, verbatim from the session JSONL, and the reason this cell exists.
      // The planner refused an authoring turn with a sentence that IS NOT IN THIS REPO — `grep -rn
      // "requires a target scope identifier" packages/*/src` returns nothing — and the shipping
      // format spliced it bare after an em-dash, immediately behind a clause the HOST composed
      // ("No capability in this build handles: …"). The whole string then read as one host
      // statement, so a person was told this build requires something it does not, in the build's
      // own voice, with nothing in the sentence marking where the host stopped speaking.
      //
      // The host can assert what it can check. It cannot check the planner's prose, and what it
      // CAN check is that the planner said it — so that is the only claim it makes about it.
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
      // The layout MOVED in 394-37 and the wording did not: the host's two claims are made
      // first and the attributed prose closes the message, bounded by `JSON.stringify` rather than
      // by bare quotes the payload can spell. On a quote-free payload like this one the JSON
      // literal is the same bytes plus its own delimiters, which is why this fixture could never
      // tell the two formats apart — the sibling cell below carries the payload that can.
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

      // D-08 still holds — the clause is NAMED — and the atomicity sentence is still there, so the
      // attribution was added to the refusal rather than substituted for its other two duties. It
      // no longer ENDS the message, deliberately: a host sentence after the quotation is a
      // sentence a crafted payload can impersonate by running on into it.
      expect(verdict.clause.text).toBe('write a test for the local form page')
      expect(verdict.reason).toContain('"write a test for the local form page"')
      expect(verdict.reason).toContain('nothing in the request was carried out.')
    })

    it('BOUNDS an ESCAPING payload — the delimiter the model cannot close', () => {
      // WHAT THE CELL ABOVE CANNOT SEE, AND WHY THAT MATTERS. Its `invented` fixture is quote-free,
      // so both of its structural assertions hold for a payload that CLOSES the attribution: the
      // delimiter was `"`, the single most likely character for a planner's prose to contain, and
      // the sentence after it was a fixed constant the model can read in its own tool description.
      //
      // THE PAYLOAD, from the review's own trace. It opens with a fragment, closes the quote, and
      // then repeats the host's closing sentence before making a false claim about this build. On
      // the shipping splice the rendered line read:
      //
      //   … unverified by this build: "X". The turn was refused before anything ran, so nothing in
      //   the request was carried out. This build requires a target scope identifier and none was
      //   supplied.". The turn was refused before anything ran, …
      //
      // — the attributed quote closing after `X`, and the model's invented requirement standing in
      // the host's own voice immediately after the host's own atomicity sentence. That is 394-30's
      // defect exactly, restored through the fix that was supposed to close it.
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

      // ④ AND D-08 STILL HOLDS: the clause the person typed is named, by the host, unquoted-from.
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

  // CR-03, the gap round. An `answer_only` USED TO COVER EVERY UNBOUND CLAUSE, because the
  // merge read `planned.answer` — one model-controlled fact about the WHOLE turn — as consent for
  // each clause it had no binding for. The tests below are written from the dangerous direction: the
  // unbound clause is an ACTION, and the observable that separates a silent drop from an answered
  // question is the VERDICT KIND rather than the plan length. The old suite asserted `plan.length`
  // on a benign informational clause, which is the same number a silent drop produces — which is
  // exactly why the defect survived 284 green tests.
  describe('answer_only consumes the clause it NAMES, and no other', () => {
    it('refuses when an unbound ACTION clause was never named, however well the other was answered', () => {
      // THE VERIFICATION-REQUIRED CASE. Clause 1 is table-bound, clause 2 is an unroutable action,
      // and the model answered clause 1 in prose. Pre-fix this returned `execute` with clause 2
      // erased — no receipt, no `mark_unhandled` row, status `completed`.
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

  // 392-14, the SECOND gap round (392-VERIFICATION round 2, paths (1)-(4)). The CR-03 block above
  // moved WHICH CLAUSE A CLAIM NAMES and left three things unmoved, each of which reproduces the
  // whole defect at a different seam: whether the claim SAYS anything (a schema-valid `text: ""`
  // erased a clause exactly as the turn-level answer used to), WHERE the coverage question sits
  // relative to the proposal consumption (an answered clause ate the next action call, so a bound
  // clause was falsely refused and a tool ran against a clause the model marked answer-only), and
  // whether a claim is consumed BY OCCURRENCE (one claim covered every clause with the same text).
  //
  // EVERY `planned` HERE IS BUILT THROUGH THE REAL `readBackPlan`. A hand-written
  // `PlannerStageOutcome` literal can pin an input the producer cannot emit — this file's own
  // history has fixtures carrying an `answer` field alongside the calls it was projected from —
  // and a corpus of unproducible inputs reddens on mutation while proving nothing about the
  // shipped path (the produced-not-literal corpus law).
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
      // Path (4). The prompt and the tool description were moved to "ONE CALL PER CLAUSE you are
      // answering" while the reader kept the first call's text and threw the rest away: both
      // clauses were accounted for as answered, and the person received one answer.
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
      // Utterance order is meaning here as much as it is in the plan: a person reading two
      // answers to two questions needs them in the order they asked.
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

    it('(S1) requires prose in the schema the MODEL sees, in the same commit as the reader', () => {
      // The two-sided pin. A reader that required prose against a tool whose contract accepted
      // `""` would leave the model free to emit the one call that erases a clause, and the two
      // halves would be one edit apart forever.
      expect(ANSWER_ONLY_INPUT_SCHEMA.safeParse({ clause: 'x', text: '' }).success).toBe(false)
      expect(ANSWER_ONLY_INPUT_SCHEMA.safeParse({ clause: 'x', text: 'y' }).success).toBe(true)
    })

    it('(S1b) requires a NAMED clause in the schema too, the last one-sided field pinned', () => {
      // WR-01. `clause` was left bare `z.string()` in the commit that pinned `text` to `.min(1)`,
      // so the model was shown a contract admitting `clause: ""` against a reader that has always
      // refused it — the same one-sided shape three rounds were spent closing, one field over.
      expect(ANSWER_ONLY_INPUT_SCHEMA.safeParse({ clause: '', text: 'y' }).success).toBe(false)
    })
  })

  // 392-15, the THIRD gap round (392-VERIFICATION round 3, CR-01/CR-01b). The two rounds above each
  // closed exactly the shapes the previous report measured, and the class survived one seam over
  // each time. THIS BLOCK IS AN ENUMERATION RATHER THAN A LIST OF MEASURED SHAPES: the class is "a
  // clause leaves this file bound to something other than what was asked for it", a clause's
  // disposition is exactly one of mapped / answered / needs-a-proposal, and a binding can only go
  // wrong when the model's ACTION-CALL COUNT disagrees with the needs-a-proposal count while at
  // least one clause needs one. So the arrangements are enumerated by that count — surplus (AR-1
  // through AR-4, one row per way a surplus can arise), zero-needy (AR-5), deficit (AR-6) and
  // equality (AR-7) — and three of the seven were arrangements nobody had ever measured.
  //
  // AN ACTION CALL CARRIES NO CLAUSE. That is the whole reason the answer here is a refusal rather
  // than a repair: with two calls for one needy clause, NO observable distinguishes the arrangement
  // where the surplus call was about the mapped clause from the one where it was about the needy
  // one. Attribution is a guess either way, and refusal is the only verdict that is never a guess.
  // The file's asymmetry survives intact — the model may lose a proposal (AR-5), the person may
  // never lose a request (AR-6).
  //
  // EVERY `planned` IS BUILT THROUGH THE REAL `readBackPlan`, for the reason the 392-14 block above
  // states: a hand-written outcome literal can pin an input the producer cannot emit.
  describe('arity accounting: an unattributable plan is a NAMED refusal, never a positional guess', () => {
    const fromCalls = (
      calls: readonly { readonly toolName: string; readonly input: unknown }[],
    ): PlannerStageOutcome => readBackPlan(calls)

    /**
     * The verdict as one comparable shape.
     *
     * Asserted this way rather than as `verdict.kind` alone so a failure SHOWS the mis-binding —
     * which clause was bound to which call, carrying whose arguments — instead of reporting that
     * one string is not another. The pre-fix RED of these cases is the evidence this round is
     * scoped from, so the diff has to be the evidence.
     */
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

    describe('(AR-1) surplus from a MAPPED clause — the verifier\'s case, verbatim', () => {
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

    describe('(AR-2) surplus with the MIDDLE clause mapped — two clauses mis-bound', () => {
      // Worse than AR-1 and for the same reason: the defect is not confined to clauses AFTER the
      // mapped one. Pre-fix, clause 0 took the model's `runs_start` args and clause 2 was bound to
      // `runs.digest` — a request to list proposals executing a digest of a run nobody named.
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
        // The count claim and the binding claim fail independently, so they are asserted apart over
        // the same fixture — the D-12 pair's discipline, applied to the alignment seam.
        const verdict = deterministicOverrideStrategy(contested)

        expect(JSON.stringify(verdict)).not.toContain('MODEL-A')
        expect(JSON.stringify(verdict)).not.toContain('MODEL-B')
        expect(JSON.stringify(verdict)).not.toContain('MODEL-C')
      })
    })

    it('(AR-3) refuses a surplus that arises beside an ANSWERED clause', () => {
      // AN ARRANGEMENT NOBODY MEASURED, and it deliberately FLIPS the round-3 report's E2b probe,
      // which measured `execute` with one step on the unanswered clause. The flip is the rule, not
      // an oversight: with two action calls for one clause that needs a proposal, no observable
      // distinguishes "the first call was about the answered clause" from "the first call was about
      // this one". E2b was passing because the guess happened to be the charitable one.
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

    it('(AR-4) refuses a DUPLICATE-call surplus aimed at one clause', () => {
      // Also unmeasured. Two calls, one clause: pre-fix the first was bound and the second silently
      // vanished, so a model that changed its mind mid-plan had its first attempt executed.
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

    it('(AR-5) discards a leftover WHOLE when no clause needs a proposal', () => {
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

    it('(AR-6) refuses a DEFICIT at the clause the supply exhausts at, sentence unchanged', () => {
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

    describe('(AR-7) equality beside a mapped clause BINDS', () => {
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
