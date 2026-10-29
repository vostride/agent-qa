// Per-product counter with an atomic-rename increment; corrupt or missing state restarts at 1.
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  BuildOrdinalReservationError,
  nextBuildOrdinal,
  reserveBuildOrdinalForProducts,
  BUILD_ORDINALS_FILE,
} from '../build-ordinal.js'

const BUILD_ORDINAL_MODULE_URL = new URL('../build-ordinal.ts', import.meta.url).href

function runOrdinalChild(input: {
  root: string
  operation: 'run' | 'maintenance'
  products: string[]
}): Promise<number> {
  const source = `
    const api = await import(${JSON.stringify(BUILD_ORDINAL_MODULE_URL)});
    const root = process.env.AGENT_QA_ORDINAL_TEST_ROOT;
    const products = JSON.parse(process.env.AGENT_QA_ORDINAL_TEST_PRODUCTS);
    const result = process.env.AGENT_QA_ORDINAL_TEST_OPERATION === 'run'
      ? await api.nextBuildOrdinal({ root, product: products[0] })
      : await api.reserveBuildOrdinalForProducts({ root, products });
    process.stdout.write(String(result));
  `
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '--eval', source],
      {
        env: {
          ...process.env,
          AGENT_QA_ORDINAL_TEST_ROOT: input.root,
          AGENT_QA_ORDINAL_TEST_OPERATION: input.operation,
          AGENT_QA_ORDINAL_TEST_PRODUCTS: JSON.stringify(input.products),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`ordinal child exited ${code}: ${stderr}`))
        return
      }
      resolve(Number(stdout))
    })
  })
}

describe('nextBuildOrdinal', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'build-ordinal-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('first call for a product returns 1 and creates the state file', async () => {
    const first = await nextBuildOrdinal({ root, product: 'web-app' })
    expect(first).toBe(1)
    const files = await readdir(root)
    expect(files).toContain(BUILD_ORDINALS_FILE)
  })

  it('successive calls increment monotonically per product key', async () => {
    expect(await nextBuildOrdinal({ root, product: 'web-app' })).toBe(1)
    expect(await nextBuildOrdinal({ root, product: 'web-app' })).toBe(2)
    expect(await nextBuildOrdinal({ root, product: 'web-app' })).toBe(3)
  })

  it('tracks independent products independently', async () => {
    expect(await nextBuildOrdinal({ root, product: 'web-app' })).toBe(1)
    expect(await nextBuildOrdinal({ root, product: 'ios-app' })).toBe(1)
    expect(await nextBuildOrdinal({ root, product: 'web-app' })).toBe(2)
    expect(await nextBuildOrdinal({ root, product: 'ios-app' })).toBe(2)
  })

  it('starts at 1 only when state is missing and rejects corrupt state', async () => {
    await expect(nextBuildOrdinal({ root, product: 'web-app' })).resolves.toBe(1)
    await writeFile(join(root, BUILD_ORDINALS_FILE), '{ not valid json', 'utf8')
    await expect(nextBuildOrdinal({ root, product: 'web-app' })).rejects.toMatchObject({
      code: 'invalid-state',
      product: 'web-app',
    } satisfies Partial<BuildOrdinalReservationError>)
  })

  it('rejects arrays, invalid values, and non-ENOENT read failures', async () => {
    const file = join(root, BUILD_ORDINALS_FILE)
    await writeFile(file, '[]\n', 'utf8')
    await expect(nextBuildOrdinal({ root, product: 'web-app' })).rejects.toMatchObject({
      code: 'invalid-state',
    } satisfies Partial<BuildOrdinalReservationError>)

    await writeFile(file, '{"web-app":"bad"}\n', 'utf8')
    await expect(nextBuildOrdinal({ root, product: 'web-app' })).rejects.toMatchObject({
      code: 'invalid-counter',
      product: 'web-app',
      value: 'bad',
    } satisfies Partial<BuildOrdinalReservationError>)

    await rm(file)
    await import('node:fs/promises').then(({ mkdir }) => mkdir(file))
    await expect(nextBuildOrdinal({ root, product: 'web-app' })).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })

  it('treats prototype-looking product names as own keys', async () => {
    expect(await nextBuildOrdinal({ root, product: 'constructor' })).toBe(1)
    expect(JSON.parse(await readFile(join(root, BUILD_ORDINALS_FILE), 'utf8'))).toEqual({
      constructor: 1,
    })
  })

  it('writes via a unique durable replacement with no lingering authority files', async () => {
    await nextBuildOrdinal({ root, product: 'web-app' })
    await nextBuildOrdinal({ root, product: 'web-app' })
    const files = await readdir(root)
    expect(files).toEqual([BUILD_ORDINALS_FILE])
  })

  it('serializes concurrent run starts without losing same-product increments', async () => {
    const ordinals = await Promise.all(
      Array.from({ length: 8 }, () => runOrdinalChild({
        root,
        operation: 'run',
        products: ['web-app'],
      })),
    )

    expect([...ordinals].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(JSON.parse(await readFile(join(root, BUILD_ORDINALS_FILE), 'utf8'))).toEqual({
      'web-app': 8,
    })
  })
})

