// Gate 4 — the static assertion-strength check (393, WTST-02; D-09, D-10, D-11, D-12).
//
// ONE classification, THREE views. `classifyDraftSteps` is the only place a step is ever
// judged; `assertionStrengthGate` folds its rows into the receipt-facing gate result, and
// `evaluateAssertionStrength` projects the same rows onto the shape plan 01's frozen proving
// suite pinned before any of this existed. Two of those views exist because two consumers
// named two shapes first, and the alternative — teaching one of them the other's spelling —
// would have meant editing an artifact whose whole value is that the implementation did not
// get to choose it. A projection is cheap; a second judgment would be two answers to
// "is this draft's oracle real", free to disagree.
//
// DETERMINISTIC BY CONSTRUCTION. No I/O, no clock, no config, no model. The hermetic
// lane runs this per-commit with no LLM by contract, which is only possible if the check
// cannot reach one.
//
// AMBIGUITY TUNES TOWARD REJECT. Every borderline arm below returns "not falsifiable".
// That is defensible only because the rejection is READABLE: the per-step table lands verbatim
// in the receipt, so a rejected author is told which step was called what, which vacuity
// phrase it matched, and which capture pattern named its expected value. A gate that tunes
// toward reject without saying why is just a gate that says no.

import type { StepClassificationRow } from '@vostride/agent-qa-schema'

/**
 * The minimal structural mirror of a parsed draft's step list.
 *
 * Declared HERE rather than imported because the dependency points the other way — this
 * package never names `core`, where `parseTestFile` lives, and acquiring that import would
 * be a `validate:arch` violation with no legal repair (the `TestOutcomeHistoryLike`
 * precedent in `jobs/kinds.ts`). The HOST parses and flattens: `parseTestFile` yields steps
 * as `string | { step: string }`, and the caller narrows to text before handing them down
 * (the parse-at-host precedent in `cli/src/curation/authoring-test-discovery.ts`).
 */
export interface ParsedDraftStepsLike {
  readonly steps: readonly string[]
}

/**
 * The closed assertion-verb set — D-09 clause (i).
 *
 * A PINNED CONSTANT, never config. RETUNE COMMENT: these six are the verbs a person
 * writes when the next sentence is a CLAIM about the app rather than an instruction to it.
 * Every verb added here is a verb that can now open an assertion, which moves the gate's
 * numerator directly — clause (i) is satisfiable by one more shape of step, and every draft
 * that previously failed for having no assertion at all starts failing (or passing) for a
 * different reason. So add one only with a real draft that it rescues, and re-run the frozen
 * corpus afterwards: the expectations table is the denominator that says whether the widening
 * was a fix or a leak.
 *
 * Matching is on the step's LEADING token, exactly and case-insensitively — membership never
 * position, exact never substring. `Verifying` begins with a member and is not one;
 * `Type "alice" into the Verify field` contains a member and asserts nothing.
 *
 * Order is alphabetical and NOT load-bearing: the set is read by membership, never scanned.
 */
export const ASSERTION_VERBS = [
  'assert',
  'check',
  'confirm',
  'ensure',
  'expect',
  'verify',
] as const

/**
 * The closed action-verb set — used ONLY to detect a mixed act-and-verify step.
 *
 * A PINNED CONSTANT, never config. RETUNE COMMENT: these fourteen are the verbs that open an
 * INSTRUCTION to the app. They are read at exactly one place — the leading token of a clause
 * that follows a separator inside an assertion step — and never scanned across a whole step,
 * which is what keeps `Verify the Submit button is disabled` an ordinary assertion about an
 * element that happens to be named after an action. Widening this set makes MORE assertions
 * mixed and therefore non-falsifiable, so it moves the numerator toward reject; narrowing it
 * moves the numerator toward accept, which is the direction that costs a user a bad test.
 * Either way, re-run the frozen corpus.
 */
export const ACTION_VERBS = [
  'click',
  'drag',
  'enter',
  'fill',
  'hover',
  'navigate',
  'open',
  'press',
  'scroll',
  'select',
  'submit',
  'type',
  'upload',
  'visit',
] as const

/**
 * The closed vacuity set — D-09 clause (ii).
 *
 * A PINNED CONSTANT, never config. RETUNE COMMENT: a member is a whole assertion remainder
 * that, standing alone, is true of any page the browser managed to render — it names no
 * content, no element and no state that could have come out differently. `page loaded`
 * qualifies; `page shows the text "Username"` does not, and neither does anything that names
 * a thing the app could be wrong about. Every phrase added here REJECTS a draft that used to
 * pass, so add one only with the draft it catches, and re-run the frozen corpus.
 *
 * Matched EXACTLY against the normalized remainder — the step with its leading verb, its
 * leading articles and its trailing punctuation removed — and never as a substring of the raw
 * step. `Verify the banner says "the page loaded"` contains a member and is a concrete
 * assertion about page content; a substring scan rejects it, which is a real draft lost to a
 * lexicon that reached past its own boundary.
 *
 * ITS TWO JOBS, AND WHICH ONE IS LIVE TODAY. The lexicon NAMES the phrase on the receipt, which
 * is load-bearing now (D-11 — the author has to be told which term was called empty). It also
 * sits as a conjunct in the falsifiability rule, and that conjunct decides nothing on the
 * current membership: no member contains an `EXPECTED_STATE_TERMS` token, so a remainder that
 * equals a member is already non-concrete and refused by the other arm. It is kept as a guard
 * against exactly the widening this comment invites, and 393-15 re-derived WHICH widening that is.
 * `page is visible` is not the candidate: `namesElementInExpectedState` walks left from `visible` and
 * answers on the `PAGE_WHOLE_NOUNS` member `page`, so the concreteness arm refuses it first — in
 * every casing, and under every padding (a padding word the walk may cross reaches `page` anyway,
 * and one it may not stops the walk, which refuses too). The member that would hand this conjunct
 * the whole decision is one carrying an `EXPECTED_STATE_TERMS` token whose nearest content word to
 * the LEFT is an `ELEMENT_NOUNS` member: `banner is visible` is that shape.
 * The guard still has a live trigger rather than a promise — `assertion-strength.test.ts`'s
 * cross-lexicon closure case walks every member and reds if the conjunct goes away under such a
 * widening.
 *
 * Order is alphabetical and NOT load-bearing: the set is read by membership.
 */
