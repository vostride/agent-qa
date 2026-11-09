import { join } from 'node:path'

import pc from 'picocolors'

import { CliRefusal } from '../composition/cli-refusal.js'
import {
  TARGET_GITIGNORE_PROBES,
  upsertManagedGitignoreBlock,
  verifyEffectiveGitignore,
  type InitFileResult,
} from './init-filesystem.js'
import { composeManagedBlock, locateManagedBlock } from './managed-block.js'
import type { ProjectIo } from './project-host.js'
import { buildGitignoreEntries, managedGitignoreContent } from './scaffold-content.js'

// Every row this build has, in menu order.
export const SETUP_ROW_NAMES = ['gitignore'] as const
export type SetupRowName = (typeof SETUP_ROW_NAMES)[number]

export type SetupSelection =
  { kind: 'all' } | { kind: 'none' } | { kind: 'names'; names: SetupRowName[] }

const SETUP_NAMES_HINT = `Use ${[...SETUP_ROW_NAMES, 'all'].join(', ')} or none.`

function isSetupRowName(name: string): name is SetupRowName {
  return (SETUP_ROW_NAMES as readonly string[]).includes(name)
}

export function parseSetupFlag(value: string): SetupSelection {
  const names = value.split(',').map((name) => name.trim())
  for (const name of names) {
    if (name !== 'all' && name !== 'none' && !isSetupRowName(name)) {
      throw new CliRefusal([pc.red(`Unknown setup row "${name}". ${SETUP_NAMES_HINT}`)], 2)
    }
  }
  for (const word of ['all', 'none'] as const) {
    if (!names.includes(word)) continue
    if (names.length > 1) {
      throw new CliRefusal(
        [pc.red(`--setup ${word} cannot be combined with other rows. ${SETUP_NAMES_HINT}`)],
        2,
      )
    }
    return { kind: word }
  }
  return { kind: 'names', names: [...new Set(names.filter(isSetupRowName))] }
}

export interface SetupRowState {
  name: SetupRowName
  shown: boolean
  // Why a row that cannot apply here is left out of the menu.
  hidden?: string
  state: string
  wouldChange: boolean
  prechecked: boolean
}

export interface SetupRowCheckInput {
  projectDir: string
  io: ProjectIo
}

export function checkGitignoreRow({ projectDir, io }: SetupRowCheckInput): SetupRowState {
  const existing = io.readText(join(projectDir, '.gitignore'))
  // A malformed block is refused naming the file a person sees.
  const content = { ...managedGitignoreContent(buildGitignoreEntries()), target: '.gitignore' }
  const text = existing ?? ''
  const wouldChange = composeManagedBlock(text, content) !== text
  const state =
    existing === undefined
      ? 'no .gitignore'
      : !wouldChange
        ? 'current'
        : locateManagedBlock(text, content) === undefined
          ? 'block missing'
          : 'the block was edited'
  return { name: 'gitignore', shown: true, state, wouldChange, prechecked: wouldChange }
}

const CHECKS: Record<SetupRowName, (input: SetupRowCheckInput) => SetupRowState> = {
  gitignore: checkGitignoreRow,
}

export function checkSetupRows(input: SetupRowCheckInput): SetupRowState[] {
  return SETUP_ROW_NAMES.map((name) => CHECKS[name](input))
}

export function setupRowLabel(row: SetupRowState, width: number): string {
  return `${row.name.padEnd(width)}  ${row.state}`
}

export interface SetupRowRun {
  title: string
  run(input: { projectDir: string }): { text: string; files: InitFileResult[] }
}

function runGitignoreRow({ projectDir }: { projectDir: string }): {
  text: string
  files: InitFileResult[]
} {
  const file = upsertManagedGitignoreBlock(join(projectDir, '.gitignore'), buildGitignoreEntries())
  verifyEffectiveGitignore({
    cwd: projectDir,
    label: 'target .gitignore',
    probes: TARGET_GITIGNORE_PROBES,
    written: file.outcome === 'preserved' ? 'nothing' : 'managed-gitignore',
  })
  const text = {
    preserved: "gitignore: init's block is current",
    created: "gitignore: wrote init's block",
    updated: "gitignore: restored init's block",
  }[file.outcome]
  return { text, files: [file] }
}

export const SETUP_ROW_RUNS: Record<SetupRowName, SetupRowRun> = {
  gitignore: { title: "Restoring init's .gitignore block", run: runGitignoreRow },
}
