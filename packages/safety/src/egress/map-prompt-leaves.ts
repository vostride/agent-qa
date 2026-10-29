import type { LanguageModelMiddleware } from 'ai'

export type ProviderRequestParams =
  Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0]['params']

type LeafFn = (text: string) => string
type PromptMessage = ProviderRequestParams['prompt'][number]
type UserMessage = Extract<PromptMessage, { role: 'user' }>
type AssistantMessage = Extract<PromptMessage, { role: 'assistant' }>
type ToolMessage = Extract<PromptMessage, { role: 'tool' }>
type UserContentPart = UserMessage['content'][number]
type AssistantContentPart = AssistantMessage['content'][number]
type ToolContentPart = ToolMessage['content'][number]
type FileContentPart = Extract<UserContentPart | AssistantContentPart, { type: 'file' }>
type ToolResultOutput = Extract<AssistantContentPart, { type: 'tool-result' }>['output']
type ToolResultContentPart = Extract<ToolResultOutput, { type: 'content' }>['value'][number]

// The prompt walker the masking middleware delegates to; binary data never reaches `fn`.
export function mapPromptLeaves(params: ProviderRequestParams, fn: LeafFn): ProviderRequestParams {
  // Only params.prompt is run content. Top-level headers carry provider auth, while
  // stopSequences, tools, responseFormat, and providerOptions are caller/transport config
  // outside egress scope.
  return {
    ...params,
    prompt: params.prompt.map((message) => mapMessage(message, fn)),
  }
}

function mapMessage(message: PromptMessage, fn: LeafFn): PromptMessage {
  switch (message.role) {
    case 'system':
      return { ...message, content: fn(message.content) }
    case 'user':
      return { ...message, content: message.content.map((part) => mapUserPart(part, fn)) }
    case 'assistant':
      return { ...message, content: message.content.map((part) => mapAssistantPart(part, fn)) }
    case 'tool':
      return { ...message, content: message.content.map((part) => mapToolPart(part, fn)) }
  }
}

function mapUserPart(part: UserContentPart, fn: LeafFn): UserContentPart {
  if (part.type === 'text') {
    return { ...part, text: fn(part.text) }
  }

  if (part.type === 'file') {
    return mapFilePart(part, fn)
  }

  return part
}

function mapAssistantPart(part: AssistantContentPart, fn: LeafFn): AssistantContentPart {
  if (part.type === 'text' || part.type === 'reasoning') {
    return { ...part, text: fn(part.text) }
  }

  if (part.type === 'file') {
    return mapFilePart(part, fn)
  }

  if (part.type === 'tool-call') {
    return { ...part, input: mapJsonLike(part.input, fn) }
  }

  if (part.type === 'tool-result') {
    return { ...part, output: mapToolResultOutput(part.output, fn) }
  }

  return part
}

function mapToolPart(part: ToolContentPart, fn: LeafFn): ToolContentPart {
  if (part.type === 'tool-result') {
    return { ...part, output: mapToolResultOutput(part.output, fn) }
  }

  if (part.type === 'tool-approval-response') {
    return part.reason === undefined ? part : { ...part, reason: fn(part.reason) }
  }

  return part
}

function mapFilePart(part: FileContentPart, fn: LeafFn): FileContentPart {
  return {
    ...part,
    ...(part.filename === undefined ? {} : { filename: fn(part.filename) }),
  }
}

function mapToolResultOutput(output: ToolResultOutput, fn: LeafFn): ToolResultOutput {
  if (output.type === 'text' || output.type === 'error-text') {
    return { ...output, value: fn(output.value) }
  }

  if (output.type === 'execution-denied') {
    return output.reason === undefined ? output : { ...output, reason: fn(output.reason) }
  }

  if (output.type === 'json' || output.type === 'error-json') {
    return { ...output, value: mapJsonLike(output.value, fn) }
  }

  if (output.type === 'content') {
    return { ...output, value: output.value.map((part) => mapToolResultContentPart(part, fn)) }
  }

  return output
}

function mapToolResultContentPart(part: ToolResultContentPart, fn: LeafFn): ToolResultContentPart {
  switch (part.type) {
    case 'text':
      return { ...part, text: fn(part.text) }
    case 'file-data':
      return {
        ...part,
        ...(part.filename === undefined ? {} : { filename: fn(part.filename) }),
      }
    case 'image-data':
      return part
    case 'file-url':
    case 'image-url':
      return { ...part, url: fn(part.url) }
    case 'file-id':
    case 'image-file-id':
      return typeof part.fileId === 'string' ? { ...part, fileId: fn(part.fileId) } : part
  }

  return part
}

function mapJsonLike<T>(value: T, fn: LeafFn): T {
  return mapJsonValue(value, fn, true) as T
}

// Keys are masked like values, `toJSON` runs once, and binary data is returned untouched.
function mapJsonValue(value: unknown, fn: LeafFn, callToJson: boolean): unknown {
  if (typeof value === 'string') return fn(value)
  if (typeof value !== 'object' || value === null) return value
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value
  if (Array.isArray(value)) return value.map((item) => mapJsonValue(item, fn, true))
  const toJson = (value as { toJSON?: unknown }).toJSON
  if (callToJson && typeof toJson === 'function') {
    return mapJsonValue(toJson.call(value), fn, false)
  }

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const maskedKey = fn(key)
    if (Object.hasOwn(result, maskedKey)) {
      throw new Error('two keys of one object mask to the same name')
    }
    // Defined, not assigned, so an own `__proto__` key stays data.
    Object.defineProperty(result, maskedKey, {
      value: mapJsonValue(item, fn, true),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return result
}
