import * as monaco from 'monaco-editor'
import { validateTestContent, validateSuiteContent } from '@/lib/api'

let timer: ReturnType<typeof setTimeout> | undefined

export function setupYamlLinter(
  model: monaco.editor.ITextModel,
  onMarkersChange?: (markers: monaco.editor.IMarkerData[]) => void,
  filePath?: string,
) {
  const isSuite = filePath?.endsWith('.suite.yaml') || filePath?.endsWith('.suite.yml')

  const lint = async () => {
    const content = model.getValue()
    if (!content.trim()) {
      monaco.editor.setModelMarkers(model, 'agent-qa', [])
      onMarkersChange?.([])
      return
    }
    try {
      const result = isSuite
        ? await validateSuiteContent(content)
        : await validateTestContent(content, filePath)
      const markers: monaco.editor.IMarkerData[] = result.errors.map(err => {
        const line = err.line ?? 1
        const lineContent = line <= model.getLineCount() ? model.getLineContent(line) : ''
        return {
          severity: monaco.MarkerSeverity.Error,
          message: err.suggestion ? `${err.message}\n\nHint: ${err.suggestion}` : err.message,
          startLineNumber: line,
          startColumn: err.column ?? 1,
          endLineNumber: line,
          endColumn: lineContent.length + 1,
        }
      })
      monaco.editor.setModelMarkers(model, 'agent-qa', markers)
      onMarkersChange?.(markers)
    } catch {
      // Network error — silently skip validation
    }
  }

  const debouncedLint = () => {
    clearTimeout(timer)
    timer = setTimeout(lint, 400)
  }

  const disposable = model.onDidChangeContent(debouncedLint)
  // Run initial lint
  lint()

  return {
    dispose() {
      clearTimeout(timer)
      disposable.dispose()
    },
  }
}

export function getValidationErrors(model: monaco.editor.ITextModel): monaco.editor.IMarkerData[] {
  return monaco.editor.getModelMarkers({ resource: model.uri, owner: 'agent-qa' })
}
