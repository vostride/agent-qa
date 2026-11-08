import { Check, CircleAlert, Copy, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useClipboardCopy } from "@/hooks/use-clipboard-copy"

export const UPDATE_BANNER_DISMISS_COOKIE = "agent_qa_update_notice_dismissed"
export const UPDATE_BANNER_DISMISS_MS = 24 * 60 * 60 * 1000
export const UPDATE_COMMAND = "npx agent-qa@latest init"
export const UPDATE_COMMAND_COPIED_TEXT = "Copied to the clipboard"
export const UPDATE_COMMAND_COPY_FAILED_TEXT = `Could not copy — select the command to copy it: ${UPDATE_COMMAND}`
export const UPDATE_COMMAND_COPY_FAILED_LABEL = "Could not copy — select the command"

export interface UpdateBannerDismissal {
  latestVersion: string
  dismissedAt: string
}

export function isUpdateBannerDismissed(
  dismissal: UpdateBannerDismissal | null,
  latestVersion: string,
  now = Date.now(),
): boolean {
  if (!dismissal || dismissal.latestVersion !== latestVersion) return false

  const dismissedAt = Date.parse(dismissal.dismissedAt)
  return Number.isFinite(dismissedAt) && now - dismissedAt < UPDATE_BANNER_DISMISS_MS
}

export function readUpdateBannerDismissalCookie(): UpdateBannerDismissal | null {
  if (typeof document === "undefined") return null

  const cookie = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${UPDATE_BANNER_DISMISS_COOKIE}=`))
  if (!cookie) return null

  try {
    const raw = decodeURIComponent(cookie.slice(UPDATE_BANNER_DISMISS_COOKIE.length + 1))
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null

    const candidate = parsed as Record<string, unknown>
    if (
      typeof candidate.latestVersion !== "string" ||
      typeof candidate.dismissedAt !== "string"
    ) {
      return null
    }

    return {
      latestVersion: candidate.latestVersion,
      dismissedAt: candidate.dismissedAt,
    }
  } catch {
    return null
  }
}

export function writeUpdateBannerDismissalCookie(dismissal: UpdateBannerDismissal): void {
  if (typeof document === "undefined") return

  document.cookie = `${UPDATE_BANNER_DISMISS_COOKIE}=${encodeURIComponent(
    JSON.stringify(dismissal),
  )}; path=/; max-age=86400; samesite=lax`
}

export function UpdateBanner({
  installedVersion,
  latestVersion,
  onDismiss,
}: {
  installedVersion: string
  latestVersion: string
  onDismiss: () => void
}) {
  const { status, copy } = useClipboardCopy()
  // The banner is the one live region; only what changes inside it, the copy result, is read out.
  return (
    <div
      role="status"
      aria-atomic="false"
      className="flex min-h-12 w-full items-center justify-between gap-3 border-b border-border bg-muted/70 px-4 text-[13px] text-foreground md:h-10 md:min-h-10"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">Update available</span>
        <span className="text-muted-foreground">
          agent-qa v{latestVersion} is available. You are using v{installedVersion}.
        </span>
        <a
          href="https://github.com/vostride/agent-qa/releases"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          View releases
        </a>
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Run in this project:</span>
          <code data-update-command className="rounded bg-background/70 px-1.5 py-0.5 font-mono">
            {UPDATE_COMMAND}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-copy-status={status}
            aria-label={`Copy ${UPDATE_COMMAND}`}
            onClick={() => copy(UPDATE_COMMAND)}
          >
            {status === "copied"
              ? <Check className="size-3.5 text-success" aria-hidden="true" />
              : status === "failed"
                ? <CircleAlert className="size-3.5 text-destructive" aria-hidden="true" />
                : <Copy className="size-3.5 opacity-60" aria-hidden="true" />}
          </Button>
          {status === "failed" ? (
            <span data-update-command-failed aria-hidden="true" className="text-xs text-destructive">
              {UPDATE_COMMAND_COPY_FAILED_LABEL}
            </span>
          ) : null}
          <span data-update-command-status className="sr-only">
            {status === "copied"
              ? UPDATE_COMMAND_COPIED_TEXT
              : status === "failed"
                ? UPDATE_COMMAND_COPY_FAILED_TEXT
                : ""}
          </span>
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        aria-label="Dismiss update notice"
        onClick={onDismiss}
        className="-mr-2"
      >
        <X className="size-4" aria-hidden="true" />
      </Button>
    </div>
  )
}
