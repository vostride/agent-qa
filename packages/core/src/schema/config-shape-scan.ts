import { z } from 'zod'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Shapes the strict parse would only report as a bare union or unknown-key error get one
// sentence each here. Like the retired-key scan, this stage only adds issues.
export const configShapeScan = z.unknown().superRefine((value, ctx) => {
  if (!isPlainObject(value) || !Array.isArray(value.plugins)) return
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
