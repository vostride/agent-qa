// The stable tier holds identical bytes every turn so a provider prompt cache can reuse the prefix.

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
    // Scoped to the list, because the request also holds clauses stage 1 already bound.
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
    // Required inputs are stated in the schema's terms, the one form the model can check against.
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
  // `ModelMessage`, because compaction prunes in that form and an inverse would invent turn ids.
  readonly conversation?: readonly ModelMessage[]
}

// Numbered by list position: the list is a subset, and clause-index numbering left holes.
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
