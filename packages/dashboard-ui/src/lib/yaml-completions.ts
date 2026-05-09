import * as monaco from 'monaco-editor'

export const LLM_PROVIDER_COMPLETION_VALUES = [
  'openai-compatible',
  'anthropic-compatible',
  'openai-subscription',
  'anthropic-subscription',
  'gemini',
] as const

interface SchemaField {
  label: string
  detail: string
  documentation?: string
  kind: 'object' | 'string' | 'number' | 'boolean' | 'array' | 'enum'
  enumValues?: string[]
  children?: SchemaField[]
}

// Static schema field map derived from TestDefinitionSchema.
// Built manually to avoid importing @vostride/agent-qa-core (Node.js-only code) in the browser.
const SCHEMA_MAP: SchemaField = {
  label: 'root',
  kind: 'object',
  detail: 'Test definition',
  children: [
    { label: 'name', kind: 'string', detail: 'string (required)', documentation: 'Test name — displayed in reports and dashboard' },
    { label: 'target', kind: 'string', detail: 'string (required)', documentation: 'Named target preset from global config targets section' },
    { label: 'context', kind: 'string', detail: 'string', documentation: 'Additional context or instructions for the AI agent' },
    {
      label: 'setup',
      kind: 'array',
      detail: 'string[]',
      documentation: 'Setup hooks to run before test steps. Values reference canonical hook IDs from the configured hooks file.',
    },
    {
      label: 'steps',
      kind: 'array',
      detail: 'string[] (required)',
      documentation: 'Array of natural language test steps. Each step is a plain string like "Click the login button"',
    },
    {
      label: 'teardown',
      kind: 'array',
      detail: 'string[]',
      documentation: 'Teardown hooks to run after test steps. Values reference canonical hook IDs from the configured hooks file.',
    },
    {
      label: 'variables',
      kind: 'object',
      detail: 'Record<string, string>',
      documentation: 'Key-value pairs for test variables. Access in steps via {{env:varName}} syntax. Overrides env file values.',
    },
    {
      label: 'config',
      kind: 'object',
      detail: 'object',
      documentation: 'Test-level configuration overrides',
      children: [
        {
          label: 'browser',
          kind: 'object',
          detail: 'object',
          documentation: 'Browser configuration',
          children: [
            { label: 'name', kind: 'enum', detail: 'enum', enumValues: ['chromium', 'firefox', 'webkit'], documentation: 'Browser engine' },
            { label: 'headless', kind: 'boolean', detail: 'boolean', documentation: 'Run in headless mode (default: true)' },
            {
              label: 'viewport',
              kind: 'object',
              detail: 'object',
              documentation: 'Browser viewport dimensions',
              children: [
                { label: 'width', kind: 'number', detail: 'number', documentation: 'Viewport width in pixels' },
                { label: 'height', kind: 'number', detail: 'number', documentation: 'Viewport height in pixels' },
              ],
            },
          ],
        },
        {
          label: 'device',
          kind: 'object',
          detail: 'object',
          documentation: 'Mobile device configuration (Android/iOS)',
          children: [
            { label: 'name', kind: 'string', detail: 'string', documentation: 'Device/emulator/simulator name' },
            { label: 'platformVersion', kind: 'string', detail: 'string', documentation: 'OS version (e.g., "14.0")' },
            { label: 'automationName', kind: 'string', detail: 'string', documentation: 'Appium automation name override' },
            { label: 'appPackage', kind: 'string', detail: 'string', documentation: 'Android app package' },
            { label: 'appActivity', kind: 'string', detail: 'string', documentation: 'Android app activity' },
            { label: 'bundleId', kind: 'string', detail: 'string', documentation: 'iOS app bundle ID' },
            { label: 'udid', kind: 'string', detail: 'string', documentation: 'iOS simulator/device UDID' },
            { label: 'avd', kind: 'string', detail: 'string', documentation: 'Android emulator AVD name' },
            { label: 'appiumUrl', kind: 'string', detail: 'string', documentation: 'Appium server URL' },
          ],
        },
        {
          label: 'llm',
          kind: 'object',
          detail: 'object',
          documentation: 'LLM configuration override',
          children: [
            { label: 'provider', kind: 'enum', detail: 'enum', enumValues: [...LLM_PROVIDER_COMPLETION_VALUES], documentation: 'LLM provider' },
            { label: 'model', kind: 'string', detail: 'string', documentation: 'Exact model name for this provider mode.' },
            { label: 'baseURL', kind: 'string', detail: 'string', documentation: 'Exact endpoint base URL for compatible provider modes.' },
            { label: 'providerHeaders', kind: 'object', detail: 'Record<string, string>', documentation: 'Optional non-secret headers for anthropic-compatible endpoints.' },
          ],
        },
        {
          label: 'timeout',
          kind: 'object',
          detail: 'object',
          documentation: 'Timeout overrides',
          children: [
            { label: 'step', kind: 'string', detail: 'string', documentation: 'Per-step timeout (e.g., "30s", "5m")' },
            { label: 'test', kind: 'string', detail: 'string', documentation: 'Per-test timeout (e.g., "10m", "1h")' },
            { label: 'navigation', kind: 'string', detail: 'string', documentation: 'Navigation timeout (e.g., "10s", "30s")' },
          ],
        },
        {
          label: 'healing',
          kind: 'object',
          detail: 'object',
          documentation: 'Self-healing configuration',
          children: [
            { label: 'strategy', kind: 'enum', detail: 'enum', enumValues: ['full-replan', 'selector-resolution', 'two-tier'], documentation: 'Healing strategy' },
            { label: 'maxAttempts', kind: 'number', detail: 'number', documentation: 'Max healing attempts (default: 3)' },
            { label: 'requireStateDiff', kind: 'boolean', detail: 'boolean', documentation: 'Require state change between attempts (default: true)' },
          ],
        },
      ],
    },
    {
      label: 'use',
      kind: 'object',
      detail: 'object',
      documentation: 'Test-level runtime overrides',
      children: [
        { label: 'device', kind: 'string', detail: 'string', documentation: 'Mobile device profile for this test or suite' },
        {
          label: 'mobile',
          kind: 'object',
          detail: 'object',
          documentation: 'Native mobile app-state behavior',
          children: [
            { label: 'appState', kind: 'enum', detail: 'enum', enumValues: ['preserve', 'reset'], documentation: 'Preserve or reset app data for native mobile app runs' },
          ],
        },
      ],
    },
    {
      label: 'meta',
      kind: 'object',
      detail: 'object',
      documentation: 'Test metadata',
      children: [
        { label: 'timeout', kind: 'string', detail: 'string', documentation: 'Test-level timeout override (e.g., "1m", "5m")' },
        { label: 'retries', kind: 'number', detail: 'number', documentation: 'Number of retries on failure' },
        { label: 'record', kind: 'boolean', detail: 'boolean', documentation: 'Enable video recording' },
      ],
    },
    {
      label: 'matrix',
      kind: 'object',
      detail: 'object',
      documentation: 'Matrix expansion for running test across multiple configurations',
      children: [
        {
          label: 'dimensions',
          kind: 'object',
          detail: 'Record<string, string[]>',
          documentation: 'Named dimension arrays for cartesian product (e.g., { browser: ["chromium", "firefox"] })',
        },
        { label: 'include', kind: 'array', detail: 'object[]', documentation: 'Extra combinations to add' },
        { label: 'exclude', kind: 'array', detail: 'object[]', documentation: 'Combinations to remove' },
        { label: 'failFast', kind: 'boolean', detail: 'boolean', documentation: 'Stop on first failure (default: false)' },
      ],
    },
  ],
}

