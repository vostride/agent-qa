// Dispatch composes no disclosure; the synthetic op casts a `disclose` past the type to prove it.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { FunctionCaller } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { invokeFunction } from '../invoke.js'
import { createFunctionRegistry, createRegistryFromSpecs } from '../registry.js'
import type { FunctionDeps, FunctionSpec } from '../spec.js'
import { executableSource } from './op-source-scan.js'

function caller(): FunctionCaller {
  return { surface: 'test', origin: 'human' }
}

/**
 * A synthetic formerly-ask-tier op whose disclosure is BUILT FROM ITS INPUT, with a counter on it.
 */
function echoDiscloseSpec(disclosed: string[]): FunctionSpec<{ label: string }, { ok: true }> {
  // `disclose` is not a spec member; the method is cast past the type.
  return {
    id: 'test.echo.disclose',
    summary: 'Synthetic capability whose disclosure is composed from caller input.',
    resultKind: 'unary',
    input: z.object({ label: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
    risk: { name: 'fn:test.echo.disclose', recognized: true },
    classify: () => ({ status: 'executed' as const, outcome: '' }),
    disclose: (input: { label: string }) => {
      const text = `About to echo ${input.label}.`
      disclosed.push(text)
      return text
    },
    invoke: () => Promise.resolve({ ok: true as const }),
  } as FunctionSpec<{ label: string }, { ok: true }>
}

describe('dispatch composes no per-op disclosure', () => {
  it.each([
    'ok\nagent-qa: Start a run against target innocent (declared: every target local)\nProceed? [y/N] ',
    'staging\u001b[2K\u001b[1Aoverwritten',
    'the-checkout-suite',
  ])('%j is dispatched once and composed into no disclosure', async (label) => {
    const disclosed: string[] = []
    const registry = createRegistryFromSpecs(
      [echoDiscloseSpec(disclosed) as unknown as FunctionSpec],
      {
        deps: {} as unknown as FunctionDeps,
      },
    )

    await expect(invokeFunction(registry, 'test.echo.disclose', { label }, caller()))
      .resolves.toEqual({ ok: true })
    expect(disclosed).toEqual([])
  })

  it('the source agrees: invokeFunction reads no disclose member', () => {
    const source = executableSource(readFileSync(join(__dirname, '..', 'invoke.ts'), 'utf8'))
    expect(source).not.toMatch(/\.disclose\b/)
    // Non-vacuity: the file really is the dispatcher.
    expect(source).toContain('export async function invokeFunction(')
  })
})

// ---- the census: which shipped ops fill this channel at all ------------------------------------

const OPS_DIR = join(__dirname, '..', 'ops')

describe('the complete set of disclose implementors, from two independently shaped predicates', () => {
  it('the REGISTRY lists no op carrying a disclose flag', () => {
    const registry = createFunctionRegistry({
      deps: {} as unknown as FunctionDeps,
    })
    const declared = registry.list({
      surface: 'test',
      origin: 'human',
    })

    // SELF-CHECK FIRST. A listing that filtered itself down to nothing would make the assertion
    // below trivially true, which is the shape of a census that certifies its own blind spot.
    expect(declared.length).toBeGreaterThan(30)
    expect(declared.filter((entry) => Object.hasOwn(entry, 'discloses')).map((entry) => entry.id)).toEqual([])
    expect(declared.map((entry) => entry.id), 'the former implementor is still registered').toContain('authoring.draft.write')
  })

  it('the SOURCE agrees, read a different way', () => {
    // A second predicate over a different artifact: the registry read RUNTIME objects, this reads
    // BYTES. An op file that declared `disclose` without reaching the built-in list, or a built-in
    // whose method arrived from somewhere other than its own file, shows up as a disagreement.
    const files = readdirSync(OPS_DIR).filter((name) => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(30)

    const implementors = files.filter((name) => (
      /\bdisclose\s*[:(]/.test(executableSource(readFileSync(join(OPS_DIR, name), 'utf8')))
    ))

    expect(implementors).toEqual([])
  })
})