export const VACUOUS_ASSERTION_PHRASES = [
  'it works',
  'no errors',
  'no errors occurred',
  'page appears',
  'page displayed',
  'page is displayed',
  'page loaded',
  'page loads',
  'page works',
] as const

/**
 * The closed expected-state set — the second falsifiability arm of D-09 clause (ii).
 *
 * A PINNED CONSTANT, never config. RETUNE COMMENT: a member is a binary, observable state an
 * element is either in or not. It counts as concrete expected content only BESIDE a named
 * element (see `namesElementInExpectedState`), because `is visible` on its own says visible what.
 * Widening this set makes more assertions falsifiable without a quoted literal, which is the arm
 * most likely to accept a weak oracle — re-run the frozen corpus, and prefer a quoted literal.
 *
 * WHAT ONE RETUNE HERE MOVES — RE-DERIVED 2026-08-10. This set is the relation's ANCHOR:
 * every member is a position the leftward walk starts from. A member added here therefore widens
 * WHICH STATES count as checkable and nothing else — the element side of the relation still answers
 * by `ELEMENT_NOUNS` membership alone, and the refusal side by everything that is not an element
 * member (a named page-whole noun, or, since 393-17, any token outside the walk's continue set).
 * (Between 393-12 and 393-13 a member added here was ALSO excluded from element-name candidacy, so
 * one retune moved two measurements in opposite directions; that coupling is gone. What replaced it
 * is a READ, not a coupling: the set is consumed as anchor positions, which is why the earlier
 * "never reads this set at all" phrasing no longer holds and is corrected here rather than
 * silently dropped — the W-10 record on this lexicon stays continuous.)
 */
export const EXPECTED_STATE_TERMS = [
  'checked',
  'disabled',
  'empty',
  'enabled',
  'hidden',
  'selected',
  'unchecked',
  'visible',
] as const

/**
 * The closed element-noun set — the positive lexicon that resolves the relation TRUE.
 *
 * A PINNED CONSTANT, never config. RETUNE COMMENT, AND ITS DIRECTION IS THE INVERSE OF THE THREE
 * EXCLUSION SETS THIS REPLACED: a member is a common name for a CONTROL or a LANDMARK on a page —
 * a thing an author points at, that the app could be wrong about. ADDING a member moves the gate
 * toward ACCEPT: every vacuous-shaped claim naming that noun starts passing, which is the direction
 * that costs a user a bad test. So a member arrives only with a real draft it rescues, plus a
 * re-run of the frozen corpus — the expectations table is the denominator that says whether the
 * widening was a fix or a leak. REMOVING a member refuses drafts: D-12's safe direction, still a
 * real cost.
 *
 * Read by exact membership over a NORMALIZED (lowercased, non-letters stripped) residue token —
 * membership never position, exact never substring.
 *
 * WHAT IS DELIBERATELY ABSENT. The page-whole nouns — app, browser, content, form, page, screen,
 * site — are NOT members, because a claim naming only those says nothing an author could have got
 * wrong about a particular thing. That absence is a NECESSARY condition of refusing `page is visible`
 * and `the form is empty` — the walk tests element membership first, so a page-whole noun listed here
 * would resolve those claims TRUE before any refusal branch is reached — and it is load-bearing in
 * exactly that sense: adding `form` here would re-open the claim D-12 exists to reject. What it is
 * no longer is SUFFICIENT on its own; since 393-17 a non-member is refused by the walk's stop rather
 * than merely failing to be accepted, which is what makes the refusal hold for nouns nobody listed.
 *
 * Order is alphabetical and NOT load-bearing: the set is read by membership.
 */
export const ELEMENT_NOUNS = [
  'alert',
  'banner',
  'button',
  'checkbox',
  'dialog',
  'dropdown',
  'field',
  'footer',
  'header',
  'heading',
  'icon',
  'image',
  'input',
  'label',
  'link',
  'list',
  'menu',
  'modal',
  'option',
  'panel',
  'popup',
  'radio',
  'row',
  'sidebar',
  'slider',
  'spinner',
  'tab',
  'table',
  'textbox',
  'toast',
  'toggle',
  'toolbar',
  'tooltip',
] as const

