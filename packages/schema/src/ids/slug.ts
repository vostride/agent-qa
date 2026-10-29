// The ONE security-reviewed pure path-segment sanitizer.
// It lives in schema so provider/storage-neutral eval core can derive safe cassette ids
// without depending on runner-local or duplicating traversal-sensitive string handling.

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g

/**
 * Turn a branch name into a single safe path segment (security V5): strip control
 * characters, neutralize path separators and parent-dir `..` sequences, and reject
 * leading/trailing dots so a branch name can never traverse out of the cache root.
 */
export function slugBranch(name: string): string {
  const slug = name
    .replace(CONTROL_CHARS_RE, '') // control chars
    .replace(/\.\.+/g, '-') // parent-dir sequences
    .replace(/[/\\]/g, '-') // path separators
    .replace(/[^A-Za-z0-9._-]/g, '-') // anything else unsafe
    .replace(/^[.\-]+/, '') // no leading dot/dash (., .., hidden dirs)
    .replace(/[.\-]+$/, '') // no trailing dot/dash

  return slug.length > 0 ? slug : 'default'
}
