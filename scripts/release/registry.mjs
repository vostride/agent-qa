import { execFileSync as defaultExecFileSync } from 'node:child_process'

function packageName(record) {
  return typeof record === 'string' ? record : record.pkg?.name ?? record.name
}

function isNpmNotFound(error) {
  const text = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`
  return /\bE404\b|404\s+Not Found|code E404/i.test(text)
}

export function npmVersionPresent(name, version, options = {}) {
  const execFileSync = options.execFileSync ?? defaultExecFileSync
  const npmCommand = options.npmCommand ?? 'npm'
  let output
  try {
    output = execFileSync(npmCommand, ['view', `${name}@${version}`, 'version', '--json'], {
      encoding: 'utf8',
      stdio: 'pipe',
    })
  } catch (error) {
    if (isNpmNotFound(error)) return false
    throw new Error(`could not verify npm version for ${name}@${version}`)
  }
  // An exit 0 that prints nothing proves neither presence nor absence.
  if (!String(output ?? '').trim()) {
    throw new Error(`could not verify npm version for ${name}@${version}`)
  }
  return true
}

export async function checkNpmVersionsAbsent(packages, version, options = {}) {
  for (const record of packages) {
    const name = packageName(record)
    if (!name) throw new Error('public package record missing name')
    let present
    try {
      present = npmVersionPresent(name, version, options)
    } catch {
      throw new Error(`could not verify npm version absence for ${name}@${version}`)
    }
    if (present) throw new Error(`npm version already published: ${name}@${version}`)
  }
}