/**
 * The closed page-whole noun set — the relation's SUBJECT REFUSER.
 *
 * A PINNED CONSTANT, never config, and it is exactly the seven nouns the `ELEMENT_NOUNS` doc above
 * already names as deliberately absent. It is declared as its own set because the relation needs to
 * ACT on them — a page-whole noun standing between a state term and any element noun to its left is
 * the claim's subject, and it stops the walk — where absence from `ELEMENT_NOUNS` only makes them
 * non-elements.
 *
 * READ IN EXACTLY ONE PLACE: inside `namesElementInExpectedState`'s leftward walk, as the token that
 * resolves an occurrence FALSE. It is never scanned across a whole residue on its own. An
 * independent whole-input scan of a third lexicon is the shape the round-5 verification named as the
 * cause of the defect this set exists to close, and re-introducing it here would reproduce it.
 *
 * RETUNE COMMENT, AND ITS DIRECTION IS THE OPPOSITE OF `ELEMENT_NOUNS`'. ADDING a member moves the
 * gate toward REJECT: every claim whose nearest non-function-word before a state term is that member
 * is refused BY NAME. That is D-12's safe direction and still a real cost, so a member arrives with
 * the vacuous draft it catches plus a frozen-corpus re-run. Since 393-17 REMOVING a member no longer
 * moves the verdict at all — the walk's default stop refuses the same token one branch later — and
 * OMISSION, including omission by inflection or by synonym, behaves the same way and therefore fails
 * toward REJECT. Before that it did not: the walk crossed whatever this set failed to spell, so an
 * omission here was measurably an ACCEPT-direction hole in a tune-toward-reject gate, and a plural
 * was enough to open it. What the set still carries, now that it no longer carries the verdict, is
 * the refusal's NAME — it says which class of subject the gate is refusing, where the default stop
 * can only say "not an element" — plus the intent it pins and the disjointness discipline below.
 *
 * A token may not be a member of this set and of `ELEMENT_NOUNS` (or of `EXPECTED_STATE_TERMS`):
 * the walk would have two answers for it. The disjointness is pinned in the lexicon-discipline
 * group of `__tests__/assertion-strength.test.ts`.
 *
 * Order is alphabetical and NOT load-bearing: the set is read by membership.
 */
export const PAGE_WHOLE_NOUNS = [
  'app',
  'browser',
  'content',
  'form',
  'page',
  'screen',
  'site',
] as const

/**
 * The closed function-word set — the leftward walk's CONTINUE set.
 *
 * A PINNED CONSTANT, never config. These are the ONLY tokens the walk may cross between an
 * expected-state term and the noun that is its subject. Everything else stops the walk, which is
 * what makes the refuser TOTAL rather than enumerated: a subject head this module has never heard
 * of refuses the claim instead of being walked through in search of a member in another clause.
 *
 * WHY THESE NINE. `is`, `not` and `still` are what the accept controls require — `Verify the submit
 * button is disabled`, `Verify The Submit Button Is Not Visible`, `Verify the username field is
 * still empty` are real drafts that must keep gate 4. The rest is the closed be-copula paradigm
 * (`are`, `be`, `been`, `being`, `was`, `were`), included as a paradigm rather than one tense at a
 * time because a verdict that moved when an author wrote `was` for `is` would be the one-character
 * flip this round exists to remove.
 *
 * WHAT IS DELIBERATELY EXCLUDED, and each exclusion is load-bearing. CONJUNCTIONS: they mark the
 * clause boundary the walk must never cross, so admitting `and` would re-open the cross-clause
 * rescue by construction — the exact defect. PREPOSITIONS: a preposition heads a noun phrase, so a
 * noun always stands between the member and the anchor and that noun decides first; admitting the
 * preposition would only let the walk reach past its own object. ARTICLES: an article always stands
 * to the LEFT of its own noun, so it is never reachable between a member and its state term, and
 * listing it would be a member with no live position. And every open adverb class beyond `still`
 * and `not`, because an open class cannot be closed and a set that tries is a set that leaks.
 *
 * RETUNE COMMENT, and its direction is `ELEMENT_NOUNS`' rather than `PAGE_WHOLE_NOUNS`'.
 * ADDING a member is an ACCEPT-direction move — one more token the walk may bridge, so claims that
 * were refused start passing — and therefore arrives with the real draft it rescues plus a
 * frozen-corpus re-run. OMISSION fails toward REJECT: an exotic intervening adverb refuses a genuine
 * claim, which is a real cost and the SAFE rot direction, priced beside the other accepted costs on
 * `namesElementInExpectedState`. That asymmetry is the whole point of the set — the pre-fix posture
 * had a lexicon whose omissions failed toward ACCEPT, and this one cannot.
 *
 * Read in exactly one place: inside the walk, as the continue case. Never scanned across a residue.
 * Not exported from the agent barrel (the `PAGE_WHOLE_NOUNS` precedent).
 *
 * Order is alphabetical and NOT load-bearing: the set is read by membership.
 */
export const FUNCTION_WORDS = [
  'are',
  'be',
  'been',
  'being',
  'is',
  'not',
  'still',
  'was',
  'were',
] as const

/**
 * The closed capture-signature set — D-10, the oracle-capture class.
 *
 * A PINNED CONSTANT, never config. RETUNE COMMENT: a member matches a value only a CAPTURE
 * could have produced — a run's own output pasted in as the expectation, which asserts what
 * the app did rather than what it should do. Every pattern is anchored at BOTH ends and is
 * applied to a single whitespace-delimited token of a quoted expected value, never to the
 * step's prose: an unanchored machine-content pattern starts rejecting sentences, which is
 * how a heuristic about ids becomes a heuristic about English.
 *
 * Adding a pattern rejects drafts that used to pass, so add one with the draft it catches and
 * with a human-authored value it must NOT catch — the false-positive control is the half that
 * is easy to skip and expensive to omit.
 *
 * SCOPE, honestly (D-10, the W-09 discipline): this narrows the oracle-capture class, it does
 * not eliminate it. A semantically wrong but syntactically clean expectation — a plausible
 * human-shaped value that simply is not what the app should show — passes every pattern here.
 * 394's authoring provenance is the closure that remains. 2026-09-02: bug-repro
 * anchoring left with the Issue-slot cleanup.
 *
 * Order is by name, alphabetically, and is NOT load-bearing: every pattern is tried and the
 * hits are reported as a sorted set.
 */