function findFieldAtPath(path: string[]): SchemaField | undefined {
  let current: SchemaField = SCHEMA_MAP
  for (const segment of path) {
    if (!current.children) return undefined
    const child = current.children.find(c => c.label === segment)
    if (!child) return undefined
    current = child
  }
  return current
}

// Parse lines above cursor to determine the YAML path at the cursor position
function getYamlPath(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): { path: string[]; isValue: boolean } {
  const lineContent = model.getLineContent(position.lineNumber)
  const textBeforeCursor = lineContent.substring(0, position.column - 1)

  // Check if we're in value position (after "key: ")
  const valueMatch = textBeforeCursor.match(/^(\s*)([\w-]+):\s+/)
  const isValue = !!valueMatch

  // Get current line indentation
  const currentIndent = lineContent.search(/\S/)

  // Walk backwards to build path from parent keys
  const path: string[] = []
  let targetIndent = currentIndent

  if (isValue && valueMatch) {
    // We're after "key: " — the path should include this key
    // First, find parents
    const key = valueMatch[2]
    const keyIndent = valueMatch[1].length

    // Walk up to find parents
    for (let i = position.lineNumber - 1; i >= 1; i--) {
      const line = model.getLineContent(i)
      const trimmed = line.trimStart()
      if (!trimmed || trimmed.startsWith('#')) continue

      const indent = line.search(/\S/)
      const parentMatch = trimmed.match(/^([\w-]+):/)
      if (parentMatch && indent < keyIndent) {
        path.unshift(parentMatch[1])
        if (indent === 0) break
        targetIndent = indent
        for (let j = i - 1; j >= 1; j--) {
          const pLine = model.getLineContent(j)
          const pTrimmed = pLine.trimStart()
          if (!pTrimmed || pTrimmed.startsWith('#')) continue
          const pIndent = pLine.search(/\S/)
          const pMatch = pTrimmed.match(/^([\w-]+):/)
          if (pMatch && pIndent < targetIndent) {
            path.unshift(pMatch[1])
            targetIndent = pIndent
            if (pIndent === 0) break
          }
        }
        break
      }
    }

    path.push(key)
    return { path, isValue: true }
  }

  // We're in key position — find parent path based on indentation
  if (currentIndent <= 0) {
    return { path: [], isValue: false }
  }

  targetIndent = currentIndent
  for (let i = position.lineNumber - 1; i >= 1; i--) {
    const line = model.getLineContent(i)
    const trimmed = line.trimStart()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('- ')) continue

    const indent = line.search(/\S/)
    const keyMatch = trimmed.match(/^([\w-]+):/)
    if (keyMatch && indent < targetIndent) {
      path.unshift(keyMatch[1])
      targetIndent = indent
      if (indent === 0) break
    }
  }

  return { path, isValue: false }
}

