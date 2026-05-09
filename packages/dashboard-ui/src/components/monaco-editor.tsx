import { useRef, useEffect, useState, useCallback, lazy, Suspense } from 'react'
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

// Lazy-loaded inner component that imports Monaco
const MonacoEditorInner = lazy(() => import('@/components/monaco-editor-inner'))

function EditorFallback({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center justify-center bg-background border border-border rounded-md', className)}>
      <div className="text-sm text-muted-foreground">Loading editor...</div>
    </div>
  )
}

export function MonacoEditor(props: MonacoEditorProps) {
  return (
    <Suspense fallback={<EditorFallback className={props.className} />}>
      <MonacoEditorInner {...props} />
    </Suspense>
  )
}

// Re-export inner types for external consumers
export type { MonacoEditorProps }
