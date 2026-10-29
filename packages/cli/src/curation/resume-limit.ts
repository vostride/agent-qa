// a CI workspace is usually thrown away, so in `ci` and
// `cloud` a line about unfinished work states the one condition under which its drainer can still
// reach it, instead of promising a resume. Every such line reads its clause from here.

/** Who can pick the work up: any host (a later run or the daemon), or only a later local run. */
export type ResumeDrainer = 'any-host' | 'masked-leg-only'

const CI_RESUME_CLAUSE: Record<ResumeDrainer, string> = {
  'any-host': "resumes only if this workspace's .agent-qa/ is kept and a later run or the daemon picks it up",
  'masked-leg-only': "resumes only if this workspace's .agent-qa/ is kept and a later local run picks it up",
}

export function isCiContext(context: string | undefined): boolean {
  return context === 'ci' || context === 'cloud'
}

export function resumeLimitClause(drainer: ResumeDrainer): string {
  return CI_RESUME_CLAUSE[drainer]
}

/** The context's resume clause for the work's drainer; `undefined` outside `ci` and `cloud`. */
export function ciResumeClause(
  context: string | undefined,
  drainer: ResumeDrainer,
): string | undefined {
  return isCiContext(context) ? resumeLimitClause(drainer) : undefined
}
