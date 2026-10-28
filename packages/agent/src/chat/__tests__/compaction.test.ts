// CHAT-04's trigger policy, measured against the REAL v49 substrate (Phase 392, plan 06).
//
// HERMETIC BY CONTRACT, NOT BY MOCK (D-13). Every case below drives the shipped
// `createTokenAccounting` and the shipped `degrade` — the same functions a live chat host runs —
// over a fake capability thunk that reports a small context window. Nothing here stands in for the
// substrate: a hand-written degrade would be a second implementation of the mechanism under test,
// and every assertion about eviction, truncation or the cannot-fit outcome would then be an
// assertion about the fake (the produced-not-literal law).
//
// WHAT THE ESTIMATOR DOES, so the arithmetic below is readable rather than magic: the shipped
// estimator charges `ceil(totalTextChars / 4)` plus a flat constant per image part. Every fixture
// here is text-only, so `chars / 4` is the whole story and an exact-boundary case is constructible.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTokenAccounting } from '@vostride/agent-qa-model'
import {
  appStateSchema,
  browserConfigSchema,
  deviceConfigSchema,
  platformBase,
  timeoutConfigSchema,
  viewportSchema,
} from '@vostride/agent-qa-schema'
import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import type { ChatCompactionEvent, ModelCapabilities } from '@vostride/agent-qa-schema'

import {
  CHAT_MINIMUM_CONTEXT,
  COMPACTION_RATIO,
  createChatCompactionHook,
  maybeCompact,
  replayToModelMessages,
} from '../compaction.js'
import type { SessionReplay } from '../session-repair.js'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const COMPACTION_SOURCE = join(MODULE_DIR, '..', 'compaction.ts')

/** A capability report with only the two fields the ceilings read varying. */
function capabilities(contextWindow: number): ModelCapabilities {
  return {
    text: true,
    vision: false,
    visionToolMessages: false,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    contextWindow,
    maxOutput: 4096,
  }
}

/** The REAL accounting instance — shipped factory, shipped degrade, fake ceilings only. */
function accountingFor(contextWindow: number): ReturnType<typeof createTokenAccounting> {
  return createTokenAccounting({ getCapabilities: () => capabilities(contextWindow) })
}

function text(role: 'user' | 'assistant' | 'system', chars: number, fill = 'x'): ModelMessage {
  return { role, content: fill.repeat(chars) } as ModelMessage
}

let clockTicks = 0
function now(): string {
  clockTicks += 1
  return `2026-08-09T00:00:${String(clockTicks).padStart(2, '0')}.000Z`
}

function pass(messages: readonly ModelMessage[], contextWindow: number) {
  return maybeCompact({
    messages,
    accounting: accountingFor(contextWindow),
    turnId: 'turn-1',
    now,
  })
}

describe('CHAT-04 / D-20: the pinned trigger policy', () => {
  it('pins COMPACTION_RATIO at 0.5 and CHAT_MINIMUM_CONTEXT, each with a retune comment', () => {
    expect(COMPACTION_RATIO).toBe(0.5)
    expect(CHAT_MINIMUM_CONTEXT).toBeGreaterThan(0)

    const source = readFileSync(COMPACTION_SOURCE, 'utf8')
    // The comment is the retune CONTRACT (386 D-15): a pinned number nobody knows how to move is
    // indistinguishable from an accident, so the constant and its retune trigger ship together.
    expect(source).toMatch(/Retune trigger[\s\S]{0,600}?COMPACTION_RATIO = 0\.5/)
    expect(source).toMatch(/Retune trigger[\s\S]{0,600}?CHAT_MINIMUM_CONTEXT = /)
  })

  it('does not measure size itself — no local chars-per-token arithmetic in the module', () => {
    const source = readFileSync(COMPACTION_SOURCE, 'utf8')
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n')
    // `estimate` is the ONE size authority (edge: CHAT-04/encoding). A chars/4 here would be a
    // second estimator, free to disagree with the one the budget is denominated in.
    expect(code).not.toMatch(/\/\s*4\b/)
    expect(code).not.toMatch(/\.length\s*\/\s*\d/)
    expect(code).not.toMatch(/charCodeAt|TextEncoder|Buffer\.byteLength/)
  })
})

