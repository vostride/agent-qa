// The canonical id-domain taxonomy — ONE pinned list.
//
// WHAT THIS REPLACES. `packages/agent/src/__tests__/parity-coverage.test.ts` carried the taxonomy as
// a `Set` literal that had been widened seven times, each widening a dated comment arguing its own
// case in place. The literal worked, but the reconciliation it kept promising ("397 folds these")
// never had a home, and a comment inside a `Set` is not something the product can be checked
// against. This file is that home: the taxonomy is DATA, each member states what it owns in one
// line, and `parity.test.ts` censuses the live registry against it in both directions.
//
// ADDING A DOMAIN IS A REVIEWED ONE-LINE DIFF. That is the whole design goal. A capability whose id
// carries a domain absent from this table is a named RED naming the op and the domain — not a silent
// widening, and not a `Set.add` buried in a test file. The reverse direction is asserted too: a
// member here that no shipped capability uses must carry an explicit dated `reserved` sentence, so a
// domain cannot linger as decoration nobody notices is empty.
//
// NO ID IS EVER RENAMED TO SUIT THIS LIST. The ids are the shipped, locked contract — they
// are what a chat user's tool call, an MCP client's tool name and the golden ledger all address. The
// taxonomy serves them. Every one of the seven widenings recorded below happened because that rule
// was applied: the id landed, and the list moved.
//
// ---------------------------------------------------------------------------------------------
// THE FOLD, 2026-08-16.
//
// 384 D-15 fixed the taxonomy at eight domains: tests · runs · memory · analysis · eval · gates ·
// config · agent (the list is still quoted in `packages/agent/src/functions/spec.ts`, which now
// points here instead of repeating it). Six later phases each argued, on its own footing and in a
// dated note, that a capability it was shipping belonged to a domain the eight did not contain:
//
//   * `knowledge`   2026-07-28 (386 planner note) — D-06's locked seed ids include
//                   `knowledge.bundles.list`, so the taxonomy widened rather than the id being
//                   renamed. This is the note that established the rule the five below follow.
//   * `entities`    2026-08-02 — two read verbs over one ADDRESSING surface; filing them
//                   under runs, memory or analysis would have made the domain list decorative.
//   * `quarantine`  2026-08-05 — a lifecycle with its own entry, exit and enumeration
//                   verbs; neither a run, a memory nor an analysis.
//   * `proposals`   2026-08-07 — the decision inbox. The envelope is KIND-generic
//                   (`PROPOSAL_KINDS` is a closed four-member discriminant today), so filing the
//                   inbox under `knowledge.` would have been the tempting move and the wrong one.
//   * `grants`      2026-08-07 — a standing approval OUTLIVES the proposal that minted
//                   it, so the list/revoke pair had to be tellable apart from the inbox verbs at
//                   exactly the moment a person needs to tell them apart.
//   * `authoring`   2026-08-10 — writing a test is the thing runs, memories, analyses,
//                   quarantine entries, proposals and grants are all ABOUT; filing the keep-gate
//                   evaluator under `tests.` would have conflated it with the suite-execution verbs
//                   D-15 reserved that domain for.
//
// Each of those six is a first-class member below, with no residual "extension" status: a domain
// argued for once and shipped is a domain, and marking six of the fourteen as second-class would
// re-create in this file exactly the two-tier taxonomy the fold exists to end.
//
// ONE OF THE SEVEN DATED NOTES DID NOT HOLD, AND THE CORRECTION IS PART OF THE FOLD. The 2026-08-09
// note introduced `agent` as "the sixth taxonomy EXTENSION". It is not an extension:
// `agent` is a member of D-15's original eight (384 CONTEXT D-15; `functions/spec.ts`'s docstring),
// so `agent.ask` needed no widening at all and the `Set.add` was a duplicate — which is why the
// retired literal held FIFTEEN entries for FOURTEEN distinct domains. The 2026-08-10 note inherited
// the arithmetic and called `authoring` "the SEVENTH extension"; it is the sixth. Both counts were
// checked against the code during this fold rather than transcribed, which is how the discrepancy
// surfaced. No id and no domain changes as a result — only the count, and this sentence.
// ---------------------------------------------------------------------------------------------

/** One domain in the canonical taxonomy. */
export interface CanonicalDomain {
  /** The literal first dot-segment of every op id in this domain. */
  readonly domain: string
  /** What this domain owns, in one line — the reviewer's whole basis for accepting a new id here. */
  readonly charter: string
  /**
   * Why no shipped capability carries this domain yet, dated.
   *
   * PRESENT ONLY ON A MEMBERLESS MEMBER, and asserted as such: the census below reds on a member
   * with no matching op and no marker (a domain nobody noticed had emptied) AND on a member that
   * carries a marker while ops exist (a stale reservation nobody noticed had filled). A reserved
   * domain is a NAME HELD, not a gap — the sentence has to say who holds it and against what.
   */
  readonly reserved?: string
}

