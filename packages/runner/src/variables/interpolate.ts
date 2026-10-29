// Runner-owned step-text interpolation. Moved 1:1 from
// core/src/agent/variables.ts — env-pattern-only replacement, per-pattern unresolved
// messages, and bare-variable detection. Semantics preserved exactly; the
// {{secret:...}} template is deliberately SKIPPED here (resolved separately through
// the runner secrets helper), never leaking a raw secret into interpolated text.
import type { InterpolatedVariable } from '@vostride/agent-qa-schema'
import type { VariableStore } from './store.js'

export interface InterpolationWithProvenance {
  text: string
  /**
   * The bindings that actually resolved, one entry per DISTINCT name in first-occurrence
   * order. Unresolved patterns and the skipped `{{secret:...}}` template contribute
   * nothing. Values are recorded VERBATIM — see the masking prohibition on
   * `StepEvidence.interpolatedVariables` (masking here would break the emit fold's
   * exact-match classification and reintroduce G-381-3).
   */
  substitutions: InterpolatedVariable[]
}

/**
 * The single replacement implementation. Produces byte-identical
 * text to the historical `interpolateVariables` while reporting WHICH binding names
 * produced it, so the name survives the pre-planning interpolation seam into StepEvidence.
 */
export function interpolateVariablesWithProvenance(
  template: string,
  store: VariableStore,
): InterpolationWithProvenance {
  const seen = new Map<string, string>()
  const text = template.replace(/\{\{env:(\w+)\}\}/g, (_match, varName: string) => {
    const value = store.get(varName)
    if (value !== undefined) {
      if (!seen.has(varName)) seen.set(varName, value)
      return value
    }
    return _match
  })
  return {
    text,
    substitutions: [...seen].map(([name, value]) => ({ name, value })),
  }
}

export function interpolateVariables(template: string, store: VariableStore): string {
  return interpolateVariablesWithProvenance(template, store).text
}

interface UnresolvedTemplate {
  pattern: string
  message: string
}

export function findUnresolvedTemplates(text: string): UnresolvedTemplate[] {
  const results: UnresolvedTemplate[] = []
  const re = /\{\{[^}]*\}\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const pattern = match[0]
    const inner = pattern.slice(2, -2)
    let message: string
    if (/^env:\w+$/.test(inner)) {
      const varName = inner.slice(4)
      message = `variable '${varName}' not set. Set it in .env, via --var, or setVariable action.`
    } else if (/^secret:\w+$/.test(inner)) {
      continue
    } else if (/^capture:\w+$/.test(inner)) {
      const varName = inner.slice(8)
      message = `'capture:' syntax is not supported. Use {{env:${varName}}} instead.`
    } else if (/^hook:\w+$/.test(inner)) {
      message = `unknown syntax. Did you mean {{runHook:"h_hook-id"}}?`
    } else if (/^runJS:/.test(inner)) {
      message = `runJS failed to resolve. Check browser page availability.`
    } else {
      message = `unknown template syntax.`
    }
    results.push({ pattern, message })
  }
  return results
}

const BARE_VARIABLE_RE = /\{\{(\w+)\}\}/g

export function findBareVariables(text: string): string[] {
  const bare: string[] = []
  let m: RegExpExecArray | null
  BARE_VARIABLE_RE.lastIndex = 0
  while ((m = BARE_VARIABLE_RE.exec(text)) !== null) {
    bare.push(m[1])
  }
  return bare
}
