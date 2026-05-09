import { AlertTriangle, Trash2 } from 'lucide-react'

import type { HookDeleteReference, HookRuntime } from '@/lib/api'
import { getHookRuntimeMeta } from '@/lib/hook-runtime'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface HookDeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  hook: {
    id: string
    name: string
    runtime: HookRuntime
    file: string
  }
  isDeleting: boolean
  deleteError: string | null
  blockedReferences: HookDeleteReference[]
  onDelete: () => void
  onForceDelete: () => void
}

function HookDeleteSummaryRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={mono ? 'font-mono text-xs text-foreground break-all' : 'text-sm text-foreground'}>
        {value}
      </div>
    </div>
  )
}

export function HookDeleteDialog({
  open,
  onOpenChange,
  hook,
  isDeleting,
  deleteError,
  blockedReferences,
  onDelete,
  onForceDelete,
}: HookDeleteDialogProps) {
  const runtimeMeta = getHookRuntimeMeta(hook.runtime)
  const isBlocked = blockedReferences.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isBlocked ? 'Hook is still in use' : 'Delete hook?'}</DialogTitle>
          <DialogDescription>
            {isBlocked
              ? 'These references will break if you force delete this hook.'
              : 'This removes the hook record from the dashboard. If the hook is still referenced, those references will be shown here before force delete is allowed.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 rounded-sm border px-4 py-3 sm:grid-cols-2">
          <HookDeleteSummaryRow label="Hook" value={hook.name} />
          <HookDeleteSummaryRow label="Runtime" value={runtimeMeta.label} />
          <HookDeleteSummaryRow label="Hook ID" value={hook.id} mono />
          <HookDeleteSummaryRow label="File" value={hook.file} mono />
        </div>

        {deleteError ? (
          <div className="rounded-sm border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-foreground">
            {deleteError}
          </div>
        ) : null}

        {isBlocked ? (
          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-sm border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="space-y-1">
                <div className="font-medium text-foreground">Force delete only if you will fix these references immediately.</div>
                <div className="text-muted-foreground">
                  Remove or replace these hook usages first when possible.
                </div>
              </div>
            </div>

            <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
              {blockedReferences.map((reference) => (
                <div
                  key={`${reference.kind}-${reference.path}-${reference.context}`}
                  className="rounded-sm border px-3 py-2"
                >
                  <div className="text-sm font-medium text-foreground">{reference.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {reference.kind} · {reference.context}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground break-all">{reference.path}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {isBlocked ? 'Close' : 'Cancel'}
          </Button>
          <Button
            variant="destructive"
            onClick={isBlocked ? onForceDelete : onDelete}
            disabled={isDeleting}
          >
            <Trash2 className="h-4 w-4" />
            {isDeleting ? 'Deleting...' : isBlocked ? 'Force Delete' : 'Delete Hook'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
