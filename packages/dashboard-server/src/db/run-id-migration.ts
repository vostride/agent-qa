import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { isCanonicalRunId } from '@vostride/agent-qa-ids'
import { createBetterSqlite3Database, generateRunId, type BetterSqlite3Database } from '@vostride/agent-qa-core'

interface RunIdMigrationRunRow {
  id: string
  parent_run_id: string | null
  video_path: string | null
}

interface RunIdMigrationStepRow {
  id: string
  screenshot_path: string | null
  screenshot_before_path: string | null
  healing_screenshot_paths: string | null
}

interface FlatVideoFileMove {
  fromPath: string
  toPath: string
}

export interface RunIdMigrationOptions {
  dbPath: string
  screenshotsDir?: string
  videosDir?: string
  logger?: (message: string) => void
}

export interface RunIdMigrationResult {
  migratedRunCount: number
  totalRunCount: number
  runIdMap: Record<string, string>
  preservedRunIds: string[]
  updatedScreenshotRows: number
  updatedVideoRows: number
  renamedScreenshotDirs: Array<{ from: string; to: string }>
  renamedVideoDirs: Array<{ from: string; to: string }>
  missingArtifacts: string[]
}

function rewriteArtifactPath(
  value: string | null,
  mapping: Map<string, string>,
  rootDir?: string,
  apiPrefix?: '/api/screenshots/' | '/api/videos/',
): string | null {
  if (!value) return value
  const trimmed = value.trim()
  if (!trimmed) return value

  let relativePath: string
  let mode: 'relative' | 'absolute' | 'api' = 'relative'

  if (apiPrefix && trimmed.startsWith(apiPrefix)) {
    relativePath = trimmed.slice(apiPrefix.length)
    mode = 'api'
  } else if (rootDir && isAbsolute(trimmed)) {
    const resolvedRoot = resolve(rootDir)
    const resolvedValue = resolve(trimmed)
    const insideRoot = relative(resolvedRoot, resolvedValue)
    if (!insideRoot || insideRoot.startsWith('..') || isAbsolute(insideRoot)) {
      return value
    }
    relativePath = insideRoot
    mode = 'absolute'
  } else {
    relativePath = trimmed
  }

  const segments = relativePath.split(/[\\/]+/).filter(Boolean)
  if (segments.length === 0) return value

  const nextHead = mapping.get(segments[0])
  if (!nextHead) return value

  const rewrittenRelative = [nextHead, ...segments.slice(1)].join('/')
  if (mode === 'api' && apiPrefix) return `${apiPrefix}${rewrittenRelative}`
  if (mode === 'absolute' && rootDir) return resolve(rootDir, rewrittenRelative)
  return rewrittenRelative
}

function rewriteJsonStringArray(
  value: string | null,
  mapping: Map<string, string>,
  rootDir?: string,
  apiPrefix?: '/api/screenshots/' | '/api/videos/',
): string | null {
  if (!value) return value
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return value
    let changed = false
    const rewritten = parsed.map((entry) => {
      if (typeof entry !== 'string') return entry
      const nextValue = rewriteArtifactPath(entry, mapping, rootDir, apiPrefix)
      if (nextValue !== entry) changed = true
      return nextValue
    })
    return changed ? JSON.stringify(rewritten) : value
  } catch {
    return value
  }
}

function getRelativeArtifactPath(
  value: string,
  rootDir: string,
  apiPrefix: '/api/screenshots/' | '/api/videos/',
): { relativePath: string; sourcePath: string } | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const resolvedRoot = resolve(rootDir)

  if (trimmed.startsWith(apiPrefix)) {
    const relativePath = trimmed.slice(apiPrefix.length)
    const sourcePath = resolve(resolvedRoot, relativePath)
    const insideRoot = relative(resolvedRoot, sourcePath)
    if (!insideRoot || insideRoot.startsWith('..') || isAbsolute(insideRoot)) return null
    return { relativePath: insideRoot, sourcePath }
  }

  if (isAbsolute(trimmed)) {
    const sourcePath = resolve(trimmed)
    const relativePath = relative(resolvedRoot, sourcePath)
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return null
    return { relativePath, sourcePath }
  }

  const sourcePath = resolve(resolvedRoot, trimmed)
  const relativePath = relative(resolvedRoot, sourcePath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return null
  return { relativePath, sourcePath }
}

