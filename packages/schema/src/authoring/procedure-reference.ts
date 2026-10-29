// Takes only the anchor, so no learned-shelf record id can reach a committed test.

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
