// Closed and total: learned weights may replace class vectors, never the classes.
export type QueryClass = 'literal' | 'mixed' | 'semantic'

const ID_SELECTOR_TOKEN = /^#[A-Za-z_][A-Za-z0-9_-]*[.,;!?]?$/
const ATTRIBUTE_SELECTOR_TOKEN = /^\[[^\]\r\n]+\][.,;!?]?$/
const XPATH_TOKEN = /^\/\/\S+$/
const XPATH_QUERY = /^\/\/[^\r\n]+$/
const URL_TOKEN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/
const TEST_ID_TOKEN = /^(?:data-testid|testid)=[^\s]+$/i
const GET_BY_TEST_ID_TOKEN = /^getByTestId\([^\)\r\n]*\)[.,;!?]?$/i
const ERROR_NAME_TOKEN = /^(?:[A-Za-z_$][A-Za-z0-9_$]*(?:Error|Exception)|Error):$/
const ERROR_PREFIX = /^(?:[A-Za-z_$][A-Za-z0-9_$]*(?:Error|Exception)|Error):/
const STACK_FRAME = /^\s*at\s+\S+/

const TOKEN_DETECTORS: readonly RegExp[] = [
  ID_SELECTOR_TOKEN,
  ATTRIBUTE_SELECTOR_TOKEN,
  XPATH_TOKEN,
  URL_TOKEN,
  TEST_ID_TOKEN,
  GET_BY_TEST_ID_TOKEN,
  ERROR_NAME_TOKEN,
]

function isLiteralToken(token: string): boolean {
  return TOKEN_DETECTORS.some((detector) => detector.test(token))
}

function containsBracketSelector(value: string): boolean {
  const opening = value.indexOf('[')
  if (opening === -1) return false
  return value.indexOf(']', opening + 1) > opening + 1
}

function containsStackFrame(value: string): boolean {
  return value.split('\n').some((line) => STACK_FRAME.test(line))
}

function isOnlyLiteralShape(value: string, tokens: readonly string[]): boolean {
  if (ATTRIBUTE_SELECTOR_TOKEN.test(value) || XPATH_QUERY.test(value)) return true
  return tokens.length > 0 && tokens.every(isLiteralToken)
}

// Anchored linear-time detectors only; empty input is semantic, literal shapes plus prose mixed.
export function classifyQuery(lexicalQuery: string): QueryClass {
  const value = lexicalQuery.trim()
  if (value === '') return 'semantic'

  const tokens = value.split(/\s+/u)
  const hasLiteralShape =
    tokens.some(isLiteralToken) ||
    containsBracketSelector(value) ||
    ERROR_PREFIX.test(value) ||
    containsStackFrame(value)

  if (!hasLiteralShape) return 'semantic'
  return isOnlyLiteralShape(value, tokens) ? 'literal' : 'mixed'
}
