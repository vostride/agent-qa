import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import treeKill from 'tree-kill'

// tree-kill finds a Linux process's children by running ps, which slim Linux images do not have,
// and a missing ps throws in the host process. Linux keeps each process's parent in /proc.
export function killTree(
  pid: number,
  options: { readonly platform?: NodeJS.Platform; readonly proc?: string } = {},
): Promise<void> {
  if ((options.platform ?? process.platform) === 'linux') {
    // When /proc cannot be listed, the process itself is still signalled.
    let members = [pid]
    try {
      members = linuxTree(pid, options.proc ?? '/proc')
    } catch {}
    for (const member of members) {
      try {
        process.kill(member, 'SIGKILL')
      } catch {}
    }
    return Promise.resolve()
  }
  // tree-kill lists the tree before it signals any of it, so the tree is killed only once its
  // callback runs. What the callback reports is not passed on.
  return new Promise((settle) => {
    treeKill(pid, 'SIGKILL', () => settle())
  })
}

function linuxTree(root: number, proc: string): number[] {
  const children = new Map<number, number[]>()
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/u.test(entry)) continue
    let stat: string
    try {
      stat = readFileSync(join(proc, entry, 'stat'), 'utf8')
    } catch {
      continue
    }
    // The command name sits in parentheses and may hold spaces and parentheses itself; the
    // parent's id is the second field after the last one.
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    children.set(parent, [...(children.get(parent) ?? []), Number(entry)])
  }
  const tree = [root]
  for (const member of tree) tree.push(...(children.get(member) ?? []))
  return tree
}
