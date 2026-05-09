import '@/lib/monaco-env'

import { useRef, useEffect, useState, useCallback } from 'react'
import * as monaco from 'monaco-editor'
import { registerThemes } from '@/lib/monaco-theme'
import { registerYamlCompletions } from '@/lib/yaml-completions'
import { setupYamlLinter } from '@/lib/yaml-linter'
import { useTheme } from '@/components/theme-provider'
import { cn } from '@/lib/utils'

interface MonacoEditorProps {
  value: string
  onChange: (value: string) => void
  onSave?: () => void
  readOnly?: boolean
  className?: string
  showErrors?: boolean
  filePath?: string
  language?: string
}

let themesRegistered = false
let yamlCompletionsRegistered = false

function getResolvedTheme(theme: string): 'agent-qa-dark' | 'agent-qa-light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'agent-qa-dark'
      : 'agent-qa-light'
  }
  return theme === 'dark' ? 'agent-qa-dark' : 'agent-qa-light'
}

function MonacoEditorInner({
  value,
  onChange,
  onSave,
  readOnly = false,
  className,
  showErrors = false,
  filePath,
  language = 'yaml',
}: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const linterDisposableRef = useRef<{ dispose: () => void } | null>(null)
  const isUpdatingRef = useRef(false)
  const onSaveRef = useRef(onSave)
  const onChangeRef = useRef(onChange)
  const [errors, setErrors] = useState<monaco.editor.IMarkerData[]>([])
  const [errorsExpanded, setErrorsExpanded] = useState(true)
  const { theme } = useTheme()

  // Keep refs current
  onSaveRef.current = onSave
  onChangeRef.current = onChange

  // Initialize editor on mount
  useEffect(() => {
    if (!containerRef.current) return

    // Register themes and completions once globally
    if (!themesRegistered) {
      registerThemes()
      themesRegistered = true
    }
    if (language === 'yaml' && !yamlCompletionsRegistered) {
      registerYamlCompletions()
      yamlCompletionsRegistered = true
    }

    const resolvedTheme = getResolvedTheme(theme)

    const editor = monaco.editor.create(containerRef.current, {
      value,
      language,
      theme: resolvedTheme,
      minimap: { enabled: false },
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      tabSize: 2,
      insertSpaces: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      automaticLayout: true,
      readOnly,
      renderLineHighlight: 'line',
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
      },
      padding: { top: 12, bottom: 12 },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      fixedOverflowWidgets: true,
      contextmenu: false,
      quickSuggestions: true,
      suggestOnTriggerCharacters: true,
      parameterHints: { enabled: false },
      folding: true,
      bracketPairColorization: { enabled: false },
      matchBrackets: 'near' as const,
      roundedSelection: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      smoothScrolling: true,
    })

    editorRef.current = editor

    // Listen for content changes
    editor.onDidChangeModelContent(() => {
      if (isUpdatingRef.current) return
      const val = editor.getValue()
      onChangeRef.current(val)
    })

    // Cmd+S / Ctrl+S keybinding
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.()
    })

    return () => {
      linterDisposableRef.current?.dispose()
      linterDisposableRef.current = null
      editor.dispose()
      editorRef.current = null
    }
    // Only run on mount/unmount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return

    monaco.editor.setModelLanguage(model, language)

    linterDisposableRef.current?.dispose()
    linterDisposableRef.current = null
    setErrors([])

    if (language === 'yaml') {
      if (!yamlCompletionsRegistered) {
        registerYamlCompletions()
        yamlCompletionsRegistered = true
      }
      linterDisposableRef.current = setupYamlLinter(model, setErrors, filePath)
    }

    return () => {
      linterDisposableRef.current?.dispose()
      linterDisposableRef.current = null
    }
  }, [language, filePath])

  // Sync external value changes
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (!model) return

    const currentValue = model.getValue()
    if (currentValue !== value) {
      isUpdatingRef.current = true
      // Preserve cursor/selection
      const selections = editor.getSelections()
      model.setValue(value)
      if (selections) {
        editor.setSelections(selections)
      }
      isUpdatingRef.current = false
    }
  }, [value])

  // Sync theme changes
  useEffect(() => {
    const resolvedTheme = getResolvedTheme(theme)
    monaco.editor.setTheme(resolvedTheme)
  }, [theme])

  // Sync readOnly changes
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly })
  }, [readOnly])

  const handleErrorClick = useCallback((marker: monaco.editor.IMarkerData) => {
    const editor = editorRef.current
    if (!editor) return
    editor.revealLineInCenter(marker.startLineNumber)
    editor.setPosition({ lineNumber: marker.startLineNumber, column: marker.startColumn })
    editor.focus()
  }, [])

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-md border border-border', className)}>
      <div ref={containerRef} className="min-h-[300px] flex-1" />
      {showErrors && (
        <div className="border-t border-border bg-muted/30">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setErrorsExpanded(prev => !prev)}
          >
            <svg
              className={cn('h-3 w-3 transition-transform', errorsExpanded && 'rotate-90')}
              viewBox="0 0 12 12"
              fill="currentColor"
            >
              <path d="M4 2l4 4-4 4z" />
            </svg>
            Problems
            {errors.length > 0 && (
              <span className="rounded-full bg-destructive/20 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
                {errors.length}
              </span>
            )}
            {errors.length === 0 && (
              <span className="text-[10px] text-muted-foreground/60">No problems</span>
            )}
          </button>
          {errorsExpanded && errors.length > 0 && (
            <div className="max-h-[140px] overflow-y-auto px-3 pb-2">
              {errors.map((err, i) => (
                <button
                  key={`${err.startLineNumber}-${i}`}
                  type="button"
                  className="flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted/50 transition-colors"
                  onClick={() => handleErrorClick(err)}
                >
                  <span className="mt-0.5 h-3 w-3 shrink-0 rounded-full bg-destructive/80" />
                  <span className="flex-1 text-foreground/80">
                    {err.message.split('\n')[0]}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    Ln {err.startLineNumber}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default MonacoEditorInner
