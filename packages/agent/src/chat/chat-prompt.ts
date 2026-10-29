// Chat's tier blocks for the ONE prompt builder (Phase 392 plan 04 — 389 D-04, 392-EXTENDS).
//
// THIS MODULE AUTHORS CONTENT, NEVER ASSEMBLY. `tiered-prompt-builder.ts` owns the tier law and
// the render order; chat passes its own `agent_context` and its own blocks, exactly as
// analyze-run does, and touches nothing about how the three tiers are joined. That parameter is
// the whole mechanism by which six job types share one prompt idiom (spec §1.4: "parameterized,
// not separate personas"), and the way it usually gets lost is not a decision — it is a caller
// who needed one more section and wrote its own assembly instead of one more block.
//
// TIER PLACEMENT IS A CACHE DECISION AS WELL AS A STRUCTURAL ONE. The stable tier is chat's role
// and the invariant planning discipline: identical bytes on every turn of every session, so a
// provider prompt cache sees the same prefix each call. Session facts move per session and lead
// the prompt leg; the conversation and the current utterance move every turn and trail it. Put
// the utterance in the stable tier and the cached prefix is novel on every keystroke — a defect
// that never fails a test and only ever shows up as a bill.
//
// THE INSTRUCTIONS BELOW ARE WHAT CHAT-03's CEILING MEASURES. One action tool call per clause in
// utterance order is what makes the reconciler's order alignment meaningful; `mark_unhandled`
// naming the clause is what makes the fail-closed arm a NAMED refusal rather than an improvisation
// with an adjacent capability; `answer_only` is what keeps an informational turn from
// looking like a planning failure. Loosening any of the three moves the measured unhandled rate
// without moving any mechanism, which is the one way that number can lie.
//
// `answer_only` IS LAST-RESORT, AND 392 PLAN 10's LIVE RUN IS WHY. As first written, the
// instruction said to use it "when the turn asks for information rather than for something to
// happen" — and a real model, asked to route `show me the digest for RUN-1`, read that as its case
// and answered in prose while `runs.digest` sat unused in its tool set. Until 398 grounds this tool
// in the capability catalogue, its text is ungrounded model memory: the person asked for a run's
// digest and would have been handed an invention that looks exactly like the real one. So the
// instruction now names the precondition it always meant — no offered tool can produce what was
// asked — and says plainly that the model knows nothing about this project the tools did not tell
// it. This is a correctness fix about fabrication, not a routing preference.
//
// NO PAYLOAD BODIES. Session facts are one-liners and the replayed conversation is refs plus
// outcomes — the same map-not-territory rule the session log follows, applied to the one
// place where the whole conversation is about to cross a network boundary.

import type { ModelMessage } from 'ai'

import { buildTieredPrompt } from '../prompt/tiered-prompt-builder.js'
import type { PromptTierBlock } from '../prompt/tiered-prompt-builder.js'
import type { JobModelRequest } from '../jobs/record-llm-authorship.js'

import type { ChatClause } from './ports.js'

/** Who is asking and why — chat's stable-tier provenance (§1.4's `agent_context` parameter). */
export const CHAT_AGENT_CONTEXT =
  'agent-qa chat orchestrator. A person is talking to the QA agent through a terminal session. '
  + 'Your job on this turn is to PROPOSE a plan, not to carry one out: nothing you name here runs '
  + 'until a deterministic reconciliation step has checked it.'

const ROLE_BLOCK: PromptTierBlock = {
  title: 'Role',
  body:
    'You route what a person asked for onto the capabilities this host actually has. Every '
    + 'capability available to you is offered as a tool; there are no others, and there is no way '
    + 'to ask for one. A capability that is missing is missing because it has not shipped yet.',
}

