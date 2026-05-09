const EXTERNAL_IMAGE_PREFIXES = ["data:image/", "blob:", "http://", "https://"]

function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, "/")
}

function isHttpUrl(path: string): boolean {
  return path.startsWith("http://") || path.startsWith("https://")
}

function isLocalAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
}

export function resolveScreenshotSrc(path: string): string {
  if (EXTERNAL_IMAGE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return path
  }

  const normalizedPath = normalizeArtifactPath(path)
  const segments = normalizedPath.split("/").filter(Boolean)
  if (segments.length >= 2) {
    const filename = segments[segments.length - 1]
    const runId = segments[segments.length - 2]
    return `/api/screenshots/${runId}/${filename}`
  }
  return `/api/screenshots/${normalizedPath}`
}

export function resolveVideoSrc(runId: string, videoPath: string | null | undefined): string | null {
  const trimmed = videoPath?.trim()
  if (!trimmed) return null
  if (isHttpUrl(trimmed)) return trimmed
  if (isLocalAbsolutePath(trimmed)) return null

  const normalizedPath = normalizeArtifactPath(trimmed)
  const segments = normalizedPath.split("/").filter(Boolean)
  if (segments.length === 0) return null
  if (normalizedPath.startsWith(`${runId}/`)) return `/api/videos/${normalizedPath}`
  if (segments.length === 1) return `/api/videos/${runId}/${segments[0]}`
  return `/api/videos/${normalizedPath}`
}