describe('CHAT-04: the threshold', () => {
  // contextWindow 32768 -> threshold 16384 tokens -> 65536 chars exactly.
  const WINDOW = 32768
  const THRESHOLD_CHARS = 65536

  it('one token below the threshold is a no-op: no degrade, no event', () => {
    const result = pass([text('user', THRESHOLD_CHARS - 8), text('assistant', 4)], WINDOW)
    expect(result.event).toBeUndefined()
  })

  it('EXACTLY at the threshold triggers — the contract is >=, not >', () => {
    const result = pass([text('user', THRESHOLD_CHARS - 4), text('assistant', 4)], WINDOW)
    expect(result.event).toBeDefined()
    expect(result.event?.beforeTokens).toBe(THRESHOLD_CHARS / 4)
  })

  it('above the threshold degrades and the conversation actually shrinks', () => {
    const before = [text('user', 400_000), text('assistant', 4_000), text('user', 40)]
    const result = pass(before, WINDOW)
    const budget = THRESHOLD_CHARS / 4
    expect(result.event?.outcome).toBe('degraded')
    expect(result.event?.beforeTokens).toBe(404_040 / 4)
    // A real reduction, not a rounding: 101,010 tokens down to the budget's neighbourhood.
    expect(result.event?.afterTokens).toBeLessThan((result.event?.beforeTokens ?? 0) / 5)
    // NOT `<= budget`, and the slack is the substrate's, measured rather than assumed. degrade's
    // truncation loop stops when a further slice would not shorten the message, and its marker
    // (`…[truncated to fit context budget]`, 34 chars) is re-appended every time — so the loop
    // converges to at most ~34 chars, i.e. ~9 tokens, above the budget. Asserting an exact fit
    // would be asserting a guarantee `packages/model` does not make.
    expect(result.event?.afterTokens).toBeLessThanOrEqual(budget + 16)
    expect(result.messages.length).toBeGreaterThan(0)
  })
})

describe('CHAT-04/empty: the degenerate histories', () => {
  it('an empty history is a no-op — no throw, no degrade, no event', () => {
    const result = pass([], 32768)
    expect(result.messages).toEqual([])
    expect(result.event).toBeUndefined()
  })

  it('a single message is a no-op even when it alone blows the threshold', () => {
    const only = [text('user', 400_000)]
    const result = pass(only, 32768)
    // There is nothing to prune BUT the one message, and degrade protects the final message —
    // so a pass here could only report a cost it did not pay.
    expect(result.messages).toEqual(only)
    expect(result.event).toBeUndefined()
  })
})

describe('CHAT-04: the budget floor', () => {
  it('floors the budget at CHAT_MINIMUM_CONTEXT rather than at half a tiny window', () => {
    // contextWindow 4000 -> threshold 2000 tokens (8000 chars); the floor (8192) is what the
    // conversation is asked to fit under, so a 3000-token history is NOT shredded to 2000.
    const before = [text('user', 8_000), text('assistant', 4_000), text('user', 40)]
    const result = pass(before, 4_000)
    expect(result.event).toBeDefined()
    expect(result.event?.outcome).toBe('degraded')
    // Nothing was over the FLOOR, so nothing was cut: the pass is honest about costing nothing.
    expect(result.event?.afterTokens).toBe(result.event?.beforeTokens)
    expect(result.messages).toHaveLength(3)
  })
})