export const CAPTURE_SIGNATURE_PATTERNS = [
  { name: 'iso-8601-timestamp', pattern: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/ },
  { name: 'long-hex', pattern: /^[0-9a-f]{16,}$/i },
  { name: 'opaque-id', pattern: /^(?:sess|session|tok|token|sk|pk|id|ref|txn|ord)[_-][A-Za-z0-9]{8,}$/i },
  { name: 'uuid', pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
] as const

/**
 * The closed separator set for a MIXED act-and-verify step.
 *
 * A PINNED CONSTANT, never config. RETUNE COMMENT: these are the joins a person types when
 * one step secretly contains two — `Verify the form is submitted and click Continue`. A step
 * like that has no single verdict to report, so it contributes no falsifiable assertion and
 * the author is told to split it.
 *
 * Declared HERE rather than imported from `chat/clause-split.ts`, which pins a near-identical
 * set for the conjunction grammar. That is deliberate and it is the one duplication in this
 * file: the chat separators move the CHAT-03 refusal rate and these move the gate-4 numerator,
 * and a single shared constant would make one retune silently move two unrelated measurements
 * (the W-10 lesson). The sets are allowed to drift because the questions are different.
 *
 * The word tokens carry their own whitespace, which IS the word-boundary rule: ` and ` cannot
 * match inside `command`. A separate boundary check would be a second answer to a question the
 * token spelling already answers, free to disagree with it.
 */
const MIXED_STEP_SEPARATORS = [' and ', ' then ', ';', ','] as const

/** Leading determiners stripped before the vacuity lexicon is consulted. */
const LEADING_ARTICLES = ['a', 'an', 'that', 'the'] as const

const TRAILING_PUNCTUATION_RE = /[.!?,;:\s]+$/
const QUOTED_LITERAL_RE = /"([^"]*)"/g

/**
 * An unquoted money amount: a currency symbol with a number (446-11, D-25, the owner's decision).
 *
 * A PINNED PATTERN, never config. It widens D-09 clause (ii) toward ACCEPT, the direction every
 * retune comment in this file warns about, so the case is stated here. `$29.00` names the one value
 * the page must show exactly as `"$29.00"` does: the page shows that amount or it does not, so a
 * wrong total fails the step. The currency symbol is what marks a value the page displays rather
 * than a count in the instruction, which is why bare numbers (`1 item`, `29.00`), a symbol with no
 * number, and vague wording (`the total is correct`) stay refused. The five symbols are the ones
 * 440's stated values read, so a price the request states and the draft keeps is one this gate
 * accepts. Read from the unquoted residue only, and compared against earlier actions' quoted spans
 * and money amounts, so restating a typed price, quoted or not, is still a tautology. The frozen
 * corpus verdicts did not move (re-checked in 446-11 and 446-17); re-run it on any change here.
 */
const MONEY_AMOUNT_RE = /(?<![\p{L}\p{N}])[$€£¥₹]\d+(?:[.,]\d+)*(?![\p{L}\p{N}])/gu

/** The frozen contract shape plan 01's `corpus-static-gates.test.ts` pinned. */
export interface AssertionStrengthStep {
  readonly text: string
  readonly kind: 'assertion' | 'action'
  readonly falsifiable: boolean
  readonly captureSignatureHits: string[]
}

/** @see AssertionStrengthStep */
export interface AssertionStrengthResult {
  readonly falsifiable: boolean
  readonly steps: AssertionStrengthStep[]
}

/**
 * The receipt-facing gate result.
 *
 * The counts and the reason are here rather than derived by the receipt assembler because
 * `DraftGateResults.falsifiableAssertion` asks for exactly these three fields beside `pass`,
 * and a consumer recounting the table would be a second answer to a question this function
 * already answered (388 C13, one exported vocabulary).
 */
export interface AssertionStrengthGateResult {
  readonly pass: boolean
  readonly assertionStepCount: number
  readonly falsifiableAssertionCount: number
  readonly reason: string
  readonly table: StepClassificationRow[]
}

function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z]/g, '')
}

function leadingToken(text: string): string {
  return normalizeToken(text.trim().split(/\s+/)[0] ?? '')
}

function isAssertionVerb(token: string): boolean {
  return (ASSERTION_VERBS as readonly string[]).includes(token)
}

function isActionVerb(token: string): boolean {
  return (ACTION_VERBS as readonly string[]).includes(token)
}

/**
 * Every double-quoted span of a step, unfiltered — what the author actually typed.
 *
 * TWO VIEWS BECAUSE THERE ARE TWO QUESTIONS. This RAW view answers the TAUTOLOGY question:
 * an action that typed `""` really did type it, and an assertion restating that same span is still
 * restating a prior action's own content. `quotedLiterals` below answers the CONCRETENESS question:
 * an empty span expects nothing, so it cannot be the expected value that makes an assertion
 * falsifiable. Each consumer reads the view that matches its own question, which is what keeps the
 * two paths from disagreeing about the question each is actually asking.
 *
 * THE COST THE SINGLE FILTERED VIEW CHARGED, recorded rather than absorbed (WR-01, measured by the
 * round-5 verifier). 393-13 introduced the trim filter at the producer, so the prior-action
 * accumulation was starved of empty captures too. Two shapes moved FAIL -> PASS undisclosed:
 * `Type "" into the Username field` + `Verify the Username field is empty and shows ""`, and the
 * whitespace-literal form of the same pair. Both are tautologies and both are now refused again,
 * pinned in both directions — the two pairs refused, and an accept control (an assertion that
 * quotes nothing after an empty capture) held passing so the restoration cannot over-reject.
 */
