import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { leftoverLocalFileRefusal } from '../leftover-local-file.js'

const MESSAGE =
  'agent-qa.local.yaml is no longer read: describe each device under registry.devices with model and os (id pins one unit), and set app.path on the target. Delete the file.'

const PLANTED_KEY = 'bs-access-key-7f3c9a1e5d'

let root: string
let configDir: string
let workingDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-qa-leftover-local-'))
  configDir = join(root, 'project')
  workingDir = join(root, 'cwd')
  mkdirSync(configDir)
  mkdirSync(workingDir)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function seedLocalFile(dir: string): string {
  const path = join(dir, 'agent-qa.local.yaml')
  writeFileSync(path, `providers:\n  browserstack:\n    accessKey: ${PLANTED_KEY}\n`)
  return path
}

describe('a leftover agent-qa.local.yaml', () => {
  it('is not refused when neither directory holds one', () => {
    expect(leftoverLocalFileRefusal([configDir, workingDir])).toBeUndefined()
  })

  it('beside the config is refused with its path and the retirement message', () => {
    const path = seedLocalFile(configDir)
    expect(leftoverLocalFileRefusal([configDir, workingDir])).toBe(`${path}: ${MESSAGE}`)
  })

  it('in the working directory is refused with its path and the retirement message', () => {
    const path = seedLocalFile(workingDir)
    expect(leftoverLocalFileRefusal([configDir, workingDir])).toBe(`${path}: ${MESSAGE}`)
  })

  it('in both places is refused once, naming the first directory checked', () => {
    const besideConfig = seedLocalFile(configDir)
    seedLocalFile(workingDir)
    expect(leftoverLocalFileRefusal([configDir, workingDir])).toBe(`${besideConfig}: ${MESSAGE}`)
  })

  it("never carries the file's content", () => {
    seedLocalFile(configDir)
    const refusal = leftoverLocalFileRefusal([configDir])
    expect(refusal).toBeDefined()
    expect(refusal).not.toContain(PLANTED_KEY)
    expect(refusal).not.toContain('browserstack')
  })
})
