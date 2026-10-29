// The knowledge change ops' function ids.
//
// In their own module for the same structural reason `entities-ids.ts` exists: the card action
// table advertises `knowledge.forget` (D-11, the MEM row), and an op file that declared its own id
// beside its spec would close that into an import cycle the moment a card action pointed at it.
// Declaring them here means each id is one value with one definition and every importer reaches it
// in one direction.
//
// the three verbs apply in the call. The `.propose` ids are gone
// with no alias. 2026-10-01, 432-17: `knowledge.proposal.apply` is deleted with the
// inbox, and its id with it.

export const KNOWLEDGE_ACCEPT_FUNCTION_ID = 'knowledge.accept'

export const KNOWLEDGE_REJECT_FUNCTION_ID = 'knowledge.reject'

export const KNOWLEDGE_FORGET_FUNCTION_ID = 'knowledge.forget'
