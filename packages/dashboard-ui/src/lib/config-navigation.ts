export const CONFIG_BUCKETS = ['workspace', 'services', 'registry', 'use', 'analytics'] as const

export type ConfigBucket = typeof CONFIG_BUCKETS[number]

export interface ConfigNavigationItem {
  bucket: ConfigBucket
  bucketLabel: string
  item: string
  itemLabel: string
  title: string
  description: string
  fieldPaths: string[]
  aliases: string[]
}

export interface ConfigSelection {
  bucket: ConfigBucket
  item: string
}

const CONFIG_ITEMS = [
  {
    bucket: 'workspace',
    bucketLabel: 'Workspace',
    item: 'discovery',
    itemLabel: 'Discovery',
    title: 'Discovery',
    description: 'Configure test and suite discovery patterns for the workspace.',
    fieldPaths: ['workspace.testMatch', 'workspace.suiteMatch', 'workspace.testPathIgnore'],
    aliases: ['tests', 'test match', 'suite match', 'ignore patterns', 'discovery'],
  },
  {
    bucket: 'workspace',
    bucketLabel: 'Workspace',
    item: 'files',
    itemLabel: 'Files',
    title: 'Files',
    description: 'Set shared workspace file paths for hooks, agent rules, environment variables, and runtime secrets.',
    fieldPaths: ['workspace.hooksFile', 'workspace.agentRules', 'workspace.envFile', 'workspace.secretsFile'],
    aliases: ['hooks file', 'agent rules file', 'env file', 'environment file', 'secrets file', 'files'],
  },
  {
    bucket: 'workspace',
    bucketLabel: 'Workspace',
    item: 'agent-rules',
    itemLabel: 'Agent Rules',
    title: 'Agent Rules',
    description: 'Manage the markdown rules file appended to the agent system prompt.',
    fieldPaths: ['workspace.agentRules'],
    aliases: ['agent rules', 'rules', 'system prompt'],
  },
  {
    bucket: 'services',
    bucketLabel: 'Services',
    item: 'dashboard',
    itemLabel: 'Dashboard',
    title: 'Dashboard',
    description: 'Configure dashboard server settings such as port, db path, and artifacts.',
    fieldPaths: ['services.dashboard', 'services.dashboard.port', 'services.dashboard.dbPath', 'services.dashboard.artifactsDir'],
    aliases: ['dashboard', 'artifacts', 'artifacts dir', 'port', 'db path', 'runs db'],
  },
  {
    bucket: 'services',
    bucketLabel: 'Services',
    item: 'cache',
    itemLabel: 'Cache',
    title: 'Cache',
    description: 'Configure cache storage and retention.',
    fieldPaths: ['services.cache', 'services.cache.dir', 'services.cache.ttl'],
    aliases: ['cache', 'cache dir', 'cache directory', 'ttl'],
  },
  {
    bucket: 'services',
    bucketLabel: 'Services',
    item: 'auth-states',
    itemLabel: 'Auth States',
    title: 'Auth States',
    description: 'Review saved web auth states by target and logical name.',
    fieldPaths: ['services.authState', 'services.authState.dir'],
    aliases: ['auth states', 'auth state', 'saved auth', 'saved auth state', 'login state'],
  },
  {
    bucket: 'services',
    bucketLabel: 'Services',
    item: 'logging',
    itemLabel: 'Logging',
    title: 'Logging',
    description: 'Configure service log verbosity.',
    fieldPaths: ['services.logging', 'services.logging.level'],
    aliases: ['logging', 'log level'],
  },
  {
    bucket: 'services',
    bucketLabel: 'Services',
    item: 'recording',
    itemLabel: 'Recording',
    title: 'Recording',
    description: 'Configure recording defaults for captured sessions.',
    fieldPaths: ['services.recording', 'services.recording.enabled'],
    aliases: ['recording', 'record'],
  },
  {
    bucket: 'services',
    bucketLabel: 'Services',
    item: 'accessibility',
    itemLabel: 'Accessibility',
    title: 'Accessibility',
    description: 'Configure accessibility auditing and failure behavior.',
    fieldPaths: [
      'services.accessibility',
      'services.accessibility.enabled',
      'services.accessibility.standard',
      'services.accessibility.runAfter',
      'services.accessibility.failOnViolation',
    ],
    aliases: ['accessibility', 'a11y'],
  },
  {
    bucket: 'services',
    bucketLabel: 'Services',
    item: 'memory',
    itemLabel: 'Memory',
    title: 'Memory',
    description: 'Configure runtime memory injection, trust thresholds, and curator behavior.',
    fieldPaths: [
      'services.memory',
      'services.memory.dir',
      'services.memory.provider',
      'services.memory.curatorEnabled',
      'services.memory.minTrust',
      'services.memory.maxInjections',
      'services.memory.ablationEnabled',
      'services.memory.circuitBreakerEnabled',
    ],
    aliases: ['memory', 'memory dir', 'memory directory', 'memory path', 'curator', 'trust'],
  },
  {
    bucket: 'registry',
    bucketLabel: 'Registry',
    item: 'llms',
    itemLabel: 'LLMs',
    title: 'LLMs',
    description: 'Manage named LLM configurations used across agent-qa.',
    fieldPaths: ['registry.llms'],
    aliases: ['llm', 'llms', 'models', 'providers'],
  },
  {
    bucket: 'registry',
    bucketLabel: 'Registry',
    item: 'targets',
    itemLabel: 'Targets',
    title: 'Targets',
    description: 'Manage named browser or mobile targets referenced elsewhere in the product.',
    fieldPaths: ['registry.targets'],
    aliases: ['targets', 'target', 'urls', 'bundle id', 'app package'],
  },
  {
    bucket: 'registry',
    bucketLabel: 'Registry',
    item: 'devices',
    itemLabel: 'Devices',
    title: 'Devices',
    description: 'Manage reusable named device profiles and transports.',
    fieldPaths: ['registry.devices'],
    aliases: ['devices', 'device', 'device profiles', 'transport'],
  },
  {
    bucket: 'registry',
    bucketLabel: 'Registry',
    item: 'providers',
    itemLabel: 'Providers',
    title: 'Providers',
    description: 'Edit provider-defined raw JSON configuration keyed by provider name.',
    fieldPaths: ['registry.providers'],
    aliases: ['providers', 'provider', 'json'],
  },
  {
    bucket: 'use',
    bucketLabel: 'Use',
    item: 'browser',
    itemLabel: 'Browser',
    title: 'Browser',
    description: 'Set browser defaults such as engine, viewport, and browser-specific headless mode.',
    fieldPaths: ['use.browser', 'use.browser.headless'],
    aliases: ['browser', 'viewport', 'browser headless'],
  },
  {
    bucket: 'use',
    bucketLabel: 'Use',
    item: 'timeouts',
    itemLabel: 'Timeouts',
    title: 'Timeouts',
    description: 'Set default step, test, and navigation timeouts.',
    fieldPaths: ['use.timeout'],
    aliases: ['timeouts', 'timeout', 'navigation timeout'],
  },
  {
    bucket: 'use',
    bucketLabel: 'Use',
    item: 'healing',
    itemLabel: 'Healing',
    title: 'Healing',
    description: 'Set default healing attempts and related runtime behavior.',
    fieldPaths: ['use.healing'],
    aliases: ['healing', 'retry'],
  },
  {
    bucket: 'use',
    bucketLabel: 'Use',
    item: 'planner',
    itemLabel: 'Planner',
    title: 'Planner',
    description: 'Set runtime planner defaults such as sub-action and history limits.',
    fieldPaths: ['use.planner'],
    aliases: ['planner', 'sub actions'],
  },
  {
    bucket: 'use',
    bucketLabel: 'Use',
    item: 'log-capture',
    itemLabel: 'Log Capture',
    title: 'Log Capture',
    description: 'Set runtime console and network capture defaults.',
    fieldPaths: ['use.logCapture'],
    aliases: ['log capture', 'console capture', 'network capture'],
  },
  {
    bucket: 'use',
    bucketLabel: 'Use',
    item: 'mobile',
    itemLabel: 'Mobile',
    title: 'Mobile',
    description: 'Set native mobile app-state behavior for mobile runs.',
    fieldPaths: ['use.mobile', 'use.mobile.appState'],
    aliases: ['mobile', 'app state', 'app data', 'reset app data', 'preserve app data'],
  },
  {
    bucket: 'use',
    bucketLabel: 'Use',
    item: 'execution-defaults',
    itemLabel: 'Execution Defaults',
    title: 'Execution Defaults',
    description: 'Set shared runtime defaults used by tests and suites.',
    fieldPaths: ['use.llm', 'use.parallel'],
    aliases: ['execution defaults', 'default llm', 'parallel'],
  },
  {
    bucket: 'analytics',
    bucketLabel: 'Analytics',
    item: 'pass-rate-scope',
    itemLabel: 'Pass Rate Scope',
    title: 'Pass Rate Scope',
    description: 'Set the run attributes used for scoped pass rate and flakiness metrics.',
    fieldPaths: ['analytics.passRateScope.attributes'],
    aliases: ['analytics', 'analytics scope', 'pass rate', 'passRateScope', 'scope', 'attributes', 'flakiness'],
  },
] as const satisfies readonly ConfigNavigationItem[]

