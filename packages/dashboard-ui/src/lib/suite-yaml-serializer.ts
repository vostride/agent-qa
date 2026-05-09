import { parseDocument, type Document, isMap } from 'yaml'

const TOP_LEVEL_ORDER = ['name', 'suite-id', 'target', 'use', 'context', 'setup', 'tests', 'teardown']

function sortMapKeys(doc: Document): void {
  function visit(node: unknown, isRoot: boolean) {
    if (isMap(node)) {
      if (isRoot) {
        node.items.sort((a, b) => {
          const ai = TOP_LEVEL_ORDER.indexOf(String(a.key))
          const bi = TOP_LEVEL_ORDER.indexOf(String(b.key))
          const ao = ai === -1 ? TOP_LEVEL_ORDER.length : ai
          const bo = bi === -1 ? TOP_LEVEL_ORDER.length : bi
          return ao - bo
        })
      } else {
        node.items.sort((a, b) => String(a.key).localeCompare(String(b.key)))
      }
      for (const item of node.items) visit(item.value, false)
    }
  }
  visit(doc.contents, true)
}

function toSortedYaml(doc: Document): string {
  sortMapKeys(doc)
  return doc.toString()
}

export interface SuiteTestEntry {
  test: string
  id: string
}

export interface SuiteFormState {
  name: string
  suiteId: string
  target: string
  context: string
  setup: string[]
  teardown: string[]
  tests: SuiteTestEntry[]
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function toSuiteTestEntries(value: unknown): SuiteTestEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .map((raw): SuiteTestEntry | null => {
      if (raw && typeof raw === 'object' && 'test' in raw && 'id' in raw) {
        const obj = raw as Record<string, unknown>
        if (typeof obj.test === 'string' && typeof obj.id === 'string') {
          return { test: obj.test, id: obj.id }
        }
      }
      return null
    })
    .filter((v): v is SuiteTestEntry => v !== null)
}

export function suiteYamlToFormState(yamlContent: string): SuiteFormState | null {
  try {
    const doc = parseDocument(yamlContent)
    if (doc.errors.length > 0) return null
    const data = doc.toJSON()
    if (!data || typeof data !== 'object') return null
    return {
      name: data.name ?? '',
      suiteId: data['suite-id'] ?? '',
      target: data.target ?? '',
      context: data.context ?? '',
      setup: toStringArray(data.setup),
      teardown: toStringArray(data.teardown),
      tests: toSuiteTestEntries(data.tests),
    }
  } catch {
    return null
  }
}

export function updateSuiteField(yamlContent: string, path: string[], value: unknown): string {
  try {
    const doc = parseDocument(yamlContent)
    if (value === undefined || (Array.isArray(value) && value.length === 0) || value === '') {
      doc.deleteIn(path)
    } else {
      doc.setIn(path, value)
    }
    return toSortedYaml(doc)
  } catch {
    return yamlContent
  }
}

export function reorderSuiteTests(yamlContent: string, oldIndex: number, newIndex: number): string {
  try {
    if (oldIndex === newIndex || oldIndex < 0 || newIndex < 0) return yamlContent
    const doc = parseDocument(yamlContent)
    const data = doc.toJSON()
    const entries = toSuiteTestEntries(data?.tests)
    if (oldIndex >= entries.length || newIndex >= entries.length) return yamlContent
    const next = [...entries]
    const [moved] = next.splice(oldIndex, 1)
    next.splice(newIndex, 0, moved)
    doc.setIn(['tests'], next)
    return toSortedYaml(doc)
  } catch {
    return yamlContent
  }
}

export function addSuiteTest(yamlContent: string, entry: SuiteTestEntry): string {
  try {
    const doc = parseDocument(yamlContent)
    const data = doc.toJSON()
    const entries = toSuiteTestEntries(data?.tests)
    doc.setIn(['tests'], [...entries, entry])
    return toSortedYaml(doc)
  } catch {
    return yamlContent
  }
}

export function removeSuiteTest(yamlContent: string, index: number): string {
  try {
    const doc = parseDocument(yamlContent)
    const data = doc.toJSON()
    const entries = toSuiteTestEntries(data?.tests)
    if (index < 0 || index >= entries.length) return yamlContent
    const next = entries.filter((_, i) => i !== index)
    if (next.length === 0) doc.deleteIn(['tests'])
    else doc.setIn(['tests'], next)
    return toSortedYaml(doc)
  } catch {
    return yamlContent
  }
}
