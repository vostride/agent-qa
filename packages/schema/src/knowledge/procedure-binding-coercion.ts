import type { ProcedureParamType } from './curator-tier'

/**
 * The ONE typed coercion law shared by the loop binder and capability computation.
 *
 * The runner's bindProcedureParam produces bound values through this function, and
 * procedureSourceBinding derives the capability bits that cross the reader port from it —
 * one function evaluated on the same raw value, so an input the binder would reject can
 * never be classified fillable for that type. Any binder coercion change lands HERE.
 *
 * Laws (deliberately pinned): nullish raw is absence for every type; 'string' is String(raw);
 * 'number' is the mechanical Number(raw) admitting only finite results ('' binds 0, no bespoke
 * emptiness carve-out); 'boolean' admits only true/false and the exact lowercase 'true'/'false'
 * strings. Secret parameters never coerce — they bind as secret-store templates only.
 */
export function coerceProcedureBindingValue(
  type: Exclude<ProcedureParamType, 'secret'>,
  raw: unknown,
): string | number | boolean | undefined {
  if (raw === null || raw === undefined) return undefined
  if (type === 'string') return String(raw)
  if (type === 'number') {
    const number = Number(raw)
    return Number.isFinite(number) ? number : undefined
  }
  if (raw === true || raw === false) return raw
  if (raw === 'true') return true
  if (raw === 'false') return false
  return undefined
}

// A name and capability bits, never a value; presence alone means a string can bind.
export interface ProcedureSourceBinding {
  readonly name: string
  readonly canBindNumber: boolean
  readonly canBindBoolean: boolean
}

/**
 * The sanitizer that keeps values loop-side: raw value in, name + capability bits out.
 * Nullish raw values are absence in every source — the name is simply not listed.
 */
export function procedureSourceBinding(
  name: string,
  raw: unknown,
): ProcedureSourceBinding | undefined {
  if (raw === null || raw === undefined) return undefined
  return {
    name,
    canBindNumber: coerceProcedureBindingValue('number', raw) !== undefined,
    canBindBoolean: coerceProcedureBindingValue('boolean', raw) !== undefined,
  }
}
