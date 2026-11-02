// Lease-guard sections on two threads create and remove `memory/queue/` around each other.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  KnowledgeRootContainmentError,
  assertWithinKnowledgeRoot,
} from '../knowledge-containment.js'

const raced = vi.hoisted(() => ({
  aroundResolve: new Map<string, { before: () => void; after?: () => void }>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  function realpathSync(
    ...args: Parameters<typeof actual.realpathSync>
  ): ReturnType<typeof actual.realpathSync> {
    const [path] = args
    const around = typeof path === 'string' ? raced.aroundResolve.get(path) : undefined
    if (around === undefined) return actual.realpathSync(...args)
    raced.aroundResolve.delete(String(path))
    around.before()
    try {
      return actual.realpathSync(...args)
    } finally {
      around.after?.()
    }
  }
  return { ...actual, default: { ...actual, realpathSync }, realpathSync }
})

describe('the knowledge-root containment check under directories another section removes', () => {
  let knowledgeRoot: string

  beforeEach(() => {
    knowledgeRoot = mkdtempSync(join(tmpdir(), 'knowledge-containment-'))
    raced.aroundResolve.clear()
  })

  afterEach(() => {
    rmSync(knowledgeRoot, { recursive: true, force: true })
  })

  it('treats a directory removed between being read and being resolved as absent', () => {
    const memory = join(knowledgeRoot, 'memory')
    mkdirSync(join(memory, 'queue'), { recursive: true })
    raced.aroundResolve.set(memory, { before: () => rmSync(memory, { recursive: true }) })

    expect(() => assertWithinKnowledgeRoot(knowledgeRoot, join(memory, 'queue'))).not.toThrow()
  })

  it('resolves again a directory removed and made again between being read and being resolved', () => {
    const memory = join(knowledgeRoot, 'memory')
    mkdirSync(join(memory, 'queue'), { recursive: true })
    raced.aroundResolve.set(memory, {
      before: () => rmSync(memory, { recursive: true }),
      after: () => mkdirSync(memory),
    })

    expect(() => assertWithinKnowledgeRoot(knowledgeRoot, join(memory, 'queue'))).not.toThrow()
  })

  it('still refuses a link that resolves nowhere', () => {
    const memory = join(knowledgeRoot, 'memory')
    symlinkSync(join(knowledgeRoot, 'missing'), memory, 'dir')

    expect(() => assertWithinKnowledgeRoot(knowledgeRoot, join(memory, 'queue'))).toThrow(
      new KnowledgeRootContainmentError(memory, undefined, knowledgeRoot),
    )
  })
})
