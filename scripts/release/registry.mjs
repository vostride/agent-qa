import { execFileSync as defaultExecFileSync } from 'node:child_process'

function packageName(record) {
  return typeof record === 'string' ? record : record.pkg?.name ?? record.name
}

function isNpmNotFound(error) {
  const text = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`
  return /\bE404\b|404\s+Not Found|code E404/i.test(text)
}

export async function checkNpmVersionsAbsent(packages, version, options = {}) {
  const execFileSync = options.execFileSync ?? defaultExecFileSync
  const npmCommand = options.npmCommand ?? 'npm'
  for (const record of packages) {
    const name = packageName(record)
    if (!name) throw new Error('public package record missing name')
    try {
      execFileSync(npmCommand, ['view', `${name}@${version}`, 'version', '--json'], {
        encoding: 'utf8',
        stdio: 'pipe',
      })
      throw new Error(`npm version already published: ${name}@${version}`)
    } catch (error) {
      if (error.message?.startsWith('npm version already published:')) throw error
      if (isNpmNotFound(error)) continue
      throw new Error(`could not verify npm version absence for ${name}@${version}`)
    }
  }
}
