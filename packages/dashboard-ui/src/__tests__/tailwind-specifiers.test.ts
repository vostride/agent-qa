// Tailwind releases the compiler and its Vite plugin in lockstep, so a lockfile refresh moves both.

import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

const manifest: { devDependencies?: Record<string, string> } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
)

it('declares tailwindcss and @tailwindcss/vite with one specifier', () => {
  const compiler = manifest.devDependencies?.tailwindcss
  expect(compiler).toBeDefined()
  expect(manifest.devDependencies?.['@tailwindcss/vite']).toBe(compiler)
})