function quotedSpans(text: string): string[] {
  return [...text.matchAll(QUOTED_LITERAL_RE)].map((match) => match[1] ?? '')
}

/**
 * The double-quoted spans that carry expected CONTENT — empty and whitespace-only spans dropped.
 *
 * The filter is a `trim` test rather than a falsiness test because `" "` asserts exactly as little
 * as `""` does. Without it, bare `Verify ""` satisfied `literals.length > 0` and short-circuited
 * the concreteness arm — a quoted expected value that expects nothing. Read by the
 * concreteness arm and by the capture-signature scan; never by the tautology comparison.
 */
function quotedLiterals(text: string): string[] {
  return quotedSpans(text).filter((literal) => literal.trim() !== '')
}

/** The step with every double-quoted span removed, so prose scans cannot read a literal. */
function unquotedResidue(text: string): string {
  return text.replace(QUOTED_LITERAL_RE, ' ')
}

function moneyAmounts(text: string): string[] {
  return unquotedResidue(text).match(MONEY_AMOUNT_RE) ?? []
}

/** The step after its leading token, byte-for-byte — every caller normalizes for itself. */
function afterLeadingToken(text: string): string {
  const trimmed = text.trim()
  const boundary = trimmed.search(/\s/)

  return boundary === -1 ? '' : trimmed.slice(boundary + 1).trim()
}

/**
 * The assertion remainder the vacuity lexicon is matched against, EXACTLY.
 *
 * Leading verb, then leading articles one at a time, then trailing punctuation. Articles are
 * stripped iteratively because `that the page is displayed` carries two, and a single pass
 * would leave a remainder that no member can equal — which reads as "not vacuous" and is the
 * failure direction that costs a user a bad test.
 */
function vacuityRemainder(text: string): string {
  let remainder = afterLeadingToken(text).toLowerCase().replace(/\s+/g, ' ').trim()

  for (;;) {
    const head = remainder.split(' ')[0] ?? ''
    if (!(LEADING_ARTICLES as readonly string[]).includes(head)) break
    remainder = remainder.slice(head.length).trim()
  }
  return remainder.replace(TRAILING_PUNCTUATION_RE, '')
}

/**
 * Whether an assertion step secretly contains an instruction.
 *
 * A separator, and then a clause whose OWN leading token is an action verb. The leading-token
 * rule is the same one role classification uses, and for the same reason: an action verb
 * appearing anywhere in a sentence says nothing, while an action verb opening a clause is an
 * instruction. Quoted spans are removed first — the literal a page must show may itself read
 * `Click here to continue`, and rejecting that draft would be the lexicon reaching past its
 * own boundary again.
 */
function isMixedActAndVerify(text: string): boolean {
  const residue = unquotedResidue(text)

  for (const separator of MIXED_STEP_SEPARATORS) {
    const pieces = residue.split(separator)
    if (pieces.length < 2) continue
    if (pieces.slice(1).some((piece) => isActionVerb(leadingToken(piece)))) return true
  }
  return false
}

