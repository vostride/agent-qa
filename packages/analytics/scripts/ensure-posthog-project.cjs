// The PostHog key and Sentry DSN files are generated and never committed: a missing one is
// written blank, and one that exists, such as a release's real value, is left as it is.
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

function writeWhenMissing(name, content) {
  const target = join(__dirname, '..', 'src', name)
  if (existsSync(target)) return
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

writeWhenMissing(
  'posthog-project.ts',
  'export const AGENT_QA_POSTHOG_KEY = ""\nexport const AGENT_QA_POSTHOG_HOST = "https://us.i.posthog.com"\n',
)
writeWhenMissing('sentry-project.ts', 'export const AGENT_QA_SENTRY_DSN = ""\n')
