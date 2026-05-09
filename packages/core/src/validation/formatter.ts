import pc from 'picocolors'
import type { ValidationResult, ValidationDiagnostic } from './validate.js'

function groupByFile(diagnostics: ValidationDiagnostic[]): Map<string, ValidationDiagnostic[]> {
  const groups = new Map<string, ValidationDiagnostic[]>()
  for (const d of diagnostics) {
    const existing = groups.get(d.file)
    if (existing) {
      existing.push(d)
    } else {
      groups.set(d.file, [d])
    }
  }
  return groups
}

function formatSeverity(severity: 'error' | 'warning', color: boolean): string {
  if (severity === 'error') {
    return color ? pc.red('error') : 'error'
  }
  return color ? pc.yellow('warning') : 'warning'
}

function formatOutput(result: ValidationResult, color: boolean): string {
  if (result.diagnostics.length === 0) {
    const check = color ? pc.green('\u2714') : '\u2714'
    return `\n${check} All files valid (${result.fileCount} file(s) checked)\n`
  }

  const groups = groupByFile(result.diagnostics)
  const lines: string[] = ['']

  for (const [file, diagnostics] of groups) {
    const header = color ? pc.underline(pc.bold(file)) : file
    lines.push(header)

    for (const d of diagnostics) {
      const loc = `${d.line}:${d.column}`
      const sev = formatSeverity(d.severity, color).padEnd(color ? 20 : 7)
      lines.push(`  ${loc}  ${sev}  ${d.message}`)
    }

    lines.push('')
  }

  const filesWithIssues = groups.size
  if (result.errorCount > 0) {
    const cross = color ? pc.red('\u2716') : '\u2716'
    lines.push(`${cross} ${result.errorCount} error(s), ${result.warningCount} warning(s) in ${filesWithIssues} file(s)`)
  } else {
    const warn = color ? pc.yellow('\u26A0') : '\u26A0'
    lines.push(`${warn} ${result.warningCount} warning(s) in ${filesWithIssues} file(s)`)
  }
  lines.push('')

  return lines.join('\n')
}

export function formatDiagnostics(result: ValidationResult): string {
  return formatOutput(result, true)
}

export function formatDiagnosticsPlain(result: ValidationResult): string {
  return formatOutput(result, false)
}