let registered = false

export function registerYamlCompletions() {
  if (registered) return
  registered = true

  monaco.languages.registerCompletionItemProvider('yaml', {
    triggerCharacters: [':', ' ', '\n'],
    provideCompletionItems(model, position) {
      const { path, isValue } = getYamlPath(model, position)

      const word = model.getWordUntilPosition(position)
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      }

      if (isValue) {
        // Suggest enum values for the field at path
        const field = findFieldAtPath(path)
        if (!field) return { suggestions: [] }

        if (field.kind === 'enum' && field.enumValues) {
          return {
            suggestions: field.enumValues.map((val, i) => ({
              label: val,
              kind: monaco.languages.CompletionItemKind.EnumMember,
              insertText: val,
              range,
              sortText: String(i).padStart(3, '0'),
              detail: field.detail,
            })),
          }
        }

        if (field.kind === 'boolean') {
          return {
            suggestions: ['true', 'false'].map((val, i) => ({
              label: val,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: val,
              range,
              sortText: String(i).padStart(3, '0'),
            })),
          }
        }

        return { suggestions: [] }
      }

      // Key position — suggest child fields of the parent
      const parent = findFieldAtPath(path)
      if (!parent?.children) {
        // If at root level, suggest from root
        if (path.length === 0) {
          return {
            suggestions: SCHEMA_MAP.children!.map((field, i) => ({
              label: field.label,
              kind: fieldKindToCompletionKind(field.kind),
              insertText: field.kind === 'object' ? `${field.label}:\n  ` : field.kind === 'array' ? `${field.label}:\n  - ` : `${field.label}: `,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.None,
              range,
              sortText: String(i).padStart(3, '0'),
              detail: field.detail,
              documentation: field.documentation,
            })),
          }
        }
        return { suggestions: [] }
      }

      return {
        suggestions: parent.children.map((field, i) => ({
          label: field.label,
          kind: fieldKindToCompletionKind(field.kind),
          insertText: field.kind === 'object' ? `${field.label}:\n  ` : field.kind === 'array' ? `${field.label}:\n  - ` : `${field.label}: `,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.None,
          range,
          sortText: String(i).padStart(3, '0'),
          detail: field.detail,
          documentation: field.documentation,
        })),
      }
    },
  })
}

function fieldKindToCompletionKind(kind: SchemaField['kind']): monaco.languages.CompletionItemKind {
  switch (kind) {
    case 'object': return monaco.languages.CompletionItemKind.Module
    case 'string': return monaco.languages.CompletionItemKind.Value
    case 'number': return monaco.languages.CompletionItemKind.Value
    case 'boolean': return monaco.languages.CompletionItemKind.Value
    case 'array': return monaco.languages.CompletionItemKind.Property
    case 'enum': return monaco.languages.CompletionItemKind.Enum
    default: return monaco.languages.CompletionItemKind.Property
  }
}
