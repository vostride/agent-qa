// The pinned config file SET, enumerated once for every consumer.
//
// A SET AND NOT A GLOB (394-39's population lesson). `*.yaml` would answer differently on the first
// repository whose layout nobody anticipated — silently, and in the direction that matters, because
// this answer is what a porcelain check scopes to, what the out-of-set classifier compares against,
// and what a commit's pathspec names. Every member is a file the CONFIG ITSELF names: the config
// yaml, the hooks file `workspace.hooksFile` points at, and the `.gitignore` whose managed block
// `init` maintains.
//
// IT LIVES IN `schema` FOR THE REASON THE TWO VOCABULARIES BESIDE IT DO: three packages read this
// one answer. `cli`'s config-files port enumerates the set it reads bytes for; `agent`'s
// cross-boundary classifier decides `out-of-set-path` against it; 395-06's apply porcelain scopes
// its check to it. Three spellings of one enumeration is the sibling-input failure this project
// keeps rediscovering — and the failure mode here is silent in the permissive direction, because a
// consumer whose copy is missing a member simply stops flagging changes to it.
//
// PURE, AND DELIBERATELY IGNORANT OF THE FILESYSTEM. The set is what the config NAMES, not what
// happens to exist: a hooks file the config names and the repository does not have is still a
// member, because "the file is absent" is a fact the reader reports, never a reason to stop
// considering the path config-owned.
//
// add a member here when the config grows a new file it OWNS — not when a project happens
// to keep another yaml beside it. The test is authorship: this product writes these files. Owned by
// whoever owns D-02/D-05.

/** The managed-block file `init` maintains. Not named by the config, but written by this product. */
export const CONFIG_SET_GITIGNORE = '.gitignore'

/** What `workspace.hooksFile` defaults to when the config does not name one. */
export const CONFIG_SET_DEFAULT_HOOKS_FILE = 'hooks.yaml'

/**
 * The closed set of workspace-relative paths this product's configuration owns.
 *
 * DEDUPLICATED AND SORTED, so two reads of one project answer in one order and a project whose
 * `hooksFile` IS its config file is enumerated once rather than digested twice under one path.
 */
export function enumerateConfigFileSet(input: {
  /** The config yaml's workspace-relative path, as the host's own identity mint spells it. */
  readonly configFile: string
  /** `workspace.hooksFile` as the committed config names it, or absent for the default. */
  readonly hooksFile?: string
}): readonly string[] {
  const hooksFile = input.hooksFile === undefined || input.hooksFile === ''
    ? CONFIG_SET_DEFAULT_HOOKS_FILE
    : input.hooksFile
  return [...new Set([input.configFile, hooksFile, CONFIG_SET_GITIGNORE])].sort()
}
