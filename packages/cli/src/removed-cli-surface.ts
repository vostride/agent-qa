const REMOVED_NODE_ENV_FILE_FLAG = '--env-file'
const REMOVED_TOP_LEVEL_COMMANDS = new Set(['connect'])
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['--config', '--log-level'])
const GLOBAL_BOOLEAN_OPTIONS = new Set(['--verbose', '--quiet', '--help', '-h', '--version', '-V'])

export function findRemovedNodeEnvFileArg(execArgv: readonly string[]): string | null {
  for (const arg of execArgv) {
    if (arg === REMOVED_NODE_ENV_FILE_FLAG || arg.startsWith(`${REMOVED_NODE_ENV_FILE_FLAG}=`)) {
      return REMOVED_NODE_ENV_FILE_FLAG
    }
  }
  return null
}

export function findTopLevelCommandArg(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg) continue
    if (arg === '--') return argv[index + 1] ?? null
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index++
      continue
    }
    if ([...GLOBAL_OPTIONS_WITH_VALUE].some(option => arg.startsWith(`${option}=`))) continue
    if (GLOBAL_BOOLEAN_OPTIONS.has(arg)) continue
    if (arg.startsWith('-')) return null
    return arg
  }
  return null
}

export function findRemovedTopLevelCommandArg(argv: readonly string[]): string | null {
  const command = findTopLevelCommandArg(argv)
  return command && REMOVED_TOP_LEVEL_COMMANDS.has(command) ? command : null
}

export function rejectRemovedCliSurface(input: {
  execArgv?: readonly string[]
  argv?: readonly string[]
} = {}): void {
  // Node 24 can consume shebang-launched `agent-qa run --env-file ...` into
  // execArgv before Commander sees it, so reject it here as a removed agent-qa
  // flag instead of letting Node treat it as its own env loader.
  const removedNodeArg = findRemovedNodeEnvFileArg(input.execArgv ?? process.execArgv)
  if (removedNodeArg) {
    console.error(`error: unknown option '${removedNodeArg}'`)
    process.exit(1)
  }

  const removedCommand = findRemovedTopLevelCommandArg(input.argv ?? process.argv.slice(2))
  if (removedCommand) {
    console.error(`error: unknown command '${removedCommand}'`)
    process.exit(1)
  }
}
