import { RefreshCw } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useTranslation } from '@/i18n'

interface EditorAriaPanelProps {
  ariaTree: string | null
  onRefresh?: () => void
  isExecuting?: boolean
}

export function EditorAriaPanel({ ariaTree, onRefresh, isExecuting }: EditorAriaPanelProps) {
  const { t } = useTranslation()
  if (!ariaTree) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-sm text-muted-foreground">
        <span>{t('editor.detail.aria.empty')}</span>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={isExecuting}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-border hover:bg-muted transition-colors disabled:opacity-50"
          >
            <RefreshCw className="size-3" />
            {t('editor.detail.aria.fetch')}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-end px-3 py-1 border-b border-border/50">
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={isExecuting}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            aria-label={t('editor.detail.aria.refreshLabel')}
          >
            <RefreshCw className="size-3" />
            {t('editor.detail.aria.refresh')}
          </button>
        )}
      </div>
      <ScrollArea className="flex-1">
        <pre className="font-mono text-xs p-3 whitespace-pre-wrap">{ariaTree}</pre>
      </ScrollArea>
    </div>
  )
}
