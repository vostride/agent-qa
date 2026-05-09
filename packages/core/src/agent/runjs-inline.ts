const RUNJS_DBL_RE = /\{\{runJS:"((?:[^"\\]|\\.)*)"\}\}/g
const RUNJS_SGL_RE = /\{\{runJS:'((?:[^'\\]|\\.)*)'\}\}/g

interface RunJSMatch {
  fullMatch: string
  code: string
}

export function parseRunJSInline(text: string): RunJSMatch[] {
  const matches: RunJSMatch[] = []

  RUNJS_DBL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RUNJS_DBL_RE.exec(text)) !== null) {
    matches.push({ fullMatch: m[0], code: m[1].replace(/\\"/g, '"') })
  }

  RUNJS_SGL_RE.lastIndex = 0
  while ((m = RUNJS_SGL_RE.exec(text)) !== null) {
    matches.push({ fullMatch: m[0], code: m[1].replace(/\\'/g, "'") })
  }

  return matches
}

export function coerceRunJSResult(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
