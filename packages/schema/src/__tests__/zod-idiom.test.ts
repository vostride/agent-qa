import { globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sourceFiles = globSync('src/**/*.ts', { cwd: pkgRoot })
  .filter(file => !file.includes('__tests__'))
  .map(file => join(pkgRoot, file))

describe('Zod idiom discipline', () => {
  it('does not use deprecated Zod issue-code compatibility tokens', () => {
    const offenders = sourceFiles.filter(file => /\bZodIssue/.test(readFileSync(file, 'utf8')))

    expect(offenders).toEqual([])
  })
})
