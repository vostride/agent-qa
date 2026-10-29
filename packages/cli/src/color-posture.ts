// picocolors enables colour whenever CI is set; this module imports nothing so it runs first.

export function applyColorPosture(env: NodeJS.ProcessEnv, stdoutIsTTY: boolean): void {
  if (stdoutIsTTY) return
  if (env.FORCE_COLOR !== undefined || env.NO_COLOR !== undefined) return
  env.NO_COLOR = '1'
}

applyColorPosture(process.env, process.stdout.isTTY === true)
