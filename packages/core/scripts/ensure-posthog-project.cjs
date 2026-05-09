const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

const target = join(__dirname, '..', 'src', 'analytics', 'posthog-project.ts')

if (!existsSync(target)) {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(
    target,
    'export const AGENT_QA_POSTHOG_KEY = ""\nexport const AGENT_QA_POSTHOG_HOST = "https://us.i.posthog.com"\n',
    'utf8',
  )
}
