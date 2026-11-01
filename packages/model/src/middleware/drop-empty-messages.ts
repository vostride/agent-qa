import type { LanguageModelMiddleware } from 'ai'
import type { LanguageModelV4Message, LanguageModelV4Prompt } from '@ai-sdk/provider'

// A second layer at egress: the OpenAI Responses API rejects empty message content with HTTP 400.

// A message is "empty" when it contributes no content to the wire:
//   - system: its string content trims to empty
//   - user/assistant/tool: its content array has no part with non-empty text AND no
//     non-text part (a file/tool/reasoning part always keeps the message)
function isEmptyMessage(message: LanguageModelV4Message): boolean {
  if (message.role === 'system') {
    return typeof message.content === 'string' && message.content.trim().length === 0
  }
  const parts = message.content
  if (!Array.isArray(parts) || parts.length === 0) return true
  for (const part of parts) {
    if (part.type === 'text' || part.type === 'reasoning') {
      if (typeof part.text === 'string' && part.text.trim().length > 0) return false
    } else {
      // Any non-text part (file/tool-call/tool-result/approval) is meaningful content.
      return false
    }
  }
  return true
}

export function dropEmptyMessagesMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',

    transformParams: async ({ params }) => {
      const prompt = params.prompt as LanguageModelV4Prompt | undefined
      if (!prompt) return params
      const filtered = prompt.filter((message) => !isEmptyMessage(message))
      if (filtered.length === prompt.length) return params
      return { ...params, prompt: filtered }
    },
  }
}
