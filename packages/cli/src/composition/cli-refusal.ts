// No imports: classes in the run graph extend this at load time, so an import cycle would hit its TDZ.

export class CliRefusal extends Error {
  readonly lines: readonly string[]
  readonly exitCode: number

  constructor(lines: readonly string[], exitCode: number, options?: ErrorOptions) {
    super(lines.map((line) => line.replace(/\u001B\[[0-9;]*m/g, '')).join('\n'), options)
    this.name = 'CliRefusal'
    this.lines = lines
    this.exitCode = exitCode
  }
}
