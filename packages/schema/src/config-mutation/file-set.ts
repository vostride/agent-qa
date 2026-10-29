// A named set, not a glob: a glob answers differently on a layout nobody anticipated.

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
