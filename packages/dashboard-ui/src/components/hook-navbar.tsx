import { Link } from 'react-router'
import { ChevronRight, Keyboard, Pencil, PlayCircle, Save, Trash } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ShortcutKey, ShortcutLegend } from '@/components/shortcut-hints'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTranslation } from '@/i18n'

interface HookNavbarProps {
  hookName: string
  isCreateMode: boolean
  mode?: 'view' | 'edit'
  hookHref?: string
  editHref?: string
  unsaved?: boolean
  isSaving?: boolean
  isRunning?: boolean
  isDeleting?: boolean
  onSave?: () => void
  onRun?: () => void
  runDisabled?: boolean
  onDelete?: () => void
  shortcutsOpen?: boolean
  onToggleShortcuts?: () => void
}

export function HookNavbar({
  hookName,
  isCreateMode,
  mode = 'view',
  hookHref,
  editHref,
  unsaved = false,
  isSaving = false,
  isRunning = false,
  isDeleting = false,
  onSave,
  onRun,
  runDisabled = false,
  onDelete,
  shortcutsOpen = false,
  onToggleShortcuts,
}: HookNavbarProps) {
  const { t } = useTranslation()
  const isViewMode = mode === 'view' && !isCreateMode
  const showEditCrumb = !isCreateMode && !isViewMode && mode === 'edit'
  const showRunAction = !isCreateMode && !!onRun
  const showDeleteAction = !isCreateMode && !!onDelete

  return (
    <div className="flex h-14 shrink-0 items-center justify-between border-b px-4 min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          to="/hooks"
          className="shrink-0 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('hooks.navbar.hooks')}
        </Link>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {/* The name gives way first: Edit shrinks only once the name is gone. */}
        {isCreateMode ? (
          <span className="truncate text-sm font-medium">{t('hooks.navbar.newHook')}</span>
        ) : hookHref && !isViewMode ? (
          <Link
            to={hookHref}
            className="shrink-[100000] truncate text-sm font-medium transition-colors hover:text-primary"
            title={hookName}
          >
            {hookName}
          </Link>
        ) : (
          <span className="shrink-[100000] truncate text-sm font-medium" title={hookName}>
            {hookName}
          </span>
        )}
        {showEditCrumb && (
          <>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{t('common.edit')}</span>
          </>
        )}
        {unsaved && (
          <Badge variant="outline" className="text-xs">
            {t('hooks.navbar.unsaved')}
          </Badge>
        )}
      </div>

      {/* On a phone the actions may reach into the row's right padding, then scroll sideways. */}
      <div className="flex shrink-0 items-center gap-2 max-sm:max-w-[calc(100%+1rem)] max-sm:overflow-x-auto max-sm:py-1">
        {isViewMode ? (
          <>
            <Button variant="outline" size="sm" asChild>
              <Link to={editHref ?? hookHref ?? '/hooks'}>
                <Pencil className="h-3.5 w-3.5" />
                {t('common.edit')}
                <ShortcutKey shortcut="E" />
              </Link>
            </Button>

            {showRunAction ? (
              <Button size="sm" onClick={onRun} disabled={isRunning || runDisabled}>
                <PlayCircle className="h-3.5 w-3.5" />
                {isRunning ? t('hooks.navbar.running') : t('hooks.navbar.runHook')}
                <ShortcutKey
                  shortcut="R"
                  className="border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground"
                />
              </Button>
            ) : null}

            {showDeleteAction ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                disabled={isDeleting}
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash className="h-3.5 w-3.5" />
                {isDeleting ? t('hooks.navbar.deleting') : t('common.delete')}
              </Button>
            ) : null}

            {!isCreateMode && onToggleShortcuts ? (
              <Popover
                open={shortcutsOpen}
                onOpenChange={(open) => {
                  if (!open) {
                    onToggleShortcuts()
                  }
                }}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={onToggleShortcuts}
                        aria-label={t('hooks.navbar.shortcuts')}
                      >
                        <Keyboard className="h-3.5 w-3.5" />
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t('hooks.navbar.shortcuts')}</TooltipContent>
                </Tooltip>
                <PopoverContent align="end" sideOffset={8} className="w-72 p-4">
                  <div className="space-y-3">
                    <div>
                      <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        {t('hooks.navbar.actions')}
                      </h4>
                      <ShortcutLegend
                        hints={[
                          { key: 'E', label: t('common.edit') },
                          { key: 'R', label: t('hooks.navbar.runHook') },
                          { key: '?', label: t('hooks.navbar.toggleShortcuts') },
                        ]}
                      />
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            ) : null}
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onSave} disabled={isSaving || !onSave}>
              <Save className="h-3.5 w-3.5" />
              {isSaving ? t('hooks.navbar.saving') : t('common.save')}
            </Button>

            {showRunAction ? (
              <Button size="sm" onClick={onRun} disabled={isRunning || runDisabled}>
                <PlayCircle className="h-3.5 w-3.5" />
                {isRunning ? t('hooks.navbar.running') : t('hooks.navbar.runHook')}
              </Button>
            ) : null}

            {showDeleteAction ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                disabled={isDeleting}
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash className="h-3.5 w-3.5" />
                {isDeleting ? t('hooks.navbar.deleting') : t('common.delete')}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