export const CONFIG_NAVIGATION_ITEMS = [...CONFIG_ITEMS]

export const DEFAULT_CONFIG_SELECTION: ConfigSelection = {
  bucket: 'workspace',
  item: 'discovery',
}

export function getConfigItem(
  bucket: ConfigBucket,
  item: string,
): ConfigNavigationItem | undefined {
  return CONFIG_NAVIGATION_ITEMS.find((entry) => entry.bucket === bucket && entry.item === item)
}

export function getConfigItemsByBucket(bucket: ConfigBucket): ConfigNavigationItem[] {
  return CONFIG_NAVIGATION_ITEMS.filter((entry) => entry.bucket === bucket)
}

export function normalizeConfigSelection(searchParams: URLSearchParams): ConfigSelection {
  const rawBucket = searchParams.get('bucket')
  const rawItem = searchParams.get('item')

  if (rawBucket && CONFIG_BUCKETS.includes(rawBucket as ConfigBucket)) {
    const bucket = rawBucket as ConfigBucket
    if (rawItem && getConfigItem(bucket, rawItem)) {
      return { bucket, item: rawItem }
    }
    const firstBucketItem = getConfigItemsByBucket(bucket)[0]
    if (firstBucketItem) {
      return { bucket, item: firstBucketItem.item }
    }
  }

  return DEFAULT_CONFIG_SELECTION
}

export function serializeConfigSelection(
  selection: ConfigSelection,
  searchParams?: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams()
  next.set('bucket', selection.bucket)
  next.set('item', selection.item)

  if (searchParams) {
    for (const [key, value] of searchParams.entries()) {
      if (key === 'bucket' || key === 'item') {
        continue
      }
      next.append(key, value)
    }
  }

  return next
}

export function getConfigCommandLabel(item: ConfigNavigationItem): string {
  return `Config: ${item.bucketLabel} / ${item.itemLabel}`
}

export function searchConfigNavigationItems(query: string): ConfigNavigationItem[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (normalizedQuery.length < 2) {
    return []
  }

  return CONFIG_NAVIGATION_ITEMS.filter((item) => {
    const haystacks = [
      item.bucket,
      item.bucketLabel,
      item.item,
      item.itemLabel,
      item.title,
      item.description,
      ...item.aliases,
      ...item.fieldPaths,
    ]
    return haystacks.some((value) => value.toLowerCase().includes(normalizedQuery))
  })
}