function rewriteRunVideoPath(
  run: RunIdMigrationRunRow,
  mapping: Map<string, string>,
  videosDir: string | undefined,
  flatVideoFileMoves: FlatVideoFileMove[],
): string | null {
  const nextVideoPath = rewriteArtifactPath(run.video_path, mapping, videosDir, '/api/videos/')
  if (nextVideoPath !== run.video_path) return nextVideoPath
  if (!run.video_path || !videosDir) return run.video_path

  const newRunId = mapping.get(run.id)
  if (!newRunId) return run.video_path

  const artifact = getRelativeArtifactPath(run.video_path, videosDir, '/api/videos/')
  if (!artifact) return run.video_path

  const segments = artifact.relativePath.split(/[\\/]+/).filter(Boolean)
  if (segments.length !== 1) return run.video_path

  const fileName = basename(segments[0])
  if (!fileName) return run.video_path

  const rewrittenRelative = `${newRunId}/${fileName}`
  flatVideoFileMoves.push({
    fromPath: artifact.sourcePath,
    toPath: resolve(videosDir, rewrittenRelative),
  })
  return rewrittenRelative
}

async function renameDirectoryIfPresent(
  fromPath: string,
  toPath: string,
  renamed: Array<{ from: string; to: string }>,
  missingArtifacts: string[],
  logger?: (message: string) => void,
): Promise<void> {
  try {
    const info = await stat(fromPath)
    if (!info.isDirectory()) return
    await mkdir(dirname(toPath), { recursive: true })
    await rename(fromPath, toPath)
    renamed.push({ from: fromPath, to: toPath })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      missingArtifacts.push(fromPath)
      return
    }
    logger?.(`Skipping artifact rename ${fromPath} -> ${toPath}: ${String(error)}`)
  }
}

async function moveFileIfPresent(
  fromPath: string,
  toPath: string,
  missingArtifacts: string[],
  logger?: (message: string) => void,
): Promise<void> {
  try {
    const info = await stat(fromPath)
    if (!info.isFile()) return
    await mkdir(dirname(toPath), { recursive: true })
    try {
      await rename(fromPath, toPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        await copyFile(fromPath, toPath)
        await unlink(fromPath)
        return
      }
      throw error
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      missingArtifacts.push(fromPath)
      return
    }
    logger?.(`Skipping artifact move ${fromPath} -> ${toPath}: ${String(error)}`)
  }
}

function buildRunIdMap(runIds: string[]): Map<string, string> {
  const mapping = new Map<string, string>()
  const assignedIds = new Set(runIds)

  for (const runId of runIds) {
    if (isCanonicalRunId(runId)) continue

    let nextId = generateRunId()
    while (assignedIds.has(nextId) || mappingHasValue(mapping, nextId)) {
      nextId = generateRunId()
    }
    mapping.set(runId, nextId)
    assignedIds.add(nextId)
  }

  return mapping
}

function mappingHasValue(mapping: Map<string, string>, value: string): boolean {
  for (const mappedValue of mapping.values()) {
    if (mappedValue === value) return true
  }
  return false
}

function runForeignKeyCheck(db: BetterSqlite3Database): void {
  const violations = db.pragma('foreign_key_check') as Array<Record<string, unknown>>
  if (violations.length === 0) return
  throw new Error(`Run-id migration left ${violations.length} foreign key violation(s)`)
}