/**
 * Whether the assertion names an element that is IN an expected state — D-09 clause (ii)'s second
 * route to concreteness, as ONE relation rather than two unrelated scans.
 *
 * THE RULE ENFORCED, verbatim. The post-verb residue, with double-quoted spans already
 * removed, is tokenized ONCE: split on whitespace, each piece through `normalizeToken` (lowercased,
 * non-letters stripped). For every index whose token is an `EXPECTED_STATE_TERMS` member, walk LEFT
 * from that index one token at a time and answer on the FIRST token that is not a function word: an
 * `ELEMENT_NOUNS` member resolves that occurrence TRUE, a `PAGE_WHOLE_NOUNS` member resolves it
 * FALSE, a `FUNCTION_WORDS` member is crossed and the walk continues, and ANY OTHER token resolves
 * it FALSE and stops. Reaching the start of the residue resolves it FALSE too. CONTINUING is the
 * enumerated case and STOPPING is the default, which is what makes the refuser total: a subject head
 * outside all three sets refuses the claim rather than being walked through until some member turns
 * up. The answer is true iff at least one state-term occurrence resolves TRUE. The `PAGE_WHOLE_NOUNS`
 * branch stands AHEAD of the stop and is redundant with it on today's memberships — the stop would
 * refuse those same seven tokens one branch later — and it is kept because it names the refusal
 * class the gate exists for, which the default stop cannot say. Letter case is never consulted:
 * `normalizeToken` lowercases, so a step and any recasing of it get the identical verdict by
 * construction. There is no distance constant anywhere in the rule: what decides is WHICH token the
 * walk meets first, never how far away it sat — and because everything outside the continue set
 * stops the walk, no verdict can now depend on how many words the sentence put in between.
 *
 * One tokenization consequence, deliberate and in D-12's direction: a state term fused into a
 * hyphenated compound normalizes into a single token that is no longer a member, so the compound
 * anchors nothing and the claim is refused. Punctuation merely attached to a state term
 * (`visible.`) still normalizes clean and anchors as usual.
 *
 * WHY THE RULE IS SHAPED THIS WAY (five regressions, every one of them measured, 2026-08-10 and
 * 2026-08-11, phase 393 verification rounds 2–6). The FIRST rule read any post-verb word beginning with a capital
 * letter as an element name, on the house-style premise that a draft writes `the Submit button`.
 * Title-cased prose defeated it outright: `Verify The Page Is Visible` — the exact vacuous claim
 * D-12 exists to refuse — passed gate 4 while its lowercase twin was refused, and the drafts this
 * filter exists for are LLM-authored and commonly title-cased. The SECOND rule kept the capital and
 * added a neighbour condition — the residue had to carry a capital-initial word beside a
 * lowercase-initial one — which removed only the two degenerate casings and left the whole
 * mixed-case interior open: `Verify the Page is visible` PASSED, one character from the refused
 * form, while `Verify The Submit Button Is Disabled` — a real control in a binary observable state
 * — FAILED. The THIRD rule removed the casing axis entirely and asked instead whether some residue
 * token was a member of NONE of three exclusion lists. That closed the casing axis for good, and
 * the defect simply moved: every ordinary function word nobody had thought to list — a negation, a
 * modal, an adverb, a copula — was outside all three sets and therefore read as an element name, so
 * `Verify the page is not visible` PASSED while `Verify the page is visible` was refused, and seven
 * more paddings of the same vacuous claim with it. The FOURTH rule inverted to one positive element
 * lexicon, which fixed the MEMBERSHIP half and left the POSITIONAL half untouched: element-naming
 * and state-bearing were still two independent membership scans over the whole residue, conjoined
 * with no relation between them, so the gate answered "a named element in a checkable state" for any
 * sentence that merely MENTIONED a lexicon member — as a trailing prepositional object, as a verb,
 * or sixty spaces away. All 33 members of the element lexicon were measured carrying the vacuous
 * generic-page claim in one frame, and the round's old-vs-new differential showed that fix had not
 * moved the case in either direction. The common cause: an unrelated conjunction of two whole-input
 * scans is strictly WEAKER than the rule it implements, because it can be satisfied by two facts
 * about different parts of the sentence. Relating the arms — one tokenization, one walk, one
 * decision per state term — is what makes the composed predicate say what D-09 clause (ii) says.
 * The FIFTH rule related the arms correctly and then privileged the claim's subject only when that
 * subject was one of seven exact spellings: every other subject token was crossed rather than
 * answered on, so the walk kept going left, past the subject and across the clause boundary, until
 * some element noun turned up. Inflection alone defeated it — a page-whole subject written in the
 * plural, or with a synonym the seven-member set did not hold, or hyphenated so it normalized into
 * one unrecognized token, handed the verdict to a noun in a different clause with no state asserted
 * of it. A single trailing character flipped the answer, which is the same defect as the SECOND
 * rule's one-character boundary wearing a different lexicon. The common cause with the fourth is
 * that both let an ENUMERATION carry the refusal: a rule that refuses only what it can name is
 * strictly weaker than the rule it implements, because the sentences it has never heard of fall to
 * the accepting side. Making the refusal the DEFAULT and the crossing the enumeration is what
 * removes the spelling dependency, and it is why the continue set may only ever hold a closed class.
 *
 * The removed rules are described in words on purpose. Naming their functions or restating their
 * character classes here would leave a durable, greppable account of a mechanism that no longer
 * exists, which is how a comment starts teaching the shape it was written to retire.
 *
 * RESIDUAL, accepted and named — BOTH of them, and the width claim is RE-DERIVED from the shipped
 * walk rather than carried forward (393-17; the round-6 disclosure asserted the same width over a
 * rule that had a third bypass, which is what made the claim false). The derivation: an occurrence
 * resolves TRUE only when an `ELEMENT_NOUNS` member stands to the left of the anchor with nothing
 * but `FUNCTION_WORDS` members in between, and no clause-boundary token — no conjunction, no
 * separator, no unknown noun — is in that set. So TRUE now requires the member to occupy the
 * anchor's own subject position under a nearest-content-word reading, and the two bypasses below
 * are the two ways that reading can still be wrong. There is no third: a member in another clause,
 * at a distance, in a prepositional object or standing as a verb cannot reach the anchor any more,
 * because reaching it means crossing a token that stops the walk.
 *   (a) MEMBERSHIP CANNOT KNOW THE PAGE. `Verify the banner is visible` passes whether or not the
 *       page has a banner. Membership decides that a word names a KIND of element; nothing lexical
 *       can decide that this page holds one. Pinned by the deliberately-passing test "leaves the
 *       documented residual open on purpose: a lexicon MEMBER reads as an element name" in
 *       `__tests__/assertion-strength.test.ts`. Closing it needs the resolved a11y evidence gate 3
 *       works from — it is not reachable by any lexicon retune.
 *   (b) NEAREST-PRECEDING IS A SUBJECT PROXY, NOT SYNTAX. The rule reads the nearest content word to
 *       the left of a state term as that state's subject, which it usually is and need not be. A
 *       member standing between a page-whole subject head and the state term reads as the subject,
 *       so `Verify the page with the banner is visible` passes although the claim is about the
 *       page. Pinned by the deliberately-passing test "leaves the SECOND residual open on purpose:
 *       nearest-preceding is a subject PROXY, not syntax". Closing it needs a parse, not a lexicon:
 *       the fix is a dependency analysis of the sentence, which is a different class of tool from
 *       a deterministic hermetic membership check, so it is accepted here rather than approximated
 *       with a heuristic that would ship another axis.
 *
 * ACCEPTED COST, priced in the open, and the retune routes. Every item below is a REAL draft this
 * gate refuses; all are pinned by deliberately-failing cells in the accepted-cost test.
 *   - An UNLISTED genuine element noun: `Verify the widget is visible`, `Verify the carousel is
 *     visible`, and `Verify the Login form is empty` (whose `form` is a page-whole noun and so stops
 *     the walk as well).
 *   - PLURALS, as a whole CLASS. Membership is exact and there is no stemming, so `Verify the Submit
 *     buttons are disabled` is refused while the singular `Verify the Submit button is disabled`
 *     passes. That is the single largest category of loss and it is not a per-word omission.
 *   - Six COMMON NOUNS an author reaches for constantly and this lexicon does not hold: `message`,
 *     `text`, `title`, `item`, `cell`, `card` — `Verify the error message is visible`, `Verify the
 *     text is visible`, `Verify the title is visible`, `Verify the item is selected`, `Verify the
 *     cell is empty` and `Verify the card is visible` all lose gate 4.
 *   - The ATTACHMENT cost, new with the relation: a genuine element claim written with a page-whole
 *     noun nearer the state term is refused, so `Verify the header on the page is visible` fails
 *     because `page`, not `header`, is what the walk meets first. This is D-12's direction — the
 *     sentence is ambiguous about what is being claimed visible — and it is a cost, not a bonus.
 *   - The INTERVENING-TOKEN cost, new with the total refuser: ANY token outside the three sets
 *     standing between a member and its state term refuses a genuine claim, because the walk stops
 *     on it rather than crossing it. `Verify the submit button is currently visible` loses gate 4 to
 *     one ordinary adverb, and `Verify the button badge is visible` loses it to an unknown subject
 *     head standing one clause nearer than the member. Both are pinned RED-first. This is the price
 *     of a closed continue set, and it is charged in the SAFE direction: what an omission from that
 *     set costs is a refused genuine draft, never an accepted vacuous one.
 * The AUTHOR's route out is a singular lexicon noun standing beside its state (`Verify the login
 * field is empty` passes, and is pinned), quoting the literal the page must show, or stating a
 * money amount (see `MONEY_AMOUNT_RE`). The
 * MAINTAINER's routes are an `ELEMENT_NOUNS` membership change or a `FUNCTION_WORDS` membership
 * change (both move the gate toward ACCEPT — one more subject the walk will answer TRUE on, one
 * more token it will cross to get there) or a `PAGE_WHOLE_NOUNS` membership change (which moves the
 * NAMED refusal without moving the verdict, since the stop already refuses whatever that set omits),
 * each with the frozen corpus re-run that says whether the retune was a fix or a leak — never a
 * character-case test, never a fourth exclusion list, never an independent whole-residue scan, and
 * never a refuser that can only refuse what it is able to name: those are the four shapes that
 * shipped the five regressions above.
 */
