// Adding a domain is a one-line diff here; ids are never renamed to suit this list.

/** One domain in the canonical taxonomy. */
export interface CanonicalDomain {
  /** The literal first dot-segment of every op id in this domain. */
  readonly domain: string
  /** What this domain owns, in one line — the reviewer's whole basis for accepting a new id here. */
  readonly charter: string
  /**
   * Why no shipped capability carries this domain yet.
   *
   * PRESENT ONLY ON A MEMBERLESS MEMBER, and asserted as such: the census below reds on a member
   * with no matching op and no marker (a domain nobody noticed had emptied) AND on a member that
   * carries a marker while ops exist (a stale reservation nobody noticed had filled). A reserved
   * domain is a NAME HELD, not a gap — the sentence has to say who holds it and against what.
   */
  readonly reserved?: string
}

// Sorted by domain, so a diff adding one is a single line in a predictable place.
export const CANONICAL_ID_DOMAINS: readonly CanonicalDomain[] = Object.freeze([
  Object.freeze({
    domain: 'agent',
    charter:
      'the conversational orchestrator itself — the turn engine that plans over every other '
      + 'domain, registered here rather than held privately by a REPL',
  }),
  Object.freeze({
    domain: 'analysis',
    charter: 'derived readings OVER a completed run: the artifacts a run produced, not the run',
  }),
  Object.freeze({
    domain: 'authoring',
    charter:
      'writing and judging TEST SOURCE — draft, edit, verify, and the funnel over those drafts; '
      + 'never the execution of what it wrote',
  }),
  Object.freeze({
    domain: 'config',
    charter:
      'the project configuration document: reading the masked resolution, and every write to it, '
      + 'including scaffolding',
  }),
  Object.freeze({
    domain: 'editor',
    charter:
      'the dashboard\'s live test editor session — a draft execution a person drives, as '
      + 'distinct from `runs`, which is a queued run\'s record',
  }),
  Object.freeze({
    domain: 'entities',
    charter:
      'the ADDRESSING surface — turning a reference (exact or free text) into a descriptor of a '
      + 'thing some other domain owns',
  }),
  Object.freeze({
    domain: 'eval',
    charter:
      'scoring an agent or a suite against a benchmark corpus — the measurement of quality, as '
      + 'distinct from `analysis` reading one run',
    reserved:
      'Held, unshipped. The eval substrate lives in its own packages '
      + 'and reaches no registry verb yet; when it does, its ops land here rather than under '
      + '`analysis.`, which reads ONE run.',
  }),
  Object.freeze({
    domain: 'gates',
    charter:
      'the policy gate as a subject a caller can ask ABOUT — enumerating verdicts, classes and '
      + 'standing posture, as opposed to being gated by it',
    reserved:
      'Held, unshipped. The gate is reached today only as ENFORCEMENT '
      + '(`invokeFunction` steps 4-5); nothing enumerates it as data (there are no `grants.` ops). A '
      + 'future catalogue verb over policy belongs here.',
  }),
  Object.freeze({
    domain: 'knowledge',
    charter:
      'the learned record: bundles, records, diffs, the why-brief, and every write to them',
  }),
  Object.freeze({
    domain: 'memory',
    charter:
      'the run-time recall surface an executing agent reads and writes DURING a run, as opposed '
      + 'to `knowledge`, which is the durable record a person reviews',
    reserved:
      'Held, unshipped AS A CAPABILITY. The name is already spoken for '
      + 'in-process: `packages/runner`\'s loop exposes `memory.search`/`memory.read` to the model '
      + 'inside a run. Those are RUN-LOOP tools, not registry ops, and a future registry verb '
      + 'here must be named knowing the collision exists.',
  }),
  Object.freeze({
    domain: 'quarantine',
    charter:
      'the quarantine lifecycle over a named test: entry, exit and enumeration of the ledger',
  }),
  Object.freeze({
    domain: 'runs',
    charter:
      'one execution of a suite — starting it, enumerating and reading them, and the durable '
      + 'work downstream of a completed one (events, postprocessing, digest)',
  }),
  Object.freeze({
    domain: 'tests',
    charter:
      'EXECUTING authored tests — selecting and running a suite, as distinct from `authoring` '
      + '(which writes them) and `runs` (which is one execution\'s record)',
    reserved:
      'Held, unshipped. `runs.start` occupies the execution seam today and '
      + 'is addressed as a RUN. A selection/execution verb phrased about the tests themselves '
      + 'would land here; nothing ships one.',
  }),
] as const satisfies readonly CanonicalDomain[])

/** The domain of an op id: its first dot-segment, or the whole string when it carries no dot. */
export function domainOf(opId: string): string {
  const separator = opId.indexOf('.')
  return separator === -1 ? opId : opId.slice(0, separator)
}

/**
 * The two ways a taxonomy and a live id set can disagree.
 *
 * BOTH SIDES ARE NAMED, never counted: the census cell's whole value is that its failure message
 * says which op carries which uncatalogued domain, or which member has quietly emptied.
 */
export interface DomainCensusDiff {
  /** Op ids whose domain is not a member of the list — the mandatory direction. */
  readonly uncatalogued: readonly string[]
  /** Members matching no op and carrying no `reserved` marker. */
  readonly memberless: readonly string[]
  /** Members carrying a `reserved` marker that ops now match — a reservation nobody retired. */
  readonly staleReservations: readonly string[]
}

// The taxonomy is a parameter, so the control cells drive every branch on synthetic input.
export function domainCensus(
  opIds: readonly string[],
  taxonomy: readonly CanonicalDomain[] = CANONICAL_ID_DOMAINS,
): DomainCensusDiff {
  const members = new Map(taxonomy.map((entry) => [entry.domain, entry]))
  const used = new Set(opIds.map(domainOf))

  const uncatalogued = opIds.filter((opId) => !members.has(domainOf(opId))).sort()
  const memberless: string[] = []
  const staleReservations: string[] = []
  for (const entry of taxonomy) {
    const inUse = used.has(entry.domain)
    if (!inUse && entry.reserved === undefined) memberless.push(entry.domain)
    if (inUse && entry.reserved !== undefined) staleReservations.push(entry.domain)
  }

  return Object.freeze({
    uncatalogued: Object.freeze(uncatalogued),
    memberless: Object.freeze(memberless.sort()),
    staleReservations: Object.freeze(staleReservations.sort()),
  })
}

// No underscores: chat maps `.` to `_` as a bijection, so an id with `_` is unreachable from chat.
export const OP_ID_GRAMMAR = /^[a-z]+(?:\.[a-z]+)+$/