export async function migrateWorkspaceRunIds({
  dbPath,
  screenshotsDir,
  videosDir,
  logger,
}: RunIdMigrationOptions): Promise<RunIdMigrationResult> {
  const db = createBetterSqlite3Database(dbPath)
  const renamedScreenshotDirs: Array<{ from: string; to: string }> = []
  const renamedVideoDirs: Array<{ from: string; to: string }> = []
  const flatVideoFileMoves: FlatVideoFileMove[] = []
  const missingArtifacts: string[] = []

  try {
    const runs = db.prepare('SELECT id, parent_run_id, video_path FROM runs ORDER BY rowid ASC').all() as RunIdMigrationRunRow[]
    const steps = db.prepare('SELECT id, screenshot_path, screenshot_before_path, healing_screenshot_paths FROM steps ORDER BY rowid ASC').all() as RunIdMigrationStepRow[]
    const mapping = buildRunIdMap(runs.map((run) => run.id))

    if (mapping.size === 0) {
      return {
        migratedRunCount: 0,
        totalRunCount: runs.length,
        runIdMap: {},
        preservedRunIds: runs.map((run) => run.id),
        updatedScreenshotRows: 0,
        updatedVideoRows: 0,
        renamedScreenshotDirs,
        renamedVideoDirs,
        missingArtifacts,
      }
    }

    const updateStepsRunId = db.prepare('UPDATE steps SET run_id = ? WHERE run_id = ?')
    const updateLogsRunId = db.prepare('UPDATE logs SET run_id = ? WHERE run_id = ?')
    const updateExecutionLogsRunId = db.prepare('UPDATE execution_logs SET run_id = ? WHERE run_id = ?')
    const updateRunsParentId = db.prepare('UPDATE runs SET parent_run_id = ? WHERE parent_run_id = ?')
    const updateRunId = db.prepare('UPDATE runs SET id = ? WHERE id = ?')
    const updateStepArtifacts = db.prepare(`
      UPDATE steps
      SET screenshot_path = ?, screenshot_before_path = ?, healing_screenshot_paths = ?
      WHERE id = ?
    `)
    const updateRunVideoPath = db.prepare('UPDATE runs SET video_path = ? WHERE id = ?')

    let updatedScreenshotRows = 0
    let updatedVideoRows = 0

    db.pragma('foreign_keys = OFF')
    const migrate = db.transaction(() => {
      for (const step of steps) {
        const nextScreenshotPath = rewriteArtifactPath(step.screenshot_path, mapping, screenshotsDir, '/api/screenshots/')
        const nextScreenshotBeforePath = rewriteArtifactPath(step.screenshot_before_path, mapping, screenshotsDir, '/api/screenshots/')
        const nextHealingScreenshotPaths = rewriteJsonStringArray(step.healing_screenshot_paths, mapping, screenshotsDir, '/api/screenshots/')

        if (
          nextScreenshotPath !== step.screenshot_path
          || nextScreenshotBeforePath !== step.screenshot_before_path
          || nextHealingScreenshotPaths !== step.healing_screenshot_paths
        ) {
          updateStepArtifacts.run(
            nextScreenshotPath,
            nextScreenshotBeforePath,
            nextHealingScreenshotPaths,
            step.id,
          )
          updatedScreenshotRows += 1
        }
      }

      for (const run of runs) {
        const nextVideoPath = rewriteRunVideoPath(run, mapping, videosDir, flatVideoFileMoves)
        if (nextVideoPath !== run.video_path) {
          updateRunVideoPath.run(nextVideoPath, run.id)
          updatedVideoRows += 1
        }
      }

      for (const [oldId, newId] of mapping) {
        updateStepsRunId.run(newId, oldId)
        updateLogsRunId.run(newId, oldId)
        updateExecutionLogsRunId.run(newId, oldId)
        updateRunsParentId.run(newId, oldId)
      }

      for (const [oldId, newId] of mapping) {
        updateRunId.run(newId, oldId)
      }

      runForeignKeyCheck(db)
    })

    migrate()
    db.pragma('foreign_keys = ON')

    if (screenshotsDir) {
      for (const [oldId, newId] of mapping) {
        await renameDirectoryIfPresent(
          resolve(screenshotsDir, oldId),
          resolve(screenshotsDir, newId),
          renamedScreenshotDirs,
          missingArtifacts,
          logger,
        )
      }

    }

    if (videosDir) {
      for (const [oldId, newId] of mapping) {
        await renameDirectoryIfPresent(
          resolve(videosDir, oldId),
          resolve(videosDir, newId),
          renamedVideoDirs,
          missingArtifacts,
          logger,
        )
      }

      for (const move of flatVideoFileMoves) {
        await moveFileIfPresent(move.fromPath, move.toPath, missingArtifacts, logger)
      }
    }

    return {
      migratedRunCount: mapping.size,
      totalRunCount: runs.length,
      runIdMap: Object.fromEntries(mapping),
      preservedRunIds: runs.filter((run) => !mapping.has(run.id)).map((run) => run.id),
      updatedScreenshotRows,
      updatedVideoRows,
      renamedScreenshotDirs,
      renamedVideoDirs,
      missingArtifacts,
    }
  } finally {
    db.close()
  }
}
