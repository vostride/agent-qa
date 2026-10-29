/**
 * WHO is acting, as opposed to WHERE from. Closed, and spelled once (388 C13).
 *
 * `human` is a person taking an action directly; `agent` is a model-driven call, whether it
 * arrives over chat, MCP, or a background job the daemon started. The axis is deliberately NOT
 * {@link FunctionCaller.surface}: `cli` is a surface a human uses interactively AND the process a
 * scheduled job runs in, so a surface name cannot answer "did a person decide this". It is also
 * distinct from schema's TEST `Surface` (`web | mobile | android | ios | common`), which is about
 * what is under test rather than who is asking.
 *
 * There is no `unknown` member, and the absence is the fail-closed half of the design: a third
 * value would need a rule, every safe rule for it is "treat it as agent", and a vocabulary with a
 * member that always means another member is a vocabulary with two spellings for one thing.
 */
export const FUNCTION_CALLER_ORIGINS = ['human', 'agent'] as const

export type FunctionCallerOrigin = (typeof FUNCTION_CALLER_ORIGINS)[number]

/**
 * The caller record every function invocation carries.
 *
 * NO FIELD HERE IS A PERMISSION INPUT. Every door can call every
 * operation, so `invokeFunction` and the registry read nothing on this record. `surface` and
 * `origin` survive for the receipts and presentation that already consume them, and no new label
 * is written. 2026-10-02: the retired `grantedScopes`, `safeMode`,
 * `credential` and `sessionId` members are deleted, with the scope and trust-credential types they
 * named. An old caller record that still carries one is not migrated and nothing reads it. A branch
 * on `surface` remains an anti-pattern — it re-creates the per-surface private powers the function
 * layer abolished.
 */
export interface FunctionCaller {
  /**
   * Coded originating surface, e.g. 'cli' or 'mcp'. Attribution and diagnostics only;
   * never a permission input.
   */
  surface: string
  /**
   * WHO this call is on behalf of, MINTED by the composition root. The CLI mints
   * `human` because a person typed the command, the daemon and MCP mint `agent` because nobody
   * did.
   *
   * presentation and receipts only. No dispatch check reads it
   * (the human-origin check is deleted), so it grants and withholds nothing. It stays required
   * because the existing receipt and planner consumers read it, and an optional field would need a
   * default nobody decides.
   */
  origin: FunctionCallerOrigin
}

