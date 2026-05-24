import { routes } from '@/lib/routes'
import { normalizeRunStatus } from '@/lib/status'

export const PRODUCT_TOUR_AUTO_START_PATHS = [
  routes.runs,
  routes.tests,
  routes.hooks,
  routes.suites,
  routes.memory,
  routes.config,
] as const

export const PRODUCT_TOUR_GITHUB_URL = 'https://github.com/vostride/agent-qa'

export interface ProductTourRuntimeContext {
  exampleTestId?: string | null
  runId?: string | null
  runStatus?: string | null
  runDetailStatus?: string | null
  runDetailReached?: boolean
  githubNudgeDismissed?: boolean
}

export type ProductTourStepRoute =
  | string
  | ((context: ProductTourRuntimeContext) => string | null)

export interface ProductTourStep {
  id: string
  title: string
  body: string
  route?: ProductTourStepRoute
  targetId?: string
  centered?: boolean
  action?: {
    label: string
    href: string
    icon?: 'github'
  }
  include?: (context: ProductTourRuntimeContext) => boolean
}

const hasExampleTest = (context: ProductTourRuntimeContext) => Boolean(context.exampleTestId)
const lacksExampleTest = (context: ProductTourRuntimeContext) => !context.exampleTestId
const hasRun = (context: ProductTourRuntimeContext) => Boolean(context.runId)
const lacksRun = (context: ProductTourRuntimeContext) => !context.runId
const hasSuccessfulRunDetailValue = (context: ProductTourRuntimeContext) => {
  const status = normalizeRunStatus(context.runDetailStatus)
  return (
    Boolean(context.runId) &&
    context.runDetailReached === true &&
    !context.githubNudgeDismissed &&
    (status === 'passed' || status === 'healed')
  )
}

export const foundationProductTourSteps = [
  {
    id: 'intro',
    title: 'Welcome to agent-qa',
    body: 'agent-qa lets you write tests in natural language for web and mobile. It runs them through a strict QA harness, learns from past runs, adapts when the UI changes, and shows you exactly what happened.',
    centered: true,
  },
  {
    id: 'llm-setup',
    title: 'Configure your LLM first',
    body: 'A run needs an LLM. Add or choose one, test the connection, save the config, then continue.',
    route: routes.configItem('registry', 'llms'),
    targetId: 'tour-config-section',
  },
  {
    id: 'runs',
    title: 'Runs show outcomes',
    body: 'Runs show outcomes, artifacts, and reasoning from every agent-qa execution.',
    route: routes.runs,
    targetId: 'tour-runs-table',
  },
  {
    id: 'tests',
    title: 'Tests hold natural-language checks',
    body: 'Tests are natural-language checks that agent-qa can run against your configured web or mobile target.',
    route: routes.tests,
    targetId: 'tour-tests-table',
  },
  {
    id: 'suites',
    title: 'Suites group repeatable workflows',
    body: 'Suites group related checks into repeatable workflows when one test is not enough.',
    route: routes.suites,
    targetId: 'tour-suites-table',
  },
  {
    id: 'hooks',
    title: 'Hooks run around and between steps',
    body: 'Hooks can prepare setup, run inline between steps, and handle cleanup around a test or suite.',
    route: routes.hooks,
    targetId: 'tour-hooks-table',
  },
  {
    id: 'memory',
    title: 'Memory keeps learned observations',
    body: 'Memory lets you review learned product observations that can make future runs more aware.',
    route: routes.memory,
    targetId: 'tour-memory-table',
  },
  {
    id: 'config',
    title: 'Config controls local setup',
    body: 'Config controls the model, target, runtime, and dashboard setup agent-qa uses locally.',
    route: routes.config,
    targetId: 'tour-config-section',
  },
  {
    id: 'example-test',
    title: 'Run the example passing test',
    body: 'This generated test is the safest first run because init creates it to validate your setup.',
    route: (context) => (context.exampleTestId ? routes.testView(context.exampleTestId) : null),
    targetId: 'tour-test-detail-overview',
    include: hasExampleTest,
  },
  {
    id: 'example-missing',
    title: 'Find the example passing test',
    body: 'agent-qa init normally creates Example passing test. Pick it from Tests when it is available, or create one later.',
    route: routes.tests,
    targetId: 'tour-tests-table',
    include: lacksExampleTest,
  },
  {
    id: 'run-action',
    title: 'Click Run when ready',
    body: 'Click Run when you are ready. The tour will continue from the run surface or Runs page.',
    route: (context) => (context.exampleTestId ? routes.testView(context.exampleTestId) : routes.tests),
    targetId: 'tour-test-run-action',
    include: hasExampleTest,
  },
  {
    id: 'live-run',
    title: 'Watch the run live',
    body: 'Live mode shows the active execution while the harness works through each step.',
    route: (context) => (context.runId ? routes.runLive(context.runId) : null),
    targetId: 'tour-live-run-status',
    include: hasRun,
  },
  {
    id: 'run-detail',
    title: 'Inspect the run detail',
    body: 'This is the value moment: inspect what agent-qa observed, planned, executed, and verified.',
    route: (context) => (context.runId ? routes.runDetail(context.runId) : null),
    targetId: 'tour-run-detail-reasoning',
    include: hasRun,
  },
  {
    id: 'github-nudge',
    title: 'If agent-qa helped',
    body: 'If agent-qa helped, consider starring it on GitHub.',
    centered: true,
    action: {
      label: 'View on GitHub',
      href: PRODUCT_TOUR_GITHUB_URL,
      icon: 'github',
    },
    include: hasSuccessfulRunDetailValue,
  },
  {
    id: 'runs-fallback',
    title: 'Open your latest run',
    body: 'If a run is not open here yet, use Runs to open the latest execution and inspect the detail view.',
    route: routes.runs,
    targetId: 'tour-runs-table',
    include: lacksRun,
  },
] as const satisfies readonly ProductTourStep[]

const stepIds = foundationProductTourSteps.map((step) => step.id)

export function getVisibleProductTourSteps(
  context: ProductTourRuntimeContext = {},
): ProductTourStep[] {
  return (foundationProductTourSteps as readonly ProductTourStep[]).filter(
    (step) => step.include?.(context) ?? true,
  )
}

export function getFirstProductTourStep(context: ProductTourRuntimeContext = {}): ProductTourStep {
  return getVisibleProductTourSteps(context)[0] ?? foundationProductTourSteps[0]
}

export function getKnownProductTourStepIds(): string[] {
  return [...stepIds]
}

export function getProductTourStep(
  stepId: string,
  context: ProductTourRuntimeContext = {},
): ProductTourStep | null {
  return getVisibleProductTourSteps(context).find((step) => step.id === stepId) ?? null
}

export function getProductTourStepIndex(
  stepId: string,
  context: ProductTourRuntimeContext = {},
): number {
  return getVisibleProductTourSteps(context).findIndex((step) => step.id === stepId)
}

export function resolveProductTourStepRoute(
  step: ProductTourStep,
  context: ProductTourRuntimeContext = {},
): string | null {
  if (!step.route) return null
  if (typeof step.route === 'string') return step.route

  return step.route(context)
}
