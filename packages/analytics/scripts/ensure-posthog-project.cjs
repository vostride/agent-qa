// Carried over from `packages/core/scripts/ensure-posthog-project.cjs` unchanged in contract
// the key file is generated, never committed, and the
// release pipeline overwrites it with the real project key. Only the TARGET PATH moves with the
// package. Core keeps its own copy until plan 11 deletes `core/src/analytics` outright, and plan 11
// is also what re-points the release scripts at this path.
const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

const target = join(__dirname, '..', 'src', 'posthog-project.ts')

if (!existsSync(target)) {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(
    target,
    'export const AGENT_QA_POSTHOG_KEY = ""\nexport const AGENT_QA_POSTHOG_HOST = "https://us.i.posthog.com"\n',
    'utf8',
  )
}
