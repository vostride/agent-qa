// 2026-10-18 (444-17, D-12): the browser witness. A run's Chromium is every process whose ancestry
// reaches the run's process and whose command line names a Chromium binary.

import { spawnSync } from 'node:child_process'

const CHROMIUM_COMMAND = /chrome|chromium|headless_shell/iu

interface ProcessEntry {
  readonly pid: number
  readonly ppid: number
  readonly command: string
  readonly zombie: boolean
}

function refuseWithoutPosix(): void {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
}

function processTable(): ProcessEntry[] {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,stat=,command='], { encoding: 'utf8' })
  if (listed.status !== 0) throw new Error(`ps failed: ${listed.stderr}`)
  const entries: ProcessEntry[] = []
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      zombie: match[3]!.startsWith('Z'),
      command: match[4]!,
    })
  }
  return entries
}

export function chromiumDescendants(pid: number): number[] {
  refuseWithoutPosix()
  const children = new Map<number, ProcessEntry[]>()
  for (const entry of processTable()) {
    if (entry.zombie) continue
    children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry])
  }
  const found: number[] = []
  const walk = (at: number): void => {
    for (const child of children.get(at) ?? []) {
      if (CHROMIUM_COMMAND.test(child.command)) found.push(child.pid)
      walk(child.pid)
    }
  }
  walk(pid)
  return found.sort((a, b) => a - b)
}

export function livePids(pids: readonly number[]): number[] {
  refuseWithoutPosix()
  const alive = new Set(processTable().filter((entry) => !entry.zombie).map((entry) => entry.pid))
  return pids.filter((pid) => alive.has(pid))
}

export async function livePidsAfter(pids: readonly number[], budgetMs: number): Promise<number[]> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const alive = livePids(pids)
    if (alive.length === 0 || Date.now() >= deadline) return alive
    await new Promise((tick) => setTimeout(tick, 100))
  }
}

// 2026-10-18 (444-25, D-62 IN-07): a cell kills a process only by the identity it recorded. A pid
// is signalled only while its current entry runs the exact command line recorded at capture, so a
// pid the system has reused for another process is never killed.
export interface RecordedProcess {
  readonly pid: number
  readonly command: string
}

export function recordProcesses(pids: readonly number[]): RecordedProcess[] {
  refuseWithoutPosix()
  const live = new Map(processTable().filter((entry) => !entry.zombie).map((entry) => [entry.pid, entry]))
  return pids.flatMap((pid) => {
    const entry = live.get(pid)
    return entry === undefined ? [] : [{ pid, command: entry.command }]
  })
}

export function killRecorded(recorded: readonly RecordedProcess[]): number[] {
  refuseWithoutPosix()
  if (recorded.length === 0) return []
  const live = new Map(processTable().filter((entry) => !entry.zombie).map((entry) => [entry.pid, entry.command]))
  const killed: number[] = []
  for (const entry of recorded) {
    if (live.get(entry.pid) !== entry.command) continue
    try {
      process.kill(entry.pid, 'SIGKILL')
      killed.push(entry.pid)
    } catch {
      /* gone since the read */
    }
  }
  return killed
}
