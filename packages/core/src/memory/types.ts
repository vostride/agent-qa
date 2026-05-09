export interface ObservationFrontmatter {
  id: string
  title: string
  trust: number
  created: string
  last_confirmed: string
  confirmed_count: number
  contradicted_count: number
  source_test: string
}

export interface SuiteObservationFrontmatter extends ObservationFrontmatter {
  position: number
  suite_snapshot: Array<{ test: string; id: string }>
}
