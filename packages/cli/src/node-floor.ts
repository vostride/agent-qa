// imports nothing and stays ES2020; it runs on any Node the user has.

export const NODE_FLOOR_MAJOR = 24

export const NODE_FLOOR_INSTALL_LINE =
  'Install Node.js 24 or newer from https://nodejs.org/, then run the command again.'

export function nodeFloorRefusal(version: string): string | undefined {
  const major = Number(version.replace(/^v/, '').split('.')[0])
  if (major >= NODE_FLOOR_MAJOR) return undefined
  return (
    `agent-qa needs Node.js ${NODE_FLOOR_MAJOR} or newer. This is Node.js ${version}.\n` +
    `${NODE_FLOOR_INSTALL_LINE}\n`
  )
}
