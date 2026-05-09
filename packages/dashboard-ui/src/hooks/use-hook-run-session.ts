import { useEffect, useMemo, useRef, useState } from 'react'

import {
  ApiError,
  fetchVariables,
  runHook,
  type HookRunOverride,
  type HookRunResponse,
} from '@/lib/api'

export interface HookRunOverrideRow {
  id: string
  key: string
  value: string
}

export interface HookRunRecord {
  id: string
  result: HookRunResponse
  overrideSnapshot: Record<string, string>
}

interface HookRunSessionOptions {
  hookId: string
}

function createOverrideRow(partial: Partial<HookRunOverrideRow> = {}): HookRunOverrideRow {
  return {
    id: `override-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    key: partial.key ?? '',
    value: partial.value ?? '',
  }
}

function normalizeOverrides(rows: HookRunOverrideRow[]): HookRunOverride[] {
  return rows
    .map((row) => ({
      key: row.key.trim(),
      value: row.value,
    }))
    .filter((row) => row.key.length > 0)
}

export function useHookRunSession({ hookId }: HookRunSessionOptions) {
  const [baselineVariables, setBaselineVariables] = useState<Array<{ key: string; value: string }>>([])
  const [baselineFilePath, setBaselineFilePath] = useState<string | null>(null)
  const [baselineInfo, setBaselineInfo] = useState<string | null>(null)
  const [isBaselineLoading, setIsBaselineLoading] = useState(true)
  const [overrideRows, setOverrideRows] = useState<HookRunOverrideRow[]>([])
  const [recentRuns, setRecentRuns] = useState<HookRunRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const runCounterRef = useRef(0)

  useEffect(() => {
    setOverrideRows([])
    setRecentRuns([])
    setSelectedRunId(null)
    setRunError(null)
  }, [hookId])

  useEffect(() => {
    let cancelled = false

    setIsBaselineLoading(true)
    fetchVariables()
      .then((response) => {
        if (cancelled) return
        setBaselineVariables(response.variables)
        setBaselineFilePath(response.filePath)
        setBaselineInfo(response.error ?? null)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setBaselineVariables([])
        setBaselineFilePath(null)
        setBaselineInfo(error instanceof Error ? error.message : 'Failed to load workspace variables')
      })
      .finally(() => {
        if (!cancelled) {
          setIsBaselineLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [hookId])

  const baselineKeySet = useMemo(
    () => new Set(baselineVariables.map((variable) => variable.key)),
    [baselineVariables],
  )

  const normalizedOverrides = useMemo(
    () => normalizeOverrides(overrideRows),
    [overrideRows],
  )

  const overridingRowIds = useMemo(() => {
    const next = new Set<string>()
    for (const row of overrideRows) {
      const trimmedKey = row.key.trim()
      if (trimmedKey && baselineKeySet.has(trimmedKey)) {
        next.add(row.id)
      }
    }
    return next
  }, [baselineKeySet, overrideRows])

  const selectedRun = useMemo(
    () => recentRuns.find((run) => run.id === selectedRunId) ?? recentRuns[0] ?? null,
    [recentRuns, selectedRunId],
  )

  function addOverrideRow(partial: Partial<HookRunOverrideRow> = {}) {
    setOverrideRows((current) => [...current, createOverrideRow(partial)])
  }

  function updateOverrideRow(rowId: string, patch: Partial<Pick<HookRunOverrideRow, 'key' | 'value'>>) {
    setOverrideRows((current) =>
      current.map((row) => (row.id === rowId ? { ...row, ...patch } : row)),
    )
  }

  function removeOverrideRow(rowId: string) {
    setOverrideRows((current) => current.filter((row) => row.id !== rowId))
  }

  async function submitRun() {
    if (!hookId || isRunning) return null

    setIsRunning(true)
    setRunError(null)

    const overrideSnapshot = Object.fromEntries(
      normalizedOverrides.map((row) => [row.key, row.value]),
    )

    try {
      const result = await runHook(hookId, { overrides: normalizedOverrides })
      runCounterRef.current += 1
      const nextRecord: HookRunRecord = {
        id: `hook-run-${runCounterRef.current}`,
        result,
        overrideSnapshot,
      }

      setRecentRuns((current) => [nextRecord, ...current].slice(0, 6))
      setSelectedRunId(nextRecord.id)
      return nextRecord
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        setRunError(error.message)
      } else {
        setRunError(error instanceof Error ? error.message : 'Hook run failed')
      }
      return null
    } finally {
      setIsRunning(false)
    }
  }

  return {
    baselineVariables,
    baselineFilePath,
    baselineInfo,
    isBaselineLoading,
    overrideRows,
    normalizedOverrides,
    overridingRowIds,
    recentRuns,
    selectedRunId,
    selectedRun,
    isRunning,
    runError,
    addOverrideRow,
    updateOverrideRow,
    removeOverrideRow,
    selectRun: setSelectedRunId,
    clearRunError: () => setRunError(null),
    submitRun,
  }
}
