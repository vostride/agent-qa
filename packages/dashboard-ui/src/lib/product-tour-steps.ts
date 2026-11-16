import { t } from '@/i18n'
import { TOUR_LLM_SETUP_BODY } from '@/lib/config-copy'
import { routes } from '@/lib/routes'
import { normalizeRunStatus } from '@/lib/status'

export const PRODUCT_TOUR_AUTO_START_PATHS = [
  routes.runs,
  routes.tests,
  routes.hooks,
  routes.suites,
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
    get title() {
      return t('tour.intro.title')
    },
    get body() {
      return t('tour.intro.body')
    },
    centered: true,
  },
  {
    id: 'llm-setup',
    get title() {
      return t('tour.llmSetup.title')
    },
    get body() {
      return TOUR_LLM_SETUP_BODY()
    },
    route: routes.configTab('models'),
    targetId: 'tour-config-section',
  },
  {
    id: 'runs',
    get title() {
      return t('tour.runs.title')
    },
    get body() {
      return t('tour.runs.body')
    },
    route: routes.runs,
    targetId: 'tour-runs-table',
  },
  {
    id: 'tests',
    get title() {
      return t('tour.tests.title')
    },
    get body() {
      return t('tour.tests.body')
    },
    route: routes.tests,
    targetId: 'tour-tests-table',
  },
  {
    id: 'suites',
    get title() {
      return t('tour.suites.title')
    },
    get body() {
      return t('tour.suites.body')
    },
    route: routes.suites,
    targetId: 'tour-suites-table',
  },
  {
    id: 'hooks',
    get title() {
      return t('tour.hooks.title')
    },
    get body() {
      return t('tour.hooks.body')
    },
    route: routes.hooks,
    targetId: 'tour-hooks-table',
  },
  {
    id: 'config',
    get title() {
      return t('tour.config.title')
    },
    get body() {
      return t('tour.config.body')
    },
    route: routes.configTab('models'),
    targetId: 'tour-config-section',
  },
  {
    id: 'example-test',
    get title() {
      return t('tour.exampleTest.title')
    },
    get body() {
      return t('tour.exampleTest.body')
    },
    route: (context) => (context.exampleTestId ? routes.testView(context.exampleTestId) : null),
    targetId: 'tour-test-detail-overview',
    include: hasExampleTest,
  },
  {
    id: 'example-missing',
    get title() {
      return t('tour.exampleMissing.title')
    },
    get body() {
      return t('tour.exampleMissing.body')
    },
    route: routes.tests,
    targetId: 'tour-tests-table',
    include: lacksExampleTest,
  },
  {
    id: 'run-action',
    get title() {
      return t('tour.runAction.title')
    },
    get body() {
      return t('tour.runAction.body')
    },
    route: (context) => (context.exampleTestId ? routes.testView(context.exampleTestId) : routes.tests),
    targetId: 'tour-test-run-action',
    include: hasExampleTest,
  },
  {
    id: 'live-run',
    get title() {
      return t('tour.liveRun.title')
    },
    get body() {
      return t('tour.liveRun.body')
    },
    route: (context) => (context.runId ? routes.runLive(context.runId) : null),
    targetId: 'tour-live-run-status',
    include: hasRun,
  },
  {
    id: 'run-detail',
    get title() {
      return t('tour.runDetail.title')
    },
    get body() {
      return t('tour.runDetail.body')
    },
    route: (context) => (context.runId ? routes.runDetail(context.runId) : null),
    targetId: 'tour-run-detail-reasoning',
    include: hasRun,
  },
  {
    id: 'github-nudge',
    get title() {
      return t('tour.githubNudge.title')
    },
    get body() {
      return t('tour.githubNudge.body')
    },
    centered: true,
    action: {
      get label() {
        return t('tour.githubNudge.actionLabel')
      },
      href: PRODUCT_TOUR_GITHUB_URL,
      icon: 'github',
    },
    include: hasSuccessfulRunDetailValue,
  },
  {
    id: 'runs-fallback',
    get title() {
      return t('tour.runsFallback.title')
    },
    get body() {
      return t('tour.runsFallback.body')
    },
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