/**
 * The taxonomy. Fourteen members: D-15's eight, plus the six domains later phases argued for.
 * Fifteen since 2026-09-25: `editor` joined when `editor.liveurl` landed.
 * Thirteen since 2026-10-02: `proposals` and `grants` are removed, not held.
 * Their ops were deleted by 432-17/18 with no alias, and a held name would only argue for
 * reviving an approval surface the phase deleted; nothing parses a persisted id by this list.
 *
 * Sorted by domain so a diff adding one is a single line in a predictable place.
 */
export const CANONICAL_ID_DOMAINS: readonly CanonicalDomain[] = Object.freeze([
  Object.freeze({
    domain: 'agent',
    charter:
      'the conversational orchestrator itself — the turn engine that plans over every other '
      + 'domain, registered here rather than held privately by a REPL (392 D-24)',
  }),
  Object.freeze({
    domain: 'analysis',
    charter: 'derived readings OVER a completed run: the artifacts a run produced, not the run',
  }),
  Object.freeze({
    domain: 'authoring',
    charter:
      'writing and judging TEST SOURCE — draft, edit, verify, and the funnel over those drafts; '
      + 'never the execution of what it wrote (393 D-01)',
  }),
  Object.freeze({
    domain: 'config',
    charter:
      'the project configuration document: reading the masked resolution, and every write to it, '
      + 'including scaffolding (395; direct since 432)',
  }),
  Object.freeze({
    domain: 'editor',
    charter:
      'the dashboard\'s live test editor session — a draft execution a person drives, as '
      + 'distinct from `runs`, which is a queued run\'s record (428 D-07)',
  }),
  Object.freeze({
    domain: 'entities',
    charter:
      'the ADDRESSING surface — turning a reference (exact or free text) into a descriptor of a '
      + 'thing some other domain owns (387 D-09)',
  }),
  Object.freeze({
    domain: 'eval',
    charter:
      'scoring an agent or a suite against a benchmark corpus — the measurement of quality, as '
      + 'distinct from `analysis` reading one run',
    reserved:
      '2026-08-16: held from D-15, unshipped. The eval substrate (M1b) lives in its own packages '
      + 'and reaches no registry verb yet; when it does, its ops land here rather than under '
      + '`analysis.`, which reads ONE run.',
  }),
  Object.freeze({
    domain: 'gates',
    charter:
      'the policy gate as a subject a caller can ask ABOUT — enumerating verdicts, classes and '
      + 'standing posture, as opposed to being gated by it',
    reserved:
      '2026-08-16: held from D-15, unshipped. The gate is reached today only as ENFORCEMENT '
      + '(`invokeFunction` steps 4-5); nothing enumerates it as data (`grants.` retired in 432-18). A '
      + 'future catalogue verb over policy belongs here.',
  }),
  Object.freeze({
    domain: 'knowledge',
    charter:
      'the learned record: bundles, records, diffs, the why-brief, and every write to them '
      + '(386 D-06, 387 KREV-01; direct since 432)',
  }),
  Object.freeze({
    domain: 'memory',
    charter:
      'the run-time recall surface an executing agent reads and writes DURING a run, as opposed '
      + 'to `knowledge`, which is the durable record a person reviews',
    reserved:
      '2026-08-16: held from D-15, unshipped AS A CAPABILITY. The name is already spoken for '
      + 'in-process: `packages/runner`\'s loop exposes `memory.search`/`memory.read` to the model '
      + 'inside a run. Those are RUN-LOOP tools, not registry ops, and a future registry verb '
      + 'here must be named knowing the collision exists.',
  }),
  Object.freeze({
    domain: 'quarantine',
    charter:
      'the quarantine lifecycle over a named test: entry, exit and enumeration of the ledger '
      + '(390 D-13)',
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
      '2026-08-16: held from D-15, unshipped. `runs.start` occupies the execution seam today and '
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
  /** Members matching no op and carrying no dated `reserved` marker. */
  readonly memberless: readonly string[]
  /** Members carrying a `reserved` marker that ops now match — a reservation nobody retired. */
  readonly staleReservations: readonly string[]
}

/**
 * The pure membership core, over an explicit taxonomy argument.
 *
 * TAKING THE TAXONOMY AS A PARAMETER rather than closing over `CANONICAL_ID_DOMAINS` is what lets
 * the control cells drive every branch on synthetic input, without mutating a shipped table and
 * without a skip. A self-check that cannot be shown to fire certifies nothing (the 394 lesson).
 */
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

/**
 * The id GRAMMAR, carried across from the retired 384 stub's taxonomy sweep.
 *
 * Lowercase dot segments and nothing else. The underscore exclusion is load-bearing rather than
 * cosmetic: `chat/tool-names.ts` maps `.` ↔ `_` as a bijection and refuses an id carrying the
 * separator it maps onto, so an id with an underscore would be unreachable from the chat surface —
 * which is why `authoring.draft.verify` is spelled that way and not `authoring.verify_draft`.
 */
export const OP_ID_GRAMMAR = /^[a-z]+(?:\.[a-z]+)+$/
