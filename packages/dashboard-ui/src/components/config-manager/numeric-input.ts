import { t } from '@/i18n'

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
  const { label, min, max, integer } = options
  // Bounds are config values, shown as the digits the file holds rather than a grouped number.
  const values = { label, min: String(min), max: String(max) }
  if (min !== undefined && max !== undefined) {
    return integer
      ? t('configUi.number.integerRange', values)
      : t('configUi.number.numberRange', values)
  }
  if (min !== undefined) {
    return integer
      ? t('configUi.number.integerMin', values)
      : t('configUi.number.numberMin', values)
  }
  if (max !== undefined) {
    return integer
      ? t('configUi.number.integerMax', values)
      : t('configUi.number.numberMax', values)
  }
  return integer ? t('configUi.number.integer', values) : t('configUi.number.number', values)
}