describe('reserveBuildOrdinalForProducts', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'build-ordinal-reservation-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('canonicalizes products and atomically advances every affected axis to one ordinal', async () => {
    await writeFile(
      join(root, BUILD_ORDINALS_FILE),
      `${JSON.stringify({ untouched: 4, web: 7, ios: 11 })}\n`,
      'utf8',
    )
    const prepared: Array<{ products: readonly string[]; ordinal: number }> = []

    const ordinal = await reserveBuildOrdinalForProducts({
      root,
      products: ['web', 'ios', 'web'],
      beforePersist: reservation => prepared.push(reservation),
    })

    expect(ordinal).toBe(12)
    expect(prepared).toEqual([{ products: ['ios', 'web'], ordinal: 12 }])
    await expect(readFile(join(root, BUILD_ORDINALS_FILE), 'utf8')).resolves.toBe(
      `${JSON.stringify({ untouched: 4, web: 12, ios: 12 })}\n`,
    )
    expect((await readdir(root)).some(file => file.endsWith('.tmp'))).toBe(false)
  })

  it('returns an explicit no-op for an empty affected set without creating state', async () => {
    await expect(reserveBuildOrdinalForProducts({ root, products: [] })).resolves.toBeUndefined()
    await expect(readdir(root)).resolves.toEqual([])
  })

  it('refuses missing and exhausted counters without rewriting the original file', async () => {
    const file = join(root, BUILD_ORDINALS_FILE)
    const missingRaw = '{\n  "web": 7,\n  "untouched": 4\n}\n'
    await writeFile(file, missingRaw, 'utf8')

    await expect(
      reserveBuildOrdinalForProducts({ root, products: ['web', 'ios'] }),
    ).rejects.toMatchObject({
      code: 'missing-counter',
      product: 'ios',
    } satisfies Partial<BuildOrdinalReservationError>)
    await expect(readFile(file, 'utf8')).resolves.toBe(missingRaw)
    expect(readdirSync(root).some(entry => entry.endsWith('.tmp'))).toBe(false)

    const exhaustedRaw = `${JSON.stringify({ web: Number.MAX_SAFE_INTEGER })}\n`
    await writeFile(file, exhaustedRaw, 'utf8')
    await expect(
      reserveBuildOrdinalForProducts({ root, products: ['web'] }),
    ).rejects.toMatchObject({
      code: 'counter-exhausted',
      product: 'web',
    } satisfies Partial<BuildOrdinalReservationError>)
    await expect(readFile(file, 'utf8')).resolves.toBe(exhaustedRaw)
    expect(readdirSync(root).some(entry => entry.endsWith('.tmp'))).toBe(false)
  })

  it('runs beforePersist after temp preparation and cleans up on refusal before rename', async () => {
    const file = join(root, BUILD_ORDINALS_FILE)
    const original = '{\n  "web": 7,\n  "ios": 11\n}\n'
    await writeFile(file, original, 'utf8')
    const refusal = new Error('writer authority lost')

    await expect(
      reserveBuildOrdinalForProducts({
        root,
        products: ['web', 'ios'],
        beforePersist: reservation => {
          expect(reservation).toEqual({ products: ['ios', 'web'], ordinal: 12 })
          expect(readFileSync(file, 'utf8')).toBe(original)
          const temporary = readdirSync(root).find((entry) => entry.startsWith(
            `${BUILD_ORDINALS_FILE}.tmp-`,
          ))
          expect(temporary).toBeDefined()
          expect(JSON.parse(readFileSync(join(root, temporary!), 'utf8'))).toEqual({
            web: 12,
            ios: 12,
          })
          throw refusal
        },
      }),
    ).rejects.toBe(refusal)

    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(readdirSync(root)).toEqual([BUILD_ORDINALS_FILE])
  })

  it('serializes a run start against maintenance on the same product', async () => {
    await writeFile(join(root, BUILD_ORDINALS_FILE), '{"web":0}\n', 'utf8')

    const ordinals = await Promise.all([
      runOrdinalChild({ root, operation: 'run', products: ['web'] }),
      runOrdinalChild({ root, operation: 'maintenance', products: ['web'] }),
    ])

    expect([...ordinals].sort((left, right) => left - right)).toEqual([1, 2])
    expect(JSON.parse(await readFile(join(root, BUILD_ORDINALS_FILE), 'utf8'))).toEqual({ web: 2 })
  })

  it('serializes concurrent multi-product maintenance reservations', async () => {
    await writeFile(join(root, BUILD_ORDINALS_FILE), '{"ios":0,"web":0}\n', 'utf8')

    const ordinals = await Promise.all([
      runOrdinalChild({ root, operation: 'maintenance', products: ['ios', 'web'] }),
      runOrdinalChild({ root, operation: 'maintenance', products: ['web', 'ios'] }),
    ])

    expect([...ordinals].sort((left, right) => left - right)).toEqual([1, 2])
    expect(JSON.parse(await readFile(join(root, BUILD_ORDINALS_FILE), 'utf8'))).toEqual({
      ios: 2,
      web: 2,
    })
  })

  it('leaves a durable counter after an immediate child-process exit', async () => {
    await expect(runOrdinalChild({
      root,
      operation: 'run',
      products: ['durable-product'],
    })).resolves.toBe(1)

    expect(readFileSync(join(root, BUILD_ORDINALS_FILE), 'utf8')).toBe(
      '{"durable-product":1}\n',
    )
    expect(readdirSync(root)).toEqual([BUILD_ORDINALS_FILE])
  })
})
