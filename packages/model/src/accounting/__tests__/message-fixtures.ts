// Framework-free deterministic `ModelMessage[]` fixture factory for the accounting suite.
// CRITICAL: imports NOTHING from a test framework so all accounting test files reuse it
// (mirrors runner/src/testing/screen-fixtures.ts). Every builder returns fresh objects
// with fixed constants — no clock, no randomness — so repeated calls are deep-equal.

import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai'

type ToolOutput = ToolResultPart['output']

/** Fixed 1x1 PNG base64 — the deterministic screenshot/image payload the clearing lane strips. */
export const FIXTURE_IMAGE_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

export function systemMessage(content = 'You are a deterministic test agent.'): ModelMessage {
  return { role: 'system', content }
}

export function userText(text = 'Log in with the demo account.'): ModelMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

export function assistantText(text = 'Understood. Proceeding.'): ModelMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

/** Assistant turn carrying a reasoning part (stripped by the hygiene pass unless last). */
export function assistantReasoning(
  reasoning = 'The user wants to log in; I will inspect the form first.',
  text = 'I will inspect the login form.',
): ModelMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: reasoning },
      { type: 'text', text },
    ],
  }
}

/** User turn with an inline `{ type:'image' }` part — one flat per-image cost, never base64. */
export function userWithImage(
  text = 'Here is the current screen.',
  image = FIXTURE_IMAGE_DATA,
): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', image, mediaType: 'image/png' },
    ],
  }
}

export function textOutput(value: string): ToolOutput {
  return { type: 'text', value }
}

/** Historical screenshot tool result: an `image-data` part inside a `content` output. */
export function screenshotOutput(data = FIXTURE_IMAGE_DATA, mediaType = 'image/png'): ToolOutput {
  return { type: 'content', value: [{ type: 'image-data', data, mediaType }] }
}

/** Historical screenshot tool result using the deprecated `media` part shape. */
export function mediaOutput(data = FIXTURE_IMAGE_DATA, mediaType = 'image/png'): ToolOutput {
  return { type: 'content', value: [{ type: 'media', data, mediaType }] }
}

export interface ToolCallSpec {
  toolCallId: string
  toolName?: string
  input?: unknown
  output: ToolOutput
}

/**
 * A single tool exchange: one assistant message holding N `ToolCallPart`s + one `role:'tool'`
 * message holding the matching N `ToolResultPart`s, the exchange `planning-turn.ts` builds. A
 * one-element `specs` is a plain exchange; a multi-element `specs` is the fan-out shape.
 */
export function toolExchange(specs: ToolCallSpec[]): [ModelMessage, ModelMessage] {
  const calls: ToolCallPart[] = specs.map(spec => ({
    type: 'tool-call',
    toolCallId: spec.toolCallId,
    toolName: spec.toolName ?? 'inspect',
    input: spec.input ?? { ref: 'e1' },
  }))
  const results: ToolResultPart[] = specs.map(spec => ({
    type: 'tool-result',
    toolCallId: spec.toolCallId,
    toolName: spec.toolName ?? 'inspect',
    output: spec.output,
  }))
  return [
    { role: 'assistant', content: calls },
    { role: 'tool', content: results },
  ]
}

export interface MakeModelMessagesOptions {
  /** Replace the deterministic baseline entirely (used when a test assembles its own history). */
  messages?: ModelMessage[]
}

/**
 * A deterministic baseline conversation covering every shape the accounting tests key on:
 * system, plain text turns, a reasoning turn, a single tool exchange, a multi-tool fan-out
 * exchange, a historical screenshot tool result, and an inline image user turn.
 */
export function makeModelMessages(options: MakeModelMessagesOptions = {}): ModelMessage[] {
  if (options.messages) return options.messages
  return [
    systemMessage(),
    userText('Log in with the demo account.'),
    assistantReasoning(),
    ...toolExchange([{ toolCallId: 'call-inspect-1', toolName: 'inspect', output: textOutput('login form found') }]),
    ...toolExchange([
      { toolCallId: 'call-a', toolName: 'inspect', output: textOutput('email field') },
      { toolCallId: 'call-b', toolName: 'inspect', output: textOutput('password field') },
    ]),
    ...toolExchange([{ toolCallId: 'call-shot-1', toolName: 'screenshot', output: screenshotOutput() }]),
    userWithImage(),
    assistantText('Login submitted.'),
    userText('Confirm the dashboard is visible.'),
  ]
}
