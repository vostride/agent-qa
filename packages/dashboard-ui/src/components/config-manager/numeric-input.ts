interface ConfigNumberInputOptions {
  label: string
  min?: number
  max?: number
  integer?: boolean
  allowEmpty?: boolean
  errorMessage?: string
}

type ConfigNumberInputResult =
  | { value: number | undefined; error: null }
  | { value: undefined; error: string }

export function parseConfigNumberInput(
  rawValue: string,
  options: ConfigNumberInputOptions,
): ConfigNumberInputResult {
  const trimmed = rawValue.trim()
  const error = options.errorMessage ?? describeNumberInput(options)

  if (trimmed === "") {
    return options.allowEmpty ? { value: undefined, error: null } : { value: undefined, error }
  }

  const numericPattern = options.integer ? /^-?\d+$/ : /^-?(?:\d+|\d*\.\d+)$/
  if (!numericPattern.test(trimmed)) {
    return { value: undefined, error }
  }

  const value = Number(trimmed)
  if (!Number.isFinite(value) || (options.integer && !Number.isSafeInteger(value))) {
    return { value: undefined, error }
  }
  if (options.min !== undefined && value < options.min) {
    return { value: undefined, error }
  }
  if (options.max !== undefined && value > options.max) {
    return { value: undefined, error }
  }

  return { value, error: null }
}

function describeNumberInput(options: ConfigNumberInputOptions): string {
  const kind = options.integer ? "an integer" : "a number"
  if (options.min !== undefined && options.max !== undefined) {
    return `${options.label} must be ${kind} between ${options.min} and ${options.max}`
  }
  if (options.min !== undefined) {
    return `${options.label} must be ${kind} greater than or equal to ${options.min}`
  }
  if (options.max !== undefined) {
    return `${options.label} must be ${kind} less than or equal to ${options.max}`
  }
  return `${options.label} must be ${kind}`
}
