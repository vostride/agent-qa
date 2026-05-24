import { X } from "lucide-react"

import { Button } from "@/components/ui/button"

export const UPDATE_BANNER_DISMISS_COOKIE = "agent_qa_update_notice_dismissed"
export const UPDATE_BANNER_DISMISS_MS = 24 * 60 * 60 * 1000

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
  return (
    <div
      role="status"
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
