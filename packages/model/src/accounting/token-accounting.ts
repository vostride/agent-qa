// The conversation-scoped token-accounting instance.
// Closure-state factory: options in, closure-captured anchor
// state, an object of methods out. Provider-neutral: operates only on AI SDK `ModelMessage[]`.

import type { ModelMessage } from 'ai'

import { degrade as pureDegrade } from './degrade.js'
import type { DegradeOptions, DegradeOutcome, TokenAccounting, TokenAccountingOptions } from './types.js'

// Anthropic's large-image ceiling ≈ (1568×1568)/750 ≈ 1,533 tokens at v2 downscaled capture
// sizes; 1,600 is the safe conservative over-estimate (RESEARCH Q8/D-12). Injectable, never
// user-facing config. Over-charging degrades slightly early — the safe direction.
const DEFAULT_PER_IMAGE_TOKENS = 1600

interface Anchor {
  promptTokens: number
  prefixLength: number
  prefixDigest: string
}

export function createTokenAccounting(options: TokenAccountingOptions): TokenAccounting {
  const perImageTokens = options.perImageTokens ?? DEFAULT_PER_IMAGE_TOKENS
  let anchor: Anchor | undefined

  function estimate(messages: ModelMessage[]): number {
    let chars = 0
    let images = 0
    for (const message of messages) {
      chars += messageTextChars(message)
      images += messageImageCount(message)
    }
    let textTokens = Math.ceil(chars / 4)
    if (anchor !== undefined && prefixMatches(messages, anchor)) {
      textTokens = Math.max(textTokens, anchor.promptTokens)
    }
    return textTokens + images * perImageTokens
  }

  function recordUsage(usage: { inputTokens?: number }, messages: ModelMessage[]): void {
    const inputTokens = usage.inputTokens
    if (inputTokens === undefined) return
    anchor = { promptTokens: inputTokens, prefixLength: messages.length, prefixDigest: digestPrefix(messages) }
  }

  function getCeilings(): { contextWindow: number; maxOutput: number } {
    const c = options.getCapabilities()
    return { contextWindow: c.contextWindow, maxOutput: c.maxOutput }
  }

  function degrade(messages: ModelMessage[], opts: DegradeOptions): DegradeOutcome {
    return pureDegrade(messages, { ...opts, estimate })
  }

  return { estimate, recordUsage, getCeilings, degrade }
}

/** The anchored prefix still matches when messages are ≥ the anchored length and the leading
 * `prefixLength` messages hash identically — an identity, never an array cursor (D-01/Pitfall 6). */
function prefixMatches(messages: ModelMessage[], anchor: Anchor): boolean {
  if (messages.length < anchor.prefixLength) return false
  const prefix = messages.length === anchor.prefixLength ? messages : messages.slice(0, anchor.prefixLength)
  return digestPrefix(prefix) === anchor.prefixDigest
}

function messageTextChars(message: ModelMessage): number {
  const content = message.content
  if (typeof content === 'string') return content.length
  let total = 0
  for (const part of content as unknown[]) total += partTextChars(part)
  return total
}

function partTextChars(part: unknown): number {
  if (!isRecord(part)) return 0
  if (part.type === 'text' && typeof part.text === 'string') return part.text.length
  if (part.type === 'tool-result') return outputTextChars(part.output)
  return 0
}

function outputTextChars(output: unknown): number {
  if (!isRecord(output)) return 0
  if ((output.type === 'text' || output.type === 'error-text') && typeof output.value === 'string') {
    return output.value.length
  }
  if (output.type === 'content' && Array.isArray(output.value)) {
    let total = 0
    for (const item of output.value) {
      if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') total += item.text.length
    }
    return total
  }
  return 0
}

/** One flat charge per image part — inline user `ImagePart`s and historical `ToolResultOutput
 * { type:'content' }` `image-data`/`media` parts alike; base64 length is never read (RESEARCH Q8). */
function messageImageCount(message: ModelMessage): number {
  const content = message.content
  if (typeof content === 'string') return 0
  let count = 0
  for (const part of content as unknown[]) {
    if (!isRecord(part)) continue
    if (part.type === 'image') count += 1
    else if (part.type === 'tool-result') count += outputImageCount(part.output)
  }
  return count
}

function outputImageCount(output: unknown): number {
  if (!isRecord(output) || output.type !== 'content' || !Array.isArray(output.value)) return 0
  let count = 0
  for (const item of output.value) {
    if (isRecord(item) && (item.type === 'image-data' || item.type === 'media')) count += 1
  }
  return count
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** FNV-1a over a cycle-safe, key-sorted stringify of the message prefix — a content identity,
 * not a security control; used solely to detect when the anchored prefix diverges. */
function digestPrefix(messages: ModelMessage[]): string {
  const str = safeStringify(messages)
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${messages.length}:${(hash >>> 0).toString(16)}`
}

function safeStringify(value: unknown): string {
  const ancestors: object[] = []
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') return node
    if (ancestors.includes(node as object)) return '[Circular]'
    ancestors.push(node as object)
    let result: unknown
    if (Array.isArray(node)) {
      result = node.map(walk)
    } else {
      const sortedKeys = Object.keys(node as Record<string, unknown>).sort()
      const obj: Record<string, unknown> = {}
      for (const key of sortedKeys) obj[key] = walk((node as Record<string, unknown>)[key])
      result = obj
    }
    ancestors.pop()
    return result
  }
  try {
    return JSON.stringify(walk(value)) ?? 'undefined'
  } catch {
    return '[unserializable]'
  }
}