const PLANNING_BLOCK: PromptTierBlock = {
  title: 'How to answer',
  body:
    // "OF THE LIST BELOW", not "of the request". The `Request` block carries the WHOLE utterance
    // while `Clauses to answer` carries only what stage 1 could not bind, so a count scoped to the
    // request asks for calls about clauses that are already resolved — and every one of those is a
    // call reconciliation cannot attribute to anything (392-VERIFICATION round 3).
    'Call one action tool per clause of the list below, in utterance order. Order is meaning: later '
    + 'clauses routinely depend on earlier ones, so the sequence you emit is the sequence that '
    + 'will be considered.\n'
    + '\n'
    + 'Use `answer_only` ONLY when no tool you were offered can produce what was asked for. You '
    + 'have no knowledge of this project beyond what the tools return, so a question a tool can '
    + 'answer must be routed to that tool: answering it yourself would put a plausible-looking '
    + 'invention where the project data belongs. A turn answered this way performs zero actions '
    + 'and returns your text. Name the clause you are answering in `clause`, copied verbatim from '
    + 'the list above: the call covers that clause and no other, so a request with two clauses '
    + 'needs one call per clause you answer.\n'
    + '\n'
    + 'Use `mark_unhandled` when no available tool can carry out a clause, naming that clause and '
    + 'saying which capability would be needed. This refuses the whole turn without performing any '
    + 'of it, and that is the correct outcome. Never substitute a tool that looks close: a request '
    + 'nobody can satisfy and a request satisfied by the wrong action are not the same event, and '
    + 'the person can only recover from the first one.\n'
    + '\n'
    // THE BOUND ON THE PARAGRAPH ABOVE, AND THE DEFINITION THE ONE BELOW LEANS ON.
    //
    // It sits between them on purpose. The refusal instruction preceded it and "needs an
    // identifier" follows it, and until this sentence existed nothing in the prompt said WHICH
    // inputs a tool demands — so a model deciding whether a clause "needs" something was deciding
    // it from its own reading rather than from the contract it was handed. 394-30 measured what
    // that costs: on a dist serving `authoring.draft.write` with `required: ["intent"]`, a live
    // planner refused the turn by name over "a target scope identifier", a requirement its own
    // tool contract denies and a phrase no source file in this repo contains. D-10 then spent the
    // whole turn on it.
    //
    // Stated in the SCHEMA's vocabulary rather than in prose about capabilities, because that is
    // the one form of the rule the model can check against what it was actually sent.
    + "A tool's required inputs are exactly the `required` list in its schema. Never mark a clause "
    + 'unhandled because a field outside that list is missing: omit the field, or fill it from the '
    + "person's own words when they name it.\n"
    + '\n'
    + 'Bind arguments only from what the person actually supplied. If a clause needs an identifier '
    + 'and none was given, that clause is unhandled — do not invent one.',
}

export interface ChatPromptInput {
  /** The current message, verbatim — the one payload body this vocabulary carries. */
  readonly utterance: string
  /** The clauses the planner is being asked about, as the splitter produced them. */
  readonly clauses: readonly ChatClause[]
  /** The model in force for this turn, as the session states it. */
  readonly activeModel: string
  /** Session facts as one-liners — refs and counts, never a serialized result. */
  readonly facts?: readonly string[]
  /**
   * The conversation this turn continues, oldest first, already repaired and PRUNED.
   *
   * `ModelMessage`, and the direction is spelled once (392-06's flagged mismatch, resolved by plan
   * 08's `chat-state.ts`). Log events become `ChatReplayMessage[]` through `replaySession`, that
   * becomes `ModelMessage[]` through `replayToModelMessages`, compaction prunes in THAT form, and
   * this block renders what compaction left. Taking the replay shape here would have needed an
   * inverse projection that could only invent the turn ids pruning discarded.
   */
  readonly conversation?: readonly ModelMessage[]
}

/**
 * The clauses stage 2 is asked about, numbered BY LIST POSITION rather than by clause index.
 *
 * The engine asks the planner only about the clauses stage 1 could not bind, so this list is a
 * SUBSET of the utterance's clauses — and numbering it by `clause.index + 1` rendered that subset
 * with holes: a two-clause request whose first clause the table resolved arrived as a list starting
 * at "2.", under an instruction to make one call per clause of the request. A model reading that
 * plans for the item it cannot see, which is the surplus call the reconciler then cannot attribute
 * (392-VERIFICATION round 3, CR-01's reachability half, WR-02). Contiguous numbering costs nothing
 * and makes the set the model is asked to count the same set the accounting counts.
 */
function renderClauses(clauses: readonly ChatClause[]): string {
  return clauses.map((clause, position) => `${String(position + 1)}. ${clause.text}`).join('\n')
}

function renderConversation(messages: readonly ModelMessage[]): string {
  return messages
    .map((message) => {
      // Chat only ever produces text content — `replayToModelMessages` carries a one-liner across
      // and compaction truncates strings — so the non-string arm is unreachable through the chat
      // path today. It is handled rather than cast because `ModelMessage` genuinely admits parts,
      // and a cast would put an object's default rendering into a prompt the day it stopped being
      // unreachable.
      const text =
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      return `${message.role}: ${text}`
    })
    .join('\n')
}

/**
 * Chat's three tiers, rendered by the one builder.
 *
 * A block is added only when it has content: an empty tier contributes zero bytes by the builder's
 * own contract, and a header over nothing would be a section a reader has to interpret as "there
 * were none" rather than "this host did not say".
 */
export function buildChatPrompt(input: ChatPromptInput): JobModelRequest {
  const context: PromptTierBlock[] = [
    { title: 'Session', body: `Model in force: ${input.activeModel}` },
  ]
  if (input.facts !== undefined && input.facts.length > 0) {
    context.push({ title: 'Session facts', body: input.facts.join('\n') })
  }

  const volatile: PromptTierBlock[] = []
  if (input.conversation !== undefined && input.conversation.length > 0) {
    volatile.push({ title: 'Conversation so far', body: renderConversation(input.conversation) })
  }
  volatile.push({ title: 'Request', body: input.utterance })
  if (input.clauses.length > 0) {
    volatile.push({ title: 'Clauses to answer', body: renderClauses(input.clauses) })
  }

  return buildTieredPrompt({
    agent_context: CHAT_AGENT_CONTEXT,
    stable: [ROLE_BLOCK, PLANNING_BLOCK],
    context,
    volatile,
  })
}
