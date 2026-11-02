// Each existing component must resolve inside the root; a link swapped in after the check slips by.
import { lstatSync, realpathSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

export class KnowledgeRootContainmentError extends Error {
  override readonly name = 'KnowledgeRootContainmentError'
  readonly path: string
  readonly resolvedTo: string | undefined
  readonly knowledgeRoot: string

  constructor(path: string, resolvedTo: string | undefined, knowledgeRoot: string) {
    const where = resolvedTo === undefined
      ? 'is a link that resolves nowhere'
      : `resolves to ${resolvedTo}`
    super(
      `knowledge write refused: ${path} ${where}, outside the knowledge root `
        + `${knowledgeRoot}. Remove the link ${path} and retry.`,
    )
    this.path = path
    this.resolvedTo = resolvedTo
    this.knowledgeRoot = knowledgeRoot
  }
}

function errnoOf(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? ''
}

/**
 * Refuse, before any write, a directory under the knowledge root that leaves it through a link.
 *
 * `directory` is the directory the caller writes in (or creates, renames into, or deletes from);
 * it must name a path under `knowledgeRoot`.
 */
export function assertWithinKnowledgeRoot(knowledgeRoot: string, directory: string): void {
  const rel = relative(knowledgeRoot, directory)
  if (rel === '') return
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new KnowledgeRootContainmentError(directory, directory, knowledgeRoot)
  }
  let realRoot: string
  try {
    realRoot = realpathSync(knowledgeRoot)
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return
    throw error
  }
  let current = knowledgeRoot
  for (const part of rel.split(sep)) {
    current = join(current, part)
    const component = resolveComponent(current)
    if (component.kind === 'absent') return
    const real = component.kind === 'resolved' ? component.real : undefined
    if (real === undefined || (real !== realRoot && !real.startsWith(`${realRoot}${sep}`))) {
      throw new KnowledgeRootContainmentError(current, real, knowledgeRoot)
    }
  }
}

type Component = { kind: 'absent' } | { kind: 'dangling' } | { kind: 'resolved'; real: string }

function lstatOrAbsent(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return undefined
    throw error
  }
}

// Another section may remove or remake a directory between the reads; only a link is dangling.
function resolveComponent(path: string): Component {
  for (;;) {
    if (lstatOrAbsent(path) === undefined) return { kind: 'absent' }
    try {
      return { kind: 'resolved', real: realpathSync(path) }
    } catch (error) {
      if (errnoOf(error) === 'ELOOP') return { kind: 'dangling' }
      if (errnoOf(error) !== 'ENOENT') throw error
    }
    const stat = lstatOrAbsent(path)
    if (stat === undefined) return { kind: 'absent' }
    if (stat.isSymbolicLink()) return { kind: 'dangling' }
  }
}
