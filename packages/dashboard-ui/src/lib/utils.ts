import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const sec = ms / 1000
  if (sec < 60) {
    const rounded = Math.round(sec * 10) / 10
    return rounded === Math.floor(rounded) ? `${rounded}s` : `${rounded}s`
  }
  const min = Math.floor(sec / 60)
  const remSec = Math.round(sec % 60)
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`
}

export function normalizeTimestamp(ts: string): string {
  if (!ts) return ts
  // SQLite CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" (UTC, no timezone).
  // JS new Date() treats space-separated format as local time — must add T and Z.
  if (!ts.includes('T')) return ts.replace(' ', 'T') + 'Z'
  if (!ts.endsWith('Z') && !ts.includes('+') && !ts.includes('-', 10)) return ts + 'Z'
  return ts
}

export function formatDate(iso: string): string {
  const date = new Date(normalizeTimestamp(iso))
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHr = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHr / 24)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`
  if (diffHr < 24) return `${diffHr} hour${diffHr !== 1 ? 's' : ''} ago`
  if (diffDay === 1) return 'yesterday'
  if (diffDay < 7) return `${diffDay} days ago`
  return formatDateShort(iso)
}

export function formatDateShort(iso: string): string {
  const date = new Date(normalizeTimestamp(iso))
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

export function statusColor(status: string): string {
  switch (status) {
    case 'passed': return 'var(--success)'
    case 'failed': return 'var(--failure)'
    case 'healed': return 'var(--healed)'
    case 'flaky': return 'var(--healed)'
    case 'skipped': return 'var(--warning)'
    default: return 'var(--text-secondary)'
  }
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, ch => ESCAPE_MAP[ch])
}

export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined
  return ((...args: unknown[]) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}

export function createElement(
  tag: string,
  attrs?: Record<string, string>,
  children?: (HTMLElement | string)[],
): HTMLElement {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [key, val] of Object.entries(attrs)) {
      if (key === 'className') {
        el.className = val
      } else {
        el.setAttribute(key, val)
      }
    }
  }
  if (children) {
    for (const child of children) {
      if (typeof child === 'string') {
        el.appendChild(document.createTextNode(child))
      } else {
        el.appendChild(child)
      }
    }
  }
  return el
}