describe('CHAT-04: the hard-truncate fallback cannot wedge a session', () => {
  // The protected set (system + final + the chat pin) alone exceeds the budget. degrade's own
  // contract is that it never throws and never violates a pin — this is chat's half of that.
  const unfittable: ModelMessage[] = [
    text('system', 400_000),
    text('user', 4_000),
    text('assistant', 4_000),
    text('user', 40),
  ]

  it('returns messages, emits the event, and throws nothing', () => {
    const result = pass(unfittable, 32768)
    expect(result.messages.length).toBeGreaterThan(0)
    expect(result.event?.outcome).toBe('pinned-content-exceeds-budget')
    expect(result.event?.beforeTokens).toBeGreaterThan(0)
    expect(typeof result.event?.afterTokens).toBe('number')
  })

  it('is a FIXPOINT: re-running the pass on its own output makes no further progress and still terminates', () => {
    const first = pass(unfittable, 32768)
    const second = pass(first.messages, 32768)
    const third = pass(second.messages, 32768)
    // A trigger that fires, frees nothing, and is re-entered on a CHANGED conversation is the wedge
    // shape. Both halves are denied here: the output is stable, and the caller is a per-turn hook
    // with no loop around it (asserted in the hook suite below).
    expect(second.messages).toEqual(first.messages)
    expect(third.messages).toEqual(second.messages)
    expect(second.event?.outcome).toBe('pinned-content-exceeds-budget')
    expect(second.event?.afterTokens).toBe(third.event?.afterTokens)
  })

  it('the no-progress floor arm is a fixpoint too', () => {
    const before = [text('user', 8_000), text('assistant', 4_000), text('user', 40)]
    const first = pass(before, 4_000)
    const second = pass(first.messages, 4_000)
    expect(second.messages).toEqual(first.messages)
    expect(second.event?.afterTokens).toBe(first.event?.afterTokens)
  })
})

describe('CHAT-04: the chat pin, as a two-sided differential', () => {
  // TWO SIDES, ONE SUBSTRATE (the 388/389/390 differential law). Each case runs the SAME fixture
  // twice against the same shipped `degrade`: once through `maybeCompact`, which supplies the chat
  // pin, and once directly with no pin at all. Asserting only the pinned side would prove nothing —
  // degrade already protects `system` and the FINAL message on its own, and a fixture where those
  // built-ins happen to cover the message is a test of the substrate wearing the pin's name.
  const WINDOW = 32768
  const BUDGET = (COMPACTION_RATIO * WINDOW) // 16384; above CHAT_MINIMUM_CONTEXT, so the floor is idle

  function unpinnedControl(messages: readonly ModelMessage[]) {
    return accountingFor(WINDOW).degrade(
      messages.map((message) => ({ ...message })) as ModelMessage[],
      { budget: BUDGET },
    )
  }

  it('protects the LAST ASSISTANT turn, which degrade’s own built-ins do not', () => {
    const lastAssistant = `${'a'.repeat(199_900)}ASSISTANT-TAIL-SENTINEL`
    const before: ModelMessage[] = [
      { role: 'user', content: 'q'.repeat(400_000) } as ModelMessage,
      { role: 'assistant', content: lastAssistant } as ModelMessage,
      { role: 'user', content: `user-final-${'u'.repeat(200)}` } as ModelMessage,
    ]

    // Side A — the unpinned control: the assistant turn IS reachable, and degrade truncates it.
    const control = unpinnedControl(before)
    expect(control.ok).toBe(true)
    expect(control.messages[1]?.content).not.toBe(lastAssistant)

    // Side B — with the chat pin: byte-exact survival. Not `toContain`: degrade truncates by
    // slicing from the front and re-appending its marker, so a pin that stopped working shows up
    // as a missing tail a substring check would happily accept.
    const result = pass(before, WINDOW)
    expect(result.messages[1]?.content).toBe(lastAssistant)
    // And the honest cost of protecting it: the protected set no longer fits, which degrade reports
    // rather than resolving by violating the pin. The session still gets a conversation and an
    // event — the cannot-wedge clause — and the reduction it did not get is the trade the pin makes.
    expect(result.event?.outcome).toBe('pinned-content-exceeds-budget')
  })

  it('protects the LAST USER turn even when it is not the final message', () => {
    // The replay handed to the hook ends at the PREVIOUS turn's receipt, so the person's last
    // question is routinely not the final message — which is exactly where degrade's final-message
    // built-in stops covering it.
    const lastUser = `${'u'.repeat(199_900)}USER-TAIL-SENTINEL`
    const before: ModelMessage[] = [
      { role: 'user', content: 'q'.repeat(400_000) } as ModelMessage,
      { role: 'user', content: lastUser } as ModelMessage,
      { role: 'assistant', content: `runs.digest: completed${'.'.repeat(200)}` } as ModelMessage,
    ]

    const control = unpinnedControl(before)
    expect(control.ok).toBe(true)
    expect(control.messages[1]?.content).not.toBe(lastUser)

    const result = pass(before, WINDOW)
    expect(result.messages[1]?.content).toBe(lastUser)
  })

  it('does NOT protect the unpinned bulk — an ordinary pass still shrinks the history', () => {
    const before = [text('user', 400_000), text('assistant', 4_000), text('user', 40)]
    const result = pass(before, WINDOW)
    expect(result.event?.outcome).toBe('degraded')
    expect(String(result.messages[0]?.content).length).toBeLessThan(400_000)
  })
})

