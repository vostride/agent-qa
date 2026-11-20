// Runs first and imports nothing: it applies the colour rule to stdout and sets the environment so
// picocolors, which reads it once at its own load, agrees. The rule is core's colorEnabled.

function isCi(env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI
  const actions = env.GITHUB_ACTIONS
  return (
    (ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false') ||
    (actions !== undefined &&
      actions !== '' &&
      actions !== '0' &&
      actions.toLowerCase() !== 'false')
  )
}

function colorOn(env: NodeJS.ProcessEnv, stdoutIsTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  const force = env.FORCE_COLOR
  if (force !== undefined) return force !== '0' && force !== 'false'
  if (stdoutIsTTY) return env.TERM !== 'dumb'
  return isCi(env)
}

// picocolors is also on for every Windows stream; forcing colour there changes nothing.
function libraryColorOn(env: NodeJS.ProcessEnv, stdoutIsTTY: boolean): boolean {
  return !env.NO_COLOR && (!!env.FORCE_COLOR || (stdoutIsTTY && env.TERM !== 'dumb') || !!env.CI)
}

export function applyColorPosture(env: NodeJS.ProcessEnv, stdoutIsTTY: boolean): void {
  if (!colorOn(env, stdoutIsTTY)) {
    if (!env.NO_COLOR) env.NO_COLOR = '1'
    return
  }
  if (!libraryColorOn(env, stdoutIsTTY)) env.FORCE_COLOR = '1'
}

function colorVariables(env: NodeJS.ProcessEnv): { NO_COLOR?: string; FORCE_COLOR?: string } {
  return { NO_COLOR: env.NO_COLOR, FORCE_COLOR: env.FORCE_COLOR }
}

// What stdout made of the two variables says nothing about stderr, so core's colorEnabled reads
// what the user set from this record. It stays in this process: a child inherits the environment.
const asked = colorVariables(process.env)
applyColorPosture(process.env, process.stdout.isTTY === true)
;(globalThis as { [key: symbol]: unknown })[Symbol.for('agent-qa.color-posture')] = {
  asked,
  left: colorVariables(process.env),
}
