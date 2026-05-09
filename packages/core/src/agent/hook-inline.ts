import { isCanonicalHookId } from '@vostride/agent-qa-ids'

const RUNHOOK_RE = /\{\{runHook:"([^"]+)"\}\}/g

interface InlineHookCall {
  hookId: string
  fullMatch: string
}

export function parseHookInline(text: string): InlineHookCall[] {
  const calls: InlineHookCall[] = []
  let match: RegExpExecArray | null
  RUNHOOK_RE.lastIndex = 0
  while ((match = RUNHOOK_RE.exec(text)) !== null) {
    if (!isCanonicalHookId(match[1])) continue
    calls.push({ hookId: match[1], fullMatch: match[0] })
  }
  return calls
}

export function stripHookInline(text: string): string {
  return text.replace(RUNHOOK_RE, '').replace(/\s{2,}/g, ' ').trim()
}
