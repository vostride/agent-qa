// A CI workspace is usually discarded, so lines about unfinished work state the resume limit here.

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
