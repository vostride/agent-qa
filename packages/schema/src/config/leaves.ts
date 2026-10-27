// The leaves of the published config schema (429-03 D-06), pinned against the real schema by
// core's config-schema-leaves test. 2026-10-15 (441-40, D-29): the list no longer classes a leaf
// for masking; the config output's only mask is the declared one.
//
// Pattern format: dot-joined tokens, where '*' is an operator-named record key and a key
// suffixed '[]' is an array item (`registry.llms[].name`, `registry.targets.*.url`).

// prettier-ignore
export const CONFIG_SCHEMA_LEAVES = Object.freeze([
  'analytics.passRateScope.attributes.*',
  'analytics.passRateScope.attributes.*.regex',
  'analytics.privacy',
  'knowledge.commitArtifacts',
  'knowledge.dir',
  'plugins.auth[].package',
  'plugins.auth[].path',
  'plugins.providers[].package',
  'plugins.providers[].path',
  'registry.devices.*.match.*',
  'registry.devices.*.platform',
  'registry.llms[].baseURL',
  'registry.llms[].contextWindow',
  'registry.llms[].model',
  'registry.llms[].name',
  'registry.llms[].provider',
  'registry.llms[].providerHeaders.*',
  'registry.llms[].vision',
  'registry.targets.*.app.path',
  'registry.targets.*.appActivity',
  'registry.targets.*.appPackage',
  'registry.targets.*.bundleId',
  'registry.targets.*.environment',
  'registry.targets.*.platform',
  'registry.targets.*.product',
  'registry.targets.*.url',
  'services.accessibility.disableRules[]',
  'services.accessibility.enabled',
  'services.accessibility.exclude[]',
  'services.accessibility.failOnViolation',
  'services.accessibility.runAfter',
  'services.accessibility.standard',
  'services.authState.dir',
  'services.cache.dir',
  'services.dashboard.artifactsDir',
  'services.dashboard.baseUrl',
  'services.dashboard.dbPath',
  'services.dashboard.host',
  'services.dashboard.port',
  'services.dashboard.workspace',
  'services.logging.level',
  'services.mcp.enabled',
  'services.mcp.host',
  'services.mcp.path',
  'services.mcp.port',
  'services.mcp.transport',
  'services.recording.enabled',
  'services.recording.keepFailuresOnly',
  'services.vision.effectiveResolution',
  'services.vision.screenshotSize',
  'use.browser.headless',
  'use.browser.name',
  'use.browser.viewport.height',
  'use.browser.viewport.width',
  'use.buildTag',
  'use.cache',
  'use.llm',
  'use.logCapture.console',
  'use.logCapture.network',
  'use.mobile.appState',
  'use.parallel',
  'use.planner.maxActions',
  'use.planner.maxPlanningTurns',
  'use.planner.previousStepCount',
  'use.timeout.navigation',
  'use.timeout.step',
  'use.timeout.test',
  'use.workers',
  'workspace.envFile',
  'workspace.hooksFile',
  'workspace.secretsFile',
  'workspace.suiteMatch[]',
  'workspace.testMatch[]',
  'workspace.testPathIgnore[]',
] as const)

export type ConfigLeafPattern = (typeof CONFIG_SCHEMA_LEAVES)[number]

const RECORD_KEY = '*'
const ARRAY_ITEM = '[]'

interface TrieNode {
  children: Map<string, TrieNode>
}

function patternSteps(pattern: string): string[] {
  const steps: string[] = []
  for (const token of pattern.split('.')) {
    let key = token
    let items = 0
    while (key.endsWith(ARRAY_ITEM)) {
      key = key.slice(0, -ARRAY_ITEM.length)
      items++
    }
    steps.push(key)
    for (let i = 0; i < items; i++) steps.push(ARRAY_ITEM)
  }
  return steps
}

const TRIE: TrieNode = (() => {
  const root: TrieNode = { children: new Map() }
  for (const pattern of CONFIG_SCHEMA_LEAVES) {
    let node = root
    for (const step of patternSteps(pattern)) {
      let child = node.children.get(step)
      if (child === undefined) {
        child = { children: new Map() }
        node.children.set(step, child)
      }
      node = child
    }
  }
  return root
})()

/**
 * True when the path is one the published schema describes: a leaf or an ancestor of one.
 * A number segment is an array index, and a string segment never stands for an array item,
 * even when spelled '[]'.
 */
export function isConfigSchemaPath(segments: readonly (string | number)[]): boolean {
  let node = TRIE
  for (const segment of segments) {
    let next: TrieNode | undefined
    if (typeof segment === 'number') {
      next = node.children.get(ARRAY_ITEM)
    } else if (segment === ARRAY_ITEM) {
      next = node.children.get(RECORD_KEY)
    } else {
      next = node.children.get(segment) ?? node.children.get(RECORD_KEY)
    }
    if (next === undefined) return false
    node = next
  }
  return true
}

/**
 * The list owner of a leaf pattern: the prefix before its first '*' or '[]' token, or the
 * pattern itself when it has neither.
 */
export function configLeafOwner(pattern: string): string {
  const owner: string[] = []
  for (const token of pattern.split('.')) {
    if (token === RECORD_KEY) break
    const arrayAt = token.indexOf(ARRAY_ITEM)
    if (arrayAt !== -1) {
      owner.push(token.slice(0, arrayAt))
      break
    }
    owner.push(token)
  }
  return owner.join('.')
}
