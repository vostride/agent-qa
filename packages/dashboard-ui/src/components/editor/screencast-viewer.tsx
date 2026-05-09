import { Loader2, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ConnectionState } from '@/hooks/use-live-editor'

interface ScreencastViewerProps {
  screenshot: string | null
  connectionState: ConnectionState
  onReconnect?: () => void
}

export function ScreencastViewer({ screenshot, connectionState, onReconnect }: ScreencastViewerProps) {
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-background">
      {screenshot ? (
        <img
          src={screenshot}
          alt="Browser preview"
          className="max-w-full max-h-full object-contain"
        />
      ) : connectionState === 'connecting' || (connectionState === 'connected' && !screenshot) ? (
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="text-sm">Connecting to browser...</span>
        </div>
      ) : connectionState === 'disconnected' || connectionState === 'error' ? (
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <WifiOff className="h-6 w-6" />
          <span className="text-sm">Browser disconnected</span>
          {onReconnect && (
            <Button variant="outline" size="sm" onClick={onReconnect}>
              Reconnect
            </Button>
          )}
        </div>
      ) : null}
    </div>
  )
}
