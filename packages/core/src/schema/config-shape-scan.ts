import { z } from 'zod'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Shapes the strict parse would only report as a bare union or unknown-key error get one
// sentence each here. Like the retired-key scan, this stage only adds issues.
export const configShapeScan = z.unknown().superRefine((value, ctx) => {
  if (!isPlainObject(value)) return
  if (isPlainObject(value.registry) && Array.isArray(value.registry.remotes)) {
    value.registry.remotes.forEach((remote: unknown, index) => {
      if (!isPlainObject(remote)) return
      for (const issue of remoteShapeIssues(remote, index)) {
        ctx.addIssue({
          code: 'custom',
          path: ['registry', 'remotes', index, ...issue.at],
          message: issue.message,
        })
      }
    })
  }
  if (!Array.isArray(value.plugins)) return
  value.plugins.forEach((entry: unknown, index) => {
    if (!isPlainObject(entry)) return
    const name = typeof entry.name === 'string' ? entry.name : `#${index}`
    const hasPackage = Object.hasOwn(entry, 'package')
    const hasPath = Object.hasOwn(entry, 'path')
    if (hasPackage && hasPath) {
      ctx.addIssue({
        code: 'custom',
        path: ['plugins', index],
        message: `Plugin entry ${name} names both package and path; an entry names one or the other.`,
      })
    } else if (!hasPackage && !hasPath) {
      ctx.addIssue({
        code: 'custom',
        path: ['plugins', index],
        message: `Plugin entry ${name} names no package or path; add package with the plugin's npm name, or path with its folder.`,
      })
    }
    if (Object.hasOwn(entry, 'settings')) {
      ctx.addIssue({
        code: 'custom',
        path: ['plugins', index, 'settings'],
        message: `Plugin entry ${name} has settings; an entry's values go under options, and settings go on each remote that names the entry.`,
      })
    }
  })
})

const ENTRY_OPTION_KEYS = ['protocol', 'query', 'headers', 'basicAuth'] as const

type ShapeIssue = { at: string[]; message: string }

function remoteShapeIssues(remote: Record<string, unknown>, index: number): ShapeIssue[] {
  const name = typeof remote.name === 'string' ? remote.name : `#${index}`
  const hasPlugin = Object.hasOwn(remote, 'plugin')
  const hasUrl = Object.hasOwn(remote, 'url')
  if (hasPlugin && hasUrl) {
    return [
      { at: [], message: `Remote ${name} has both plugin and url; a remote has one or the other.` },
    ]
  }
  if (!hasPlugin && !hasUrl) {
    return [
      {
        at: [],
        message: `Remote ${name} names no url or plugin; add url with its protocol, or plugin with a plugins entry name.`,
      },
    ]
  }
  if (!hasPlugin) return []
  const issues: ShapeIssue[] = ENTRY_OPTION_KEYS.filter((key) => Object.hasOwn(remote, key)).map(
    (key) => ({
      at: [key],
      message: `Remote ${name} names a plugin, so ${key} belongs to its plugins entry's options; remove ${key} from the remote.`,
    }),
  )
  if (Object.hasOwn(remote, 'options')) {
    issues.push({
      at: ['options'],
      message: `Remote ${name} has options; a remote's plugin values go under settings, and account options go on its plugins entry.`,
    })
  }
  return issues
}