describe('CHAT-04 / the assumption-delta invariant: ONE event per pass', () => {
  async function runHook(messages: readonly ModelMessage[], contextWindow: number) {
    const emitted: ChatCompactionEvent[] = []
    const retained: (readonly ModelMessage[])[] = []
    const hook = createChatCompactionHook({
      accounting: accountingFor(contextWindow),
      now,
      onConversation: (messagesOut) => {
        retained.push(messagesOut)
      },
      conversationFor: () => messages,
    })
    // The append arrives per CALL now (392-12), because it is the handle of the session whose turn
    // is being compacted — a hook bound to one log at construction could not know which that is.
    await hook({
      turnId: 'turn-7',
      // The session arrives per CALL too (392 plan 13): what a pass publishes is one conversation's
      // pruned history, and the sink it goes to is one container per session.
      sessionId: 'session-compaction',
      replay: { messages: [], abortedTurnIds: [] },
      append: (event) => {
        emitted.push(event)
        return Promise.resolve()
      },
    })
    return { emitted, retained }
  }

  it('emits exactly one compaction event whichever degrade stages fired', async () => {
    // Three genuinely different passes: hygiene-only (floor-bound), full damage (truncation),
    // and the cannot-fit arm. Sibling event kinds per stage would make these one, two and three.
    const hygieneOnly = await runHook([text('user', 8_000), text('assistant', 4_000), text('user', 40)], 4_000)
    const damaged = await runHook([text('user', 400_000), text('assistant', 4_000), text('user', 40)], 32768)
    const cannotFit = await runHook(
      [text('system', 400_000), text('user', 4_000), text('assistant', 4_000), text('user', 40)],
      32768,
    )

    expect(hygieneOnly.emitted).toHaveLength(1)
    expect(damaged.emitted).toHaveLength(1)
    expect(cannotFit.emitted).toHaveLength(1)
    expect(new Set([...hygieneOnly.emitted, ...damaged.emitted, ...cannotFit.emitted].map((e) => e.kind)))
      .toEqual(new Set(['compaction']))
  })

  it('emits NO event below the threshold, and still hands the conversation on', async () => {
    const quiet = await runHook([text('user', 40), text('assistant', 40)], 32768)
    expect(quiet.emitted).toEqual([])
    expect(quiet.retained).toHaveLength(1)
  })

  it('stamps the turn the engine gave it, never a turn of its own', async () => {
    const damaged = await runHook([text('user', 400_000), text('assistant', 4_000), text('user', 40)], 32768)
    expect(damaged.emitted[0]?.turnId).toBe('turn-7')
  })

  it('defaults its conversation to the REPAIRED replay it was handed (CHAT-05 ordering)', async () => {
    const emitted: ChatCompactionEvent[] = []
    const retained: (readonly ModelMessage[])[] = []
    const hook = createChatCompactionHook({
      accounting: accountingFor(32768),
      now,
      onConversation: (messagesOut) => {
        retained.push(messagesOut)
      },
    })
    const replay: SessionReplay = {
      messages: [
        { role: 'user', text: 'w'.repeat(400_000), turnId: 't1' },
        { role: 'assistant', text: 'runs.digest: completed', turnId: 't1' },
        { role: 'user', text: 'and then?', turnId: 't2' },
      ],
      abortedTurnIds: [],
    }
    await hook({
      turnId: 't2',
      sessionId: 'session-compaction',
      replay,
      append: (event) => {
        emitted.push(event)
        return Promise.resolve()
      },
    })
    expect(emitted).toHaveLength(1)
    expect(retained[0]?.length).toBeGreaterThan(0)
  })
})

describe('replayToModelMessages', () => {
  it('carries the repaired replay across verbatim, in order', () => {
    const replay: SessionReplay = {
      messages: [
        { role: 'user', text: 'run test 42', turnId: 't1' },
        { role: 'assistant', text: 'runs.start: completed', turnId: 't1' },
      ],
      abortedTurnIds: ['t0'],
    }
    expect(replayToModelMessages(replay)).toEqual([
      { role: 'user', content: 'run test 42' },
      { role: 'assistant', content: 'runs.start: completed' },
    ])
  })
})

