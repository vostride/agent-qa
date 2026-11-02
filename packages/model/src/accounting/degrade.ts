// Hygiene runs every call; eviction and truncation only while the estimate exceeds the budget.

import { pruneMessages, type ModelMessage, type ToolContent, type ToolResultPart } from 'ai'

import type { DegradeOptions, DegradeOutcome } from './types.js'

type ToolOutput = ToolResultPart['output']
type ToolPart = ToolContent[number]

const SCREENSHOT_OMITTED = '…[historical screenshot omitted]'
const DUPLICATE_ELIDED = '…[duplicate tool result elided]'
const TRUNCATION_MARKER = '…[truncated to fit context budget]'

// System, final and pinned messages are never evicted; if they alone overflow, cannot-fit.
export function degrade(messages: ModelMessage[], options: DegradeOptions): DegradeOutcome {
  const estimate = options.estimate ?? defaultEstimate
  let working = runHygiene(messages)

  // Hard floor: protected content alone exceeds the budget.
  if (estimate(protectedMessages(working, options)) > options.budget) {
    return { ok: false, reason: 'pinned-content-exceeds-budget', messages: working }
  }

  // Damage — eviction: remove the oldest unpinned tool exchange, re-estimate, repeat.
  while (estimate(working) > options.budget) {
    const evicted = evictOldestExchange(working, options)
    if (!evicted) break
    working = evicted
  }

  // Damage — proportional truncation of the largest remaining unpinned message.
  const exhausted = new Set<number>()
  while (estimate(working) > options.budget) {
    const isProtectedAt = makeIsProtected(working, options)
    let targetIndex = -1
    let targetLength = 0
    working.forEach((message, index) => {
      if (isProtectedAt(index) || exhausted.has(index)) return
      const length = messageTextLength(message)
      if (length > targetLength) {
        targetLength = length
        targetIndex = index
      }
    })
    if (targetIndex === -1 || targetLength === 0) break

    const overshootChars = Math.max(1, (estimate(working) - options.budget) * 4)
    const keepChars = Math.max(0, targetLength - overshootChars)
    const truncatedMessage = truncateMessage(working[targetIndex], keepChars)

    if (messageTextLength(truncatedMessage) >= messageTextLength(working[targetIndex])) {
      exhausted.add(targetIndex)
      continue
    }
    working = working.map((message, index) => (index === targetIndex ? truncatedMessage : message))
    if (keepChars === 0) exhausted.add(targetIndex)
  }

  return { ok: true, messages: working }
}

/** Fallback estimator (~chars/4) for standalone `degrade`; the factory passes its own. */
function defaultEstimate(messages: ModelMessage[]): number {
  let chars = 0
  for (const message of messages) chars += messageTextLength(message)
  return Math.ceil(chars / 4)
}

// System, final and caller-pinned messages are the protected set.
function makeIsProtected(messages: ModelMessage[], options: DegradeOptions): (index: number) => boolean {
  const lastIndex = messages.length - 1
  return (index: number): boolean => {
    const message = messages[index]
    if (message.role === 'system') return true
    if (index === lastIndex) return true
    return options.pin ? options.pin(message, index) === true : false
  }
}

function protectedMessages(messages: ModelMessage[], options: DegradeOptions): ModelMessage[] {
  const isProtectedAt = makeIsProtected(messages, options)
  return messages.filter((_, index) => isProtectedAt(index))
}

function toolCallIdsOf(message: ModelMessage): string[] {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
  const ids: string[] = []
  for (const part of message.content) if (part.type === 'tool-call') ids.push(part.toolCallId)
  return ids
}

function resultIdsOf(message: ModelMessage): string[] {
  const ids: string[] = []
  if (message.role === 'tool') {
    for (const part of message.content) if (part.type === 'tool-result') ids.push(part.toolCallId)
  } else if (message.role === 'assistant' && Array.isArray(message.content)) {
    for (const part of message.content) if (part.type === 'tool-result') ids.push(part.toolCallId)
  }
  return ids
}