function namesElementInExpectedState(text: string): boolean {
  const tokens = afterLeadingToken(unquotedResidue(text)).split(/\s+/).map(normalizeToken)

  for (let index = 0; index < tokens.length; index += 1) {
    if (!(EXPECTED_STATE_TERMS as readonly string[]).includes(tokens[index] ?? '')) continue

    for (let left = index - 1; left >= 0; left -= 1) {
      const token = tokens[left] ?? ''
      if ((ELEMENT_NOUNS as readonly string[]).includes(token)) return true
      if ((PAGE_WHOLE_NOUNS as readonly string[]).includes(token)) break
      if (!(FUNCTION_WORDS as readonly string[]).includes(token)) break
    }
  }
  return false
}

/**
 * The capture-signature patterns a quoted expected value hits, by NAME.
 *
 * Per whitespace-delimited token of each literal, so a value that embeds a machine id inside a
 * sentence is still caught, and reported as a sorted deduplicated set so the receipt reads the
 * same way whichever literal matched first.
 */
function captureSignatureHits(literals: readonly string[]): string[] {
  const hits = new Set<string>()

  for (const literal of literals) {
    for (const token of literal.split(/\s+/)) {
      for (const entry of CAPTURE_SIGNATURE_PATTERNS) {
        if (entry.pattern.test(token)) hits.add(entry.name)
      }
    }
  }
  return [...hits].sort()
}

/**
 * The per-step classification table.
 *
 * The ONE judgment in this module. Prior-action captures accumulate as the walk proceeds, which is
 * what makes the tautology rule directional: an assertion cannot restate content that has not been
 * entered yet, and an order-blind comparison would reject a legitimate pre-condition check for
 * restating something that comes later. What accumulates — and what the tautology comparison reads
 * — is the RAW span list; the concreteness arm and the capture-signature scan read the filtered
 * literals instead (see `quotedSpans`). An action's unquoted money amounts join that list beside its
 * spans, and an assertion's money amount is concrete and is compared against it (see
 * `MONEY_AMOUNT_RE`).
 */
