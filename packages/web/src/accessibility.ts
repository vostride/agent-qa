import { AxeBuilder } from '@axe-core/playwright'
import type { Page } from 'playwright-core'
import type { AccessibilityViolation } from '@vostride/agent-qa-core'

export interface AccessibilityOptions {
  standard?: 'wcag2a' | 'wcag2aa' | 'wcag2aaa'
  disableRules?: string[]
  exclude?: string[]
}

export async function runAccessibilityCheck(
  page: Page,
  options?: AccessibilityOptions,
): Promise<AccessibilityViolation[]> {
  let builder = new AxeBuilder({ page })

  if (options?.standard) {
    const tagMap: Record<string, string[]> = {
      'wcag2a': ['wcag2a'],
      'wcag2aa': ['wcag2a', 'wcag2aa'],
      'wcag2aaa': ['wcag2a', 'wcag2aa', 'wcag2aaa'],
    }
    builder = builder.withTags(tagMap[options.standard] ?? ['wcag2a', 'wcag2aa'])
  }

  if (options?.disableRules?.length) {
    builder = builder.disableRules(options.disableRules)
  }

  if (options?.exclude?.length) {
    for (const selector of options.exclude) {
      builder = builder.exclude(selector)
    }
  }

  const results = await builder.analyze()

  return results.violations.map(v => ({
    ruleId: v.id,
    impact: v.impact as AccessibilityViolation['impact'],
    description: v.description,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.slice(0, 10).map(n => ({
      html: n.html,
      target: n.target as string[],
    })),
  }))
}
