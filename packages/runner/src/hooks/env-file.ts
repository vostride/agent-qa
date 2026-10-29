// Hook .env variable file parsing/serialization. Moved
// byte-equivalently from core/src/agent/variables.ts — the DockerHookExecutor
// (runner-local) reads /tmp/agent-qa.env through `parseEnvFile`, so the pure
// string codec now lives beside the hook contracts in the runner. core's
// variables.ts re-exports these until Plan 05 deletes that file.

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [lineIndex, rawLine] of content.split('\n').entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) continue
    const key = line.slice(0, eqIndex).trim()
    const rawValue = line.slice(eqIndex + 1).trim()
    const value = rawValue.startsWith('"')
      ? parseDoubleQuotedValue(rawValue, key, lineIndex + 1)
      : rawValue.startsWith("'") && rawValue.endsWith("'")
        ? rawValue.slice(1, -1)
        : rawValue
    result[key] = value
  }
  return result
}

export function serializeEnvFile(vars: Record<string, string>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(vars)) {
    if (value === '' || /[\s"'\\]/.test(value)) {
      lines.push(`${key}="${serializeDoubleQuotedValue(value)}"`)
    } else {
      lines.push(`${key}=${value}`)
    }
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : ''
}

function parseDoubleQuotedValue(value: string, key: string, line: number): string {
  let decoded = ''

  for (let index = 1; index < value.length; index += 1) {
    const character = value[index]
    if (character === '"') {
      if (index !== value.length - 1) {
        throw envValueError(key, line, 'trailing bytes after closing quote')
      }
      return decoded
    }
    if (character !== '\\') {
      decoded += character
      continue
    }

    index += 1
    const escaped = value[index]
    switch (escaped) {
      case '\\':
        decoded += '\\'
        break
      case '"':
        decoded += '"'
        break
      case 'r':
        decoded += '\r'
        break
      case 'n':
        decoded += '\n'
        break
      default:
        throw envValueError(key, line, 'unknown escape sequence')
    }
  }

  throw envValueError(key, line, 'unterminated double-quoted value')
}

function serializeDoubleQuotedValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}

function envValueError(key: string, line: number, reason: string): Error {
  return new Error(`Invalid env value for key "${key}" on line ${line}: ${reason}`)
}
