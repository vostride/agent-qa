export const SHARED_TESTS_SUITES_COLUMN_IDS = [
  "select",
  "name",
  "target",
  "platform",
  "passRate",
  "lastRun",
] as const

export type SharedTestsSuitesColumnId =
  (typeof SHARED_TESTS_SUITES_COLUMN_IDS)[number]

const SHARED_TESTS_SUITES_FIXED_WIDTHS: Partial<
  Record<SharedTestsSuitesColumnId, string>
> = {
  select: "2.75rem",
  target: "10rem",
  platform: "6.25rem",
  passRate: "7.25rem",
  lastRun: "9rem",
}

export function getSharedTestsSuitesColumnWidth(
  columnId: SharedTestsSuitesColumnId,
) {
  return SHARED_TESTS_SUITES_FIXED_WIDTHS[columnId]
}