// ---------------------------------------------------------------------------------------
// D-20's knob-absence gate.
//
// SCHEMA-KEY-DRIVEN, NEVER A GREP OVER FILE TEXT. A raw-text search for `compactionRatio` is
// defeated by the first comment that mentions the words — including the retune comment this very
// plan requires — so the gate would either be self-invalidating or would have to be taught to
// ignore comments, which is a parser it does not have. Walking the parsed zod shapes asks the
// question that actually matters: is there a CONFIGURABLE KEY, whatever any file says about one.
// ---------------------------------------------------------------------------------------

/** Every schema the config surface publishes, walked as one inventory. */
const CONFIG_SCHEMAS = [
  platformBase,
  browserConfigSchema,
  deviceConfigSchema,
  timeoutConfigSchema,
  appStateSchema,
  viewportSchema,
]

interface ZodDef {
  readonly type?: string
  readonly shape?: Record<string, unknown>
  readonly options?: readonly unknown[]
  readonly innerType?: unknown
  readonly element?: unknown
  readonly valueType?: unknown
  readonly left?: unknown
  readonly right?: unknown
  readonly in?: unknown
  readonly out?: unknown
  readonly getter?: () => unknown
}

function defOf(node: unknown): ZodDef | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const internal = (node as { _zod?: { def?: ZodDef }; def?: ZodDef })
  return internal._zod?.def ?? internal.def
}

/** Recursively collect every declared key name across the config schema surface. */
function collectConfigSchemaKeys(): string[] {
  const keys = new Set<string>()
  const seen = new Set<unknown>()

  const walk = (node: unknown, depth: number): void => {
    if (depth > 16 || seen.has(node)) return
    const def = defOf(node)
    if (def === undefined) return
    seen.add(node)
    switch (def.type) {
      case 'object':
        for (const [key, value] of Object.entries(def.shape ?? {})) {
          keys.add(key)
          walk(value, depth + 1)
        }
        break
      case 'union':
        for (const option of def.options ?? []) walk(option, depth + 1)
        break
      case 'optional':
      case 'nullable':
      case 'default':
      case 'nonoptional':
      case 'readonly':
      case 'catch':
        walk(def.innerType, depth + 1)
        break
      case 'array':
        walk(def.element, depth + 1)
        break
      case 'record':
        walk(def.valueType, depth + 1)
        break
      case 'intersection':
        walk(def.left, depth + 1)
        walk(def.right, depth + 1)
        break
      case 'pipe':
        walk(def.in, depth + 1)
        walk(def.out, depth + 1)
        break
      case 'lazy':
        walk(def.getter?.(), depth + 1)
        break
      default:
        break
    }
  }

  for (const schema of CONFIG_SCHEMAS) walk(schema, 0)
  return [...keys].sort()
}

/** A key naming the compaction FRACTION concept, in any casing or dotted path form. */
function compactionKnobKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const lowered = key.toLowerCase()
    if (!lowered.includes('compact')) return false
    return lowered.includes('ratio') || lowered.includes('fraction')
  })
}

describe('D-20: the knob-absence gate', () => {
  it('walks a real, non-empty config-schema key inventory', () => {
    const keys = collectConfigSchemaKeys()
    // A walker that silently returned nothing would pass the assertion below forever.
    expect(keys.length).toBeGreaterThan(10)
    expect(keys).toContain('timeouts')
  })

  it('no config-schema key is a compaction ratio/fraction knob', () => {
    expect(compactionKnobKeys(collectConfigSchemaKeys())).toEqual([])
  })

  it('POSITIVE CONTROL: the detector flags the knob when one exists', () => {
    // Without this, "no knob" and "the detector is broken" are the same green.
    expect(compactionKnobKeys(['timeouts', 'compactionRatio'])).toEqual(['compactionRatio'])
    expect(compactionKnobKeys(['chat.compactFraction'])).toEqual(['chat.compactFraction'])
    expect(compactionKnobKeys(['COMPACTION_RATIO'])).toEqual(['COMPACTION_RATIO'])
  })
})