// Evicts a tool call with all its results; an exchange touching protected content is skipped.
function evictOldestExchange(messages: ModelMessage[], options: DegradeOptions): ModelMessage[] | undefined {
  const isProtectedAt = makeIsProtected(messages, options)
  for (let i = 0; i < messages.length; i++) {
    const callIds = toolCallIdsOf(messages[i])
    if (callIds.length === 0) continue
    const idSet = new Set(callIds)
    const exchange = new Set<number>([i])
    for (let j = 0; j < messages.length; j++) {
      if (j === i) continue
      if (resultIdsOf(messages[j]).some(id => idSet.has(id))) exchange.add(j)
    }
    let evictable = true
    for (const index of exchange) {
      if (isProtectedAt(index)) {
        evictable = false
        break
      }
    }
    if (!evictable) continue
    return messages.filter((_, index) => !exchange.has(index))
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function messageTextLength(message: ModelMessage): number {
  const content = message.content
  if (typeof content === 'string') return content.length
  let total = 0
  for (const part of content as unknown[]) total += partTextLength(part)
  return total
}

function partTextLength(part: unknown): number {
  if (!isRecord(part)) return 0
  if (part.type === 'text' && typeof part.text === 'string') return part.text.length
  if (part.type === 'tool-result') return outputTextLength(part.output)
  return 0
}

function outputTextLength(output: unknown): number {
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

/** Proportionally truncate a message's largest text-bearing part, appending the spec marker. */
function truncateMessage(message: ModelMessage, keepChars: number): ModelMessage {
  const content = message.content
  if (typeof content === 'string') {
    return { ...message, content: sliceWithMarker(content, keepChars) } as ModelMessage
  }

  const parts = content as unknown[]
  let largestIndex = -1
  let largestLength = -1
  parts.forEach((part, index) => {
    const length = partTextLength(part)
    if (length > largestLength) {
      largestLength = length
      largestIndex = index
    }
  })
  if (largestIndex === -1 || largestLength <= 0) return message

  const removeTarget = Math.max(0, messageTextLength(message) - Math.max(0, keepChars))
  const partKeep = Math.max(0, largestLength - removeTarget)
  const newParts = parts.map((part, index) => (index === largestIndex ? truncatePart(part, partKeep) : part))
  return { ...message, content: newParts } as unknown as ModelMessage
}

/** Slice to `keep` chars + marker, first stripping any existing trailing marker so repeated
 * truncation of the same message converges monotonically instead of re-slicing the marker. */
function sliceWithMarker(text: string, keep: number): string {
  const base = text.endsWith(TRUNCATION_MARKER) ? text.slice(0, text.length - TRUNCATION_MARKER.length) : text
  return base.slice(0, Math.max(0, keep)) + TRUNCATION_MARKER
}

function truncatePart(part: unknown, keep: number): unknown {
  if (!isRecord(part)) return part
  if (part.type === 'text' && typeof part.text === 'string') {
    return { ...part, text: sliceWithMarker(part.text, keep) }
  }
  if (part.type === 'tool-result') {
    return { ...part, output: truncateOutput(part.output, keep) }
  }
  return part
}

function truncateOutput(output: unknown, keep: number): unknown {
  if (!isRecord(output)) return output
  if ((output.type === 'text' || output.type === 'error-text') && typeof output.value === 'string') {
    return { ...output, value: sliceWithMarker(output.value, keep) }
  }
  return output
}

/**
 * Near-lossless hygiene: the SDK `pruneMessages` leg (reasoning strip keeping the last
 * message's reasoning + empty-message removal) followed by the custom tool-result clearing
 * lane. `pruneMessages` only removes parts; the clearing lane does the rewriting.
 */
export function runHygiene(messages: ModelMessage[]): ModelMessage[] {
  const pruned = pruneMessages({
    messages,
    reasoning: 'before-last-message',
    emptyMessages: 'remove',
  })
  return clearHistoricalToolResults(pruned)
}

/**
 * The clearing lane. The most recent tool message is preserved verbatim; every earlier
 * (historical) tool result has its screenshot base64 stripped and content-identical results
 * hash-deduped down to a one-liner. Rewrites parts, never removes them.
 */
function clearHistoricalToolResults(messages: ModelMessage[]): ModelMessage[] {
  let lastToolIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') {
      lastToolIndex = i
      break
    }
  }

  const seenHashes = new Set<string>()
  return messages.map((message, index) => {
    if (message.role !== 'tool' || index === lastToolIndex) return message
    const rewritten = message.content.map(part => rewriteHistoricalPart(part, seenHashes))
    return { ...message, content: rewritten }
  })
}

function rewriteHistoricalPart(part: ToolPart, seenHashes: Set<string>): ToolPart {
  if (part.type !== 'tool-result') return part

  const hash = contentHash(part.output)
  if (seenHashes.has(hash)) {
    return { ...part, output: { type: 'text', value: DUPLICATE_ELIDED } }
  }
  seenHashes.add(hash)

  const stripped = stripScreenshots(part.output)
  return stripped === part.output ? part : { ...part, output: stripped }
}

/** Replace historical image parts (`image-data`, inline-data `file`) with a text marker. */
function stripScreenshots(output: ToolOutput): ToolOutput {
  if (output.type !== 'content') return output
  let changed = false
  const value = output.value.map(item => {
    if (item.type === 'image-data' || (item.type === 'file' && item.data.type === 'data')) {
      changed = true
      return { type: 'text' as const, text: SCREENSHOT_OMITTED }
    }
    return item
  })
  return changed ? { type: 'content', value } : output
}

/**
 * Non-security content-identity hash (FNV-1a over a safe stringify). Identity only — NOT a
 * security control. Used solely to collapse content-identical historical tool results.
 */
function contentHash(value: unknown): string {
  const str = safeStringify(value)
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

// Never throws on cyclic values, and sorts keys so identical content hashes identically.
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
