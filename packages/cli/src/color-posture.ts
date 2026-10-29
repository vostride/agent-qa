// picocolors turns colour on whenever CI is set, so a log without a
// terminal got ANSI codes. This module imports nothing: it must run before anything loads picocolors.

export function applyColorPosture(env: NodeJS.ProcessEnv, stdoutIsTTY: boolean): void {
  if (stdoutIsTTY) return
  if (env.FORCE_COLOR !== undefined || env.NO_COLOR !== undefined) return
  env.NO_COLOR = '1'
}

applyColorPosture(process.env, process.stdout.isTTY === true)
