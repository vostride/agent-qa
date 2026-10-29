import type { LanguageModelMiddleware } from 'ai'

import { mapPromptLeaves } from './map-prompt-leaves'

const TEMPLATE_SPLIT = /(\{\{secret:\w+\}\})/

export function createMaskingMiddleware(mask: (text: string) => string): LanguageModelMiddleware {
  const leaf = (text: string): string => maskKeepingTemplates(text, mask)
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => mapPromptLeaves(params, leaf),
  }
}

// A `{{secret:NAME}}` template passes only where restoring it cannot re-send a declared value.
function maskKeepingTemplates(text: string, mask: (text: string) => string): string {
  const whole = mask(text)
  const parts = text.split(TEMPLATE_SPLIT)
  if (parts.length === 1) return whole
  const masked = parts.map((part) => mask(part))
  // Equal only when no declared value straddles a token edge in the left-to-right whole pass.
  if (masked.join('') !== whole) return whole
  return parts
    .map((part, index) =>
      index % 2 === 1 && keepsTemplate(parts, index, mask) ? part : masked[index]!,
    )
    .join('')
}

function keepsTemplate(
  parts: readonly string[],
  index: number,
  mask: (text: string) => string,
): boolean {
  const token = parts[index]!
  const name = token.slice('{{secret:'.length, -'}}'.length)
  const alone = mask(token)
  if (alone !== token && alone !== `[secret:${name}]`) return false
  // Every proper substring of the token lies in one of the two cuts, so the mask sees values in it.
  const head = token.slice(0, -1)
  const tail = token.slice(1)
  if (mask(head) !== head || mask(tail) !== tail) return false
  const before = parts.slice(0, index).join('')
  const after = parts.slice(index + 1).join('')
  return (
    mask(before + head) === mask(before) + mask(head)
    && mask(tail + after) === mask(tail) + mask(after)
  )
}
