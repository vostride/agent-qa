// Degrades to the configured default in a git-less directory; it never imports safety-local.

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { slugBranch } from '@vostride/agent-qa-schema'

// Preserve runner-local's public surface while schema owns the ONE pure sanitizer.
export { slugBranch }

const HEAD_REF_RE = /^ref:\s*refs\/heads\/(.+?)\s*$/m
const GITDIR_RE = /^gitdir:\s*(.+)$/m

export interface ResolvedBranch {
  /** The branch the run is on; falls back to defaultBranch when undetectable. */
  currentBranch: string
  /** The remote default branch; falls back to the configured default -> main. */
  defaultBranch: string
}

export interface BranchResolverOptions {
  /** Directory to resolve git state from (default process.cwd()). */
  cwd?: string
  /** Configured default branch, used when the remote default is undetectable. */
  configuredDefault?: string
  /** Injected .git/HEAD reader — returns raw file content or null. */
  readHead?: (cwd: string) => string | null
  /** Injected `git symbolic-ref refs/remotes/origin/HEAD` reader — raw or null. */
  runSymbolicRef?: (cwd: string) => string | null
}

/**
 * Resolve the current + default branch names. Both are returned raw (un-slugged);
 * the fs store slugs each before it becomes a path segment. Never throws.
 */
export function resolveBranch(opts: BranchResolverOptions = {}): ResolvedBranch {
  const cwd = opts.cwd ?? process.cwd()
  const readHead = opts.readHead ?? defaultReadHead
  const runSymbolicRef = opts.runSymbolicRef ?? defaultRunSymbolicRef

  const defaultBranch =
    parseSymbolicRef(safe(() => runSymbolicRef(cwd))) ?? opts.configuredDefault ?? 'main'
  const currentBranch = parseHeadBranch(safe(() => readHead(cwd))) ?? defaultBranch

  return { currentBranch, defaultBranch }
}

function parseHeadBranch(head: string | null): string | null {
  if (head === null) return null
  const match = HEAD_REF_RE.exec(head)
  return match ? match[1] : null // detached HEAD (a raw sha) yields null
}

function parseSymbolicRef(output: string | null): string | null {
  if (output === null) return null
  const trimmed = output.trim()
  if (trimmed === '') return null
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return name.length > 0 ? name : null
}

function defaultReadHead(cwd: string): string | null {
  try {
    const gitPath = join(cwd, '.git')
    const stat = statSync(gitPath)
    if (stat.isDirectory()) {
      return readFileSync(join(gitPath, 'HEAD'), 'utf-8')
    }
    // .git is a file (submodule / worktree): `gitdir: <path>`.
    const pointer = readFileSync(gitPath, 'utf-8')
    const match = GITDIR_RE.exec(pointer)
    if (match === null) return null
    const gitdir = resolve(cwd, match[1].trim())
    return readFileSync(join(gitdir, 'HEAD'), 'utf-8')
  } catch {
    return null
  }
}

/** Default git ABI: the 5s bound below caps the synchronous subprocess. */
const DEFAULT_GIT_SYMBOLIC_REF_TIMEOUT_MS = 5000

type GitExec = (
  command: string,
  args: string[],
  options: {
    cwd: string
    encoding: 'utf-8'
    stdio: ['ignore', 'pipe', 'ignore']
    timeout: number
  },
) => string

interface RunGitSymbolicRefOptions {
  /** Bound (ms) on the synchronous git subprocess; ETIMEDOUT degrades to null. */
  timeoutMs?: number
  /** Injected exec seam for tests — defaults to node:child_process execFileSync. */
  exec?: GitExec
}

// A finite timeout so the subprocess never wedges branch resolution; any failure answers `null`.
export function runGitSymbolicRef(
  cwd: string,
  options: RunGitSymbolicRefOptions = {},
): string | null {
  const exec = options.exec ?? (execFileSync as unknown as GitExec)
  const timeout = options.timeoutMs ?? DEFAULT_GIT_SYMBOLIC_REF_TIMEOUT_MS
  try {
    return exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
    })
  } catch {
    return null
  }
}

function defaultRunSymbolicRef(cwd: string): string | null {
  return runGitSymbolicRef(cwd)
}

function safe(read: () => string | null): string | null {
  try {
    return read()
  } catch {
    return null
  }
}