export function classifyDraftSteps(steps: readonly string[]): StepClassificationRow[] {
  const priorActionLiterals = new Set<string>()
  const rows: StepClassificationRow[] = []

  for (const stepText of steps) {
    const spans = quotedSpans(stepText)
    const literals = quotedLiterals(stepText)

    if (!isAssertionVerb(leadingToken(stepText))) {
      for (const span of spans) priorActionLiterals.add(span)
      for (const amount of moneyAmounts(stepText)) priorActionLiterals.add(amount)
      rows.push({ stepText, role: 'action', falsifiable: false, captureSignatureHits: [] })
      continue
    }

    const vacuityHit = (VACUOUS_ASSERTION_PHRASES as readonly string[])
      .find((phrase) => phrase === vacuityRemainder(stepText))
    const hits = captureSignatureHits(literals)
    const amounts = moneyAmounts(stepText)
    const tautology = [...spans, ...amounts].some((value) => priorActionLiterals.has(value))
    const concrete =
      literals.length > 0 || amounts.length > 0 || namesElementInExpectedState(stepText)

    rows.push({
      stepText,
      role: 'assertion',
      falsifiable:
        concrete
        && vacuityHit === undefined
        && hits.length === 0
        && !tautology
        && !isMixedActAndVerify(stepText),
      captureSignatureHits: hits,
      ...(vacuityHit === undefined ? {} : { vacuityHit }),
      ...(tautology ? { tautologyHit: true } : {}),
    })
  }
  return rows
}

function gateReason(rows: readonly StepClassificationRow[]): string {
  const assertions = rows.filter((row) => row.role === 'assertion')

  if (assertions.length === 0) {
    return 'no step classifies as an assertion: the draft records what it did, never what should be true (D-09 clause (i))'
  }
  if (assertions.some((row) => row.falsifiable)) {
    return `${assertions.filter((row) => row.falsifiable).length} of ${assertions.length} assertion steps reference concrete expected content`
  }

  const causes = new Set<string>()
  for (const row of assertions) {
    if (row.vacuityHit !== undefined) causes.add(`vacuous phrase "${row.vacuityHit}"`)
    if (row.tautologyHit === true) causes.add('restates a prior action\'s own literal')
    for (const hit of row.captureSignatureHits) causes.add(`capture signature ${hit}`)
    // D-12's mixed act-and-verify signal has no receipt ROW field: `StepClassificationRowSchema`
    // is strict and carries no `mixedHit`, and 393-06 declined to add one — a bare boolean would
    // name nothing the step text does not already show, where `vacuityHit` names the exact phrase
    // and `captureSignatureHits` the exact pattern. The cause therefore has to surface HERE, which
    // is where 393-04's own handoff note said it would. Until this line it did not: a mixed step
    // carrying a quoted literal fell through to the fallback below and the receipt read
    // "no quoted expected value" about a step that has one — a durable false explanation, which is
    // the one thing D-12's tune-toward-reject posture cannot afford.
    if (isMixedActAndVerify(row.stepText)) {
      causes.add('acts and verifies in one step, so it has no single verdict to report')
    }
  }
  // THE FALLBACK MUST BE TRUE OF EVERY STEP THAT REACHES IT (393-15, re-derived 393-17). Two tails
  // have now been retired here for the same reason, and the reason is worth stating once: a tail
  // that describes the rule's INPUTS goes stale the moment the rule changes, while a tail that
  // states the RELATION the rule decides stays true as long as the rule decides it. The first tail
  // said the step named no element — false about `Verify the Submit buttons are disabled` and every
  // other plural or unlisted noun, a durable receipt denying what the author plainly wrote. The
  // second said no element noun stood as the NEAREST set-noun before a state term, which the total
  // refuser falsified at once: in `Verify the submit button is currently visible` an element noun IS
  // the nearest set-noun before `visible`, and the gate refuses anyway, because an ordinary adverb
  // stands between them. What is true of every step reaching this line is the relation as the walk
  // now decides it — and, as before, it may not deny an element or a literal the author wrote.
  if (causes.size === 0) {
    causes.add(
      'no quoted expected value, and no element noun this gate knows stands before an expected-state term with only function words between them',
    )
  }

  return `${assertions.length} assertion step(s), none falsifiable: ${[...causes].sort().join('; ')} (D-09 clause (ii))`
}

/**
 * Gate 4 (D-09's two clauses composed) over a parsed draft's steps.
 *
 * Pass requires at least one row that is BOTH an assertion and falsifiable — the two clauses
 * are conjoined on a single row rather than checked independently, because a draft with a
 * vacuous assertion and a falsifiable-looking action would otherwise satisfy them separately.
 */
export function assertionStrengthGate(draft: ParsedDraftStepsLike): AssertionStrengthGateResult {
  const table = classifyDraftSteps(draft.steps)
  const assertions = table.filter((row) => row.role === 'assertion')
  const falsifiable = assertions.filter((row) => row.falsifiable)

  return {
    pass: falsifiable.length > 0,
    assertionStepCount: assertions.length,
    falsifiableAssertionCount: falsifiable.length,
    reason: gateReason(table),
    table,
  }
}

/**
 * The frozen proving suite's contract — a projection, never a second judgment.
 *
 * `corpus-static-gates.test.ts` was committed RED against this exact signature before any of
 * this module existed, and it names its fields `text`/`kind` where the receipt schema names
 * them `stepText`/`role`. Renaming either side to agree with the other would have meant the
 * implementation editing the artifact that exists to constrain it, so the two spellings both
 * stand and this function carries the mapping. `vacuityHit` and `tautologyHit` are absent from
 * the projection because the frozen shape has no field for them — they survive on the receipt
 * rows, which is where D-11 says the author reads them.
 */
export function evaluateAssertionStrength(steps: readonly string[]): AssertionStrengthResult {
  const table = classifyDraftSteps(steps)

  return {
    falsifiable: table.some((row) => row.role === 'assertion' && row.falsifiable),
    steps: table.map((row) => ({
      text: row.stepText,
      kind: row.role,
      falsifiable: row.falsifiable,
      captureSignatureHits: row.captureSignatureHits,
    })),
  }
}
