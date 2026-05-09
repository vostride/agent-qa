import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseObservation, listObservations } from './observation-io.js'
import { scanObservationText } from './security-scanner.js'
import type { SuiteObservation } from './schema.js'
import { createBetterSqlite3Database, type BetterSqlite3Database } from '../sqlite.js'

export interface MemoryIndexParams {
  product: string
  suiteId?: string
  testId: string
  memoryRoot: string
  currentSuiteTests?: Array<{ test: string; id: string }>
  currentPosition?: number
}

function validatePathComponent(value: string): boolean {
  return !/\.\./.test(value) && !/[/\\]/.test(value) && !/\0/.test(value)
}

function suiteSnapshotMatches(
  obsSnapshot: Array<{ test: string; id: string }>,
  currentTests: Array<{ test: string; id: string }>,
): boolean {
  if (obsSnapshot.length !== currentTests.length) return false
  return obsSnapshot.every((entry, i) =>
    entry.test === currentTests[i].test && entry.id === currentTests[i].id
  )
}

export async function buildMemoryIndex(params: MemoryIndexParams): Promise<BetterSqlite3Database | null> {
  try {
    const db = createBetterSqlite3Database(':memory:')
    db.exec(`CREATE VIRTUAL TABLE observations USING fts5(
      title,
      content,
      id UNINDEXED,
      trust UNINDEXED
    )`)

    const insert = db.prepare('INSERT INTO observations(title, content, id, trust) VALUES (?, ?, ?, ?)')

    const dirs: Array<{ path: string; isSuite: boolean }> = []

    if (validatePathComponent(params.product)) {
      dirs.push({ path: join(params.memoryRoot, 'products', params.product), isSuite: false })
    }
    if (params.suiteId && validatePathComponent(params.suiteId)) {
      dirs.push({ path: join(params.memoryRoot, 'suites', params.suiteId), isSuite: true })
    }
    if (validatePathComponent(params.testId)) {
      dirs.push({ path: join(params.memoryRoot, 'tests', params.testId), isSuite: false })
    }

    if (dirs.length === 0) {
      console.warn('[memory-index] All path components failed validation', {
        product: params.product,
        suiteId: params.suiteId,
        testId: params.testId,
      })
      return null
    }

    const insertAll = db.transaction((observations: Array<{ title: string; content: string; id: string; trust: number }>) => {
      for (const obs of observations) {
        insert.run(obs.title, obs.content, obs.id, obs.trust)
      }
    })

    const toInsert: Array<{ title: string; content: string; id: string; trust: number }> = []

    for (const { path: dirPath, isSuite } of dirs) {
      const filenames = await listObservations(dirPath)
      for (const filename of filenames) {
        const filePath = join(dirPath, filename)
        let raw: string
        try {
          raw = await readFile(filePath, 'utf-8')
        } catch {
          continue
        }

        const { data, error } = parseObservation(raw, filename)
        if (!data || error) continue

        if (isSuite && 'position' in data) {
          const suiteObs = data as SuiteObservation
          if (!params.currentSuiteTests || !suiteSnapshotMatches(suiteObs.suite_snapshot, params.currentSuiteTests)) {
            continue
          }
          if (params.currentPosition === undefined || suiteObs.position !== params.currentPosition) {
            continue
          }
        }

        const scanResult = scanObservationText(data.title, data.content)
        if (!scanResult.safe) continue

        toInsert.push({ title: data.title, content: data.content, id: data.id, trust: data.trust })
      }
    }

    insertAll(toInsert)
    return db
  } catch (err) {
    console.error('[memory-index] buildMemoryIndex failed:', err)
    return null
  }
}
