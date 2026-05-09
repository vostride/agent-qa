import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import {
  AgentQaConfigSchema,
  discoverWorkspaceFiles,
  resolveWorkspacePaths,
  type WorkspaceFileRecord,
} from '@vostride/agent-qa-core'
import { parse as parseYaml } from 'yaml'

import type { HookDeleteReference } from './hook-registry-types.js'

const HOOK_INLINE_RE = /\{\{runHook:"([^"]+)"\}\}/g

function getLabel(parsed: unknown, filePath: string): string {
  if (parsed && typeof parsed === 'object' && typeof (parsed as { name?: unknown }).name === 'string') {
    const name = (parsed as { name: string }).name.trim()
    if (name.length > 0) {
      return name
    }
  }

  return basename(filePath)
}

function collectHookListReferences(
  parsed: Record<string, unknown>,
  filePath: string,
  label: string,
  kind: 'test' | 'suite',
  key: 'setup' | 'teardown',
  hookId: string,
): HookDeleteReference[] {
  const entries = parsed[key]
  if (!Array.isArray(entries)) {
    return []
  }

  return entries.flatMap((entry) => {
    if (entry !== hookId) {
      return []
    }

    return [{
      kind,
      label,
      path: filePath,
      context: key,
    }]
  })
}

function collectInlineReferences(
  parsed: Record<string, unknown>,
  filePath: string,
  label: string,
  hookId: string,
): HookDeleteReference[] {
  const steps = parsed.steps
  if (!Array.isArray(steps)) {
    return []
  }

  return steps.flatMap((entry, index) => {
    const text = typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object' && typeof (entry as { step?: unknown }).step === 'string'
        ? (entry as { step: string }).step
        : null

    if (!text) {
      return []
    }

    const matches = [...text.matchAll(HOOK_INLINE_RE)]
    if (!matches.some((match) => match[1] === hookId)) {
      return []
    }

    return [{
      kind: 'inline-runHook',
      label,
      path: filePath,
      context: typeof entry === 'string' ? `steps[${index}]` : `steps[${index}].step`,
    }]
  })
}

async function scanYamlFile(
  record: WorkspaceFileRecord,
  hookId: string,
): Promise<HookDeleteReference[]> {
  let parsed: unknown

  try {
    parsed = parseYaml(await readFile(record.absolutePath, 'utf-8'))
  } catch {
    return []
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return []
  }

  const parsedRecord = parsed as Record<string, unknown>
  const label = getLabel(parsed, record.workspaceRelativePath)
  const kind = record.kind

  return [
    ...collectHookListReferences(parsedRecord, record.workspaceRelativePath, label, kind, 'setup', hookId),
    ...collectHookListReferences(parsedRecord, record.workspaceRelativePath, label, kind, 'teardown', hookId),
    ...collectInlineReferences(parsedRecord, record.workspaceRelativePath, label, hookId),
  ]
}

function dedupeReferences(references: HookDeleteReference[]): HookDeleteReference[] {
  const seen = new Set<string>()

  return references.filter((reference) => {
    const key = `${reference.kind}:${reference.path}:${reference.context}:${reference.label}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

export async function scanHookReferences(
  _workspaceDir: string,
  configPath: string,
  hookId: string,
): Promise<HookDeleteReference[]> {
  let parsedConfig: unknown

  try {
    parsedConfig = parseYaml(await readFile(configPath, 'utf-8'))
  } catch {
    return []
  }

  const configResult = AgentQaConfigSchema.safeParse(parsedConfig)
  if (!configResult.success) {
    return []
  }

  const workspace = resolveWorkspacePaths({ config: configResult.data, configPath })
  const records = await Promise.all([
    discoverWorkspaceFiles({ workspace, kind: 'test' }),
    discoverWorkspaceFiles({ workspace, kind: 'suite' }),
  ])
  const references = await Promise.all(
    records
      .flat()
      .sort((left, right) => left.workspaceRelativePath.localeCompare(right.workspaceRelativePath))
      .map((record) => scanYamlFile(record, hookId)),
  )

  return dedupeReferences(references.flat()).sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.context.localeCompare(right.context) ||
    left.kind.localeCompare(right.kind) ||
    left.label.localeCompare(right.label),
  )
}
