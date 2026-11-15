// @vitest-environment jsdom

import { expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => ({ watching: false, keys: [] as string[] }))

vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>()
  const t = (...args: unknown[]) => {
    if (reads.watching) reads.keys.push(String(args[0]))
    return Reflect.apply(actual.t, undefined, args)
  }
  return { ...actual, t }
})

it('reads no catalog text while the Config page and the tour steps load', async () => {
  reads.watching = true
  await import('@/pages/config')
  await import('@/lib/product-tour-steps')
  reads.watching = false

  expect(reads.keys.join(', ')).toBe('')
})
