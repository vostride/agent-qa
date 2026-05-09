import { parseDocument, stringify, type Document, isMap } from 'yaml'

const TOP_LEVEL_ORDER = ['name', 'test-id', 'target', 'use', 'meta', 'context', 'setup', 'steps', 'teardown']

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

function moveListItem<T>(items: T[], oldIndex: number, newIndex: number): T[] {
  const nextItems = [...items]
  const [movedItem] = nextItems.splice(oldIndex, 1)
  nextItems.splice(newIndex, 0, movedItem)
  return nextItems
}

export interface StepOverrides {
  timeout?: string
  retries?: number
  screenshot?: boolean
  maxAttempts?: number
}

export interface StepFormState {
  text: string
  overrides: StepOverrides
}

export interface TestFormState {
  name: string
  testId: string
  target: string
  context: string
  setup: string[]
  steps: StepFormState[]
  teardown: string[]
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export function yamlToFormState(yamlContent: string): TestFormState | null {
  try {
    const doc = parseDocument(yamlContent)
    if (doc.errors.length > 0) return null
    const data = doc.toJSON()
    if (!data || typeof data !== 'object') return null
    return {
      name: data.name ?? '',
      testId: data['test-id'] ?? '',
      target: data.target ?? '',
      context: data.context ?? '',
      setup: toStringArray(data.setup),
      steps: Array.isArray(data.steps)
        ? data.steps.map((s: unknown) => {
            if (typeof s === 'string') return { text: s, overrides: {} }
            const obj = s as Record<string, unknown>
            return {
              text: (obj.step as string) ?? '',
              overrides: {
                timeout: obj.timeout as string | undefined,
                retries: obj.retries as number | undefined,
                screenshot: obj.screenshot as boolean | undefined,
                maxAttempts: obj.maxAttempts as number | undefined,
              },
            }
          })
        : [],
      teardown: toStringArray(data.teardown),
    }
  } catch {
    return null
  }
}

export function updateYamlField(
  yamlContent: string,
  path: string[],
  value: unknown,
): string {
  try {
    const doc = parseDocument(yamlContent)
    if (
      value === undefined ||
      (Array.isArray(value) && value.length === 0)
    ) {
      doc.deleteIn(path)
    } else {
      doc.setIn(path, value)
    }
    return toSortedYaml(doc)
  } catch {
    return yamlContent
  }
}

export function updateYamlStep(
  yamlContent: string,
  index: number,
  newText: string,
): string {
  try {
    const doc = parseDocument(yamlContent)
    const existing = doc.getIn(['steps', index])
    if (
      existing &&
      typeof existing === 'object' &&
      'toJSON' in (existing as any)
    ) {
      const json = (existing as any).toJSON()
      if (json && typeof json === 'object' && 'step' in json) {
        doc.setIn(['steps', index, 'step'], newText)
        return toSortedYaml(doc)
      }
    }
    doc.setIn(['steps', index], newText)
    return toSortedYaml(doc)
  } catch {
    return yamlContent
  }
}

export function updateYamlStepOverride(
  yamlContent: string,
  index: number,
  field: string,
  value: unknown,
): string {
  try {
    const doc = parseDocument(yamlContent)
    const existing = doc.getIn(['steps', index])
    const json =
      existing && typeof existing === 'object' && 'toJSON' in (existing as any)
        ? (existing as any).toJSON()
        : existing
    if (typeof json === 'string' || !json) {
      const stepText = typeof json === 'string' ? json : ''
      doc.setIn(['steps', index], { step: stepText, [field]: value })
    } else {
      if (value === undefined || value === '' || value === null) {
        doc.deleteIn(['steps', index, field])
        const updated = (doc.getIn(['steps', index]) as any)?.toJSON?.()
        if (updated && typeof updated === 'object') {
          const keys = Object.keys(updated).filter((k) => k !== 'step')
          if (keys.length === 0) {
            doc.setIn(['steps', index], updated.step ?? '')
          }
        }
      } else {
        doc.setIn(['steps', index, field], value)
      }
    }
    return toSortedYaml(doc)
  } catch {
    return yamlContent
  }
}

export function deleteYamlStep(
  yamlContent: string,
  index: number,
): string {
  try {
    const doc = parseDocument(yamlContent)
    const steps = doc.getIn(['steps']) as any
    if (steps && typeof steps.deleteIn === 'function') {
      steps.deleteIn([index])
    }
    return toSortedYaml(doc)
  } catch {
    return yamlContent
  }
}

export function addYamlStep(yamlContent: string): string {
  try {
    const doc = parseDocument(yamlContent)
    const data = doc.toJSON()
    const steps = Array.isArray(data?.steps) ? [...data.steps, ''] : ['']
    doc.setIn(['steps'], steps)
    return toSortedYaml(doc)
  } catch {
    return yamlContent
  }
}

export function reorderYamlList(
  yamlContent: string,
  field: 'setup' | 'steps' | 'teardown',
  oldIndex: number,
  newIndex: number,
): string {
  try {
    if (
      oldIndex === newIndex ||
      oldIndex < 0 ||
      newIndex < 0
    ) {
      return yamlContent
    }

    const doc = parseDocument(yamlContent)
    const existing = doc.getIn([field]) as
      | { toJSON?: () => unknown }
      | unknown
    const items =
      existing &&
      typeof existing === 'object' &&
      'toJSON' in existing &&
      typeof existing.toJSON === 'function'
        ? existing.toJSON()
        : existing

    if (!Array.isArray(items)) return yamlContent
    if (oldIndex >= items.length || newIndex >= items.length) return yamlContent

    doc.setIn([field], moveListItem(items, oldIndex, newIndex))
    return toSortedYaml(doc)
  } catch {
    return yamlContent
  }
}

export function formStateToYaml(state: TestFormState): string {
  const obj: Record<string, unknown> = { name: state.name || 'My Test' }
  if (state.testId) obj['test-id'] = state.testId
  if (state.target) obj.target = state.target
  if (state.context) obj.context = state.context
  if (state.setup.length > 0) obj.setup = state.setup
  obj.steps =
    state.steps.length > 0
      ? state.steps.map((step) => {
          const activeOverrides = Object.fromEntries(
            Object.entries(step.overrides).filter(([, v]) => v !== undefined),
          )
          if (Object.keys(activeOverrides).length > 0) {
            return { step: step.text, ...activeOverrides }
          }
          return step.text
        })
      : ['Navigate to the homepage']
  if (state.teardown.length > 0) obj.teardown = state.teardown
  const doc = parseDocument(stringify(obj, { lineWidth: 0 }))
  return toSortedYaml(doc)
}
