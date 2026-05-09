import { shouldRouteRunToLive } from '@/lib/status'

export const routes = {
  runs: '/runs',
  tests: '/tests',
  testNew: '/tests/new',
  hooks: '/hooks',
  hookNew: '/hooks/new',
  memory: '/memory',
  insights: '/insights',
  config: '/config',

  runDetail: (id: string) => `/runs/${id}`,
  runLive: (id: string) => `/runs/${id}/live`,
  runDetailOrLive: (id: string, status: string) =>
    shouldRouteRunToLive(status) ? `/runs/${id}/live` : `/runs/${id}`,
  testView: (testId: string) => `/test/${testId}`,
  testEdit: (testId: string) => `/test/${testId}/edit`,
  testEditLive: (testId: string) => `/test/${testId}/edit?live=1`,
  hookView: (hookId: string) => `/hook/${hookId}`,
  hookEdit: (hookId: string) => `/hook/${hookId}/edit`,
  memoryProduct: (product: string) => `/memory/${product}`,
  suites: '/suites',
  suiteNew: '/suites/new',
  suiteView: (suiteId: string) => `/suite/${suiteId}`,
  suiteEdit: (suiteId: string) => `/suite/${suiteId}/edit`,
  configItem: (bucket: string, item: string) => `/config?bucket=${bucket}&item=${item}`,
} as const
