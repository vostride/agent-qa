import { useState } from 'react'
import { RotateCcwClock, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RUN_NOTICE_COPY, runNoticeDismissKey } from '@/lib/run-notice-view'

export function RunNotice({ runId }: { runId: string }) {
  const key = runNoticeDismissKey(runId)
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(key) === 'true' } catch { return false }
  })
  if (dismissed) return null
  return (
    <div data-run-notice role='status' className='flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground'>
      <RotateCcwClock className='h-4 w-4 shrink-0' aria-hidden='true' />
      <span className='min-w-0 flex-1'>{RUN_NOTICE_COPY.message}</span>
      <Button size='icon-sm' variant='ghost' className='shrink-0' aria-label={RUN_NOTICE_COPY.dismiss} onClick={() => {
        setDismissed(true)
        try { sessionStorage.setItem(key, 'true') } catch { /* Dismissal still works without storage. */ }
      }}>
        <X className='h-4 w-4' aria-hidden='true' />
      </Button>
    </div>
  )
}
