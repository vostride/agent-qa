// Each existing component must resolve inside the root; a link swapped in after the check slips by.
import { lstatSync, realpathSync } from 'node:fs'
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
    try {
      lstatSync(current)
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return
      throw error
    }
    let real: string | undefined
    try {
      real = realpathSync(current)
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT' && errnoOf(error) !== 'ELOOP') throw error
    }
    if (real === undefined || (real !== realRoot && !real.startsWith(`${realRoot}${sep}`))) {
      throw new KnowledgeRootContainmentError(current, real, knowledgeRoot)
    }
  }
}
