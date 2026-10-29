// Procedure-by-reference: the anchor vocabulary a compiled step is authored in (394, D-17).
//
// D-17 makes a procedure reference SEMANTIC rather than syntactic. The compiled draft carries an
// ordinary natural-language step; at run time the shipped `getProcedure` seam matches that step
// against the live procedure record and replays it. A later procedure fix therefore propagates,
// because replay always reads the CURRENT record — and the committed test stays pure house-style
// prose a person can read without knowing this mechanism exists. There is no `procedure:` literal
// syntax, no parser change and no doc-model change: the whole reference is which WORDS the step
// is written in.
//
// THE INPUT IS AN ANCHOR AND NOTHING ELSE, AND THAT IS THE MITIGATION. A served
// procedure arrives as a `ProcedureMatch`, which carries `id` — a learned-shelf record id whose
// supersession, withholding and garbage collection this project performs on its own schedule. An
// authored test lives on the SOVEREIGN shelf and outlives every one of those events, so an id
// embedded in it would rot: the record it names can be superseded or collected, and the committed
// file would then point at something that is not there. Taking only the anchor makes that
// structurally impossible rather than checked — there is no id in this function's argument to
// leak, so no call site can leak one by accident.
//
// WHY THE ANCHOR IS ALSO THE RIGHT VOCABULARY, measured rather than assumed. `matchProcedure`
// admits a candidate on anchor overlap and then folds the STEP TEXT in as a lexical term, so a
// step written in the record's own words reaches a higher composed confidence than one written in
// unrelated words — high enough, on a partially-matched anchor set, to cross the replay floor
// instead of degrading to a hint. The knowledge-local suite drives both directions through the
// real matcher.

import type { Anchor } from '../identity/anchor'

/**
 * The words a compiled step should be authored in, for one anchor.
 *
 * An EXHAUSTIVE switch rather than a lookup with a fallback, on `renderResolution`'s precedent: a
 * seventh anchor arm is a compile error here instead of a silently unrendered case that would
 * degrade to an empty vocabulary — which reads, at the prompt, exactly like a procedure with
 * nothing to say about itself.
 *
 * Every arm renders the anchor's OWN words and adds none. A phrase invented here would be a
 * second vocabulary for one record, free to drift out of step with what the matcher scores.
 */
export function procedureStepVocabulary(anchor: Anchor): string {
  switch (anchor.t) {
    case 'flow':
      return anchor.name
    case 'page':
      return anchor.route
    case 'el':
      return `${anchor.role} ${anchor.name}`
    case 'platform':
      return anchor.platform
    case 'selector':
      return anchor.literal
    case 'error':
      return anchor.message
  }
}
