// The config write and undo routes; the API router's head refuses a cross-site request before
// either runs.
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  CONFIG_REVISION_ABSENT,
  ConfigUndoRequestSchema,
  ConfigWriteRequestSchema,
  isPageWritableConfigPath,
} from '@vostride/agent-qa-schema'

import type { ConfigManager } from '../config/index.js'
import type { UndoStore } from '../config/undo-store.js'
import { respondJson } from '../run-service/run-detail-routes.js'
import { readJsonBody } from './body-parser.js'

/**
 * PATCH /api/config. The body is a change set; the answer is the revision now on disk, and for an
 * undoable change set a single-use Undo token (429-11 D-24).
 */
export function registerConfigWriteRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { readonly configManager: ConfigManager; readonly undoStore: UndoStore },
): void {
  void readJsonBody<unknown>(req).then(async (body) => {
    const parsed = ConfigWriteRequestSchema.safeParse(body)
    if (!parsed.success) {
      respondJson(res, 400, { error: 'invalid_write_input' })
      return
    }
    // 429-44 WR-01: this door changes only what the page renders a field for.
    const refused = parsed.data.changes.some((change) =>
      !isPageWritableConfigPath(change.path)
      || (change.op === 'move' && !isPageWritableConfigPath(change.from)))
    if (refused) {
      respondJson(res, 422, { error: 'path_not_writable' })
      return
    }
    const undoable = parsed.data.undoable === true
    let outcome: Awaited<ReturnType<ConfigManager['applyChanges']>>
    try {
      outcome = await deps.configManager.applyChanges(parsed.data.changes, { capturePriors: undoable })
    } catch {
      respondJson(res, 500, { error: 'write_failed' })
      return
    }
    if (outcome.kind === 'ok') {
      if (undoable && outcome.priors !== undefined) {
        const undo = deps.undoStore.put({ kind: 'config', priors: outcome.priors }, Date.now())
        respondJson(res, 200, { revision: outcome.revision, baseRevision: outcome.baseRevision, undo })
        return
      }
      respondJson(res, 200, { revision: outcome.revision, baseRevision: outcome.baseRevision })
      return
    }
    if (outcome.error === 'invalid_write_input') {
      respondJson(res, 400, { error: outcome.error })
      return
    }
    // 429-42: an expect found the field moved; the page recomputes from a fresh read.
    if (outcome.error === 'field_changed') {
      respondJson(res, 409, { error: outcome.error, path: outcome.path })
      return
    }
    respondJson(res, 422, outcome.issues === undefined
      ? { error: outcome.error }
      : { error: outcome.error, issues: outcome.issues })
  }, () => { respondJson(res, 400, { error: 'invalid_write_input' }) })
    .catch(() => { respondJson(res, 500, { error: 'write_failed' }) })
}

/** GET /api/config/revision. The sha256 of the file's bytes, even when they do not parse. */
export function registerConfigRevisionRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: { readonly configManager: ConfigManager },
): void {
  deps.configManager.readWithRevision().then((read) => {
    res.setHeader('Cache-Control', 'no-store')
    const revision = read.kind === 'absent' ? CONFIG_REVISION_ABSENT : read.revision
    respondJson(res, 200, { revision })
  }, () => { respondJson(res, 500, { error: 'read_failed' }) })
}

/**
 * POST /api/config/undo (429-11 D-24). Redeems a token once and restores on the server, so the
 * page never writes back a copy it holds only masked. Same-site only; a newer write always wins.
 */
export function registerConfigUndoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    readonly configManager?: ConfigManager
    readonly undoStore: UndoStore
    /** Writes the credential back under the credential lock; false when the name is taken again. */
    readonly restoreCredential: (name: string, credential: unknown) => Promise<boolean>
  },
): void {
  if (req.method !== 'POST') {
    respondJson(res, 405, { error: 'method_not_allowed' })
    return
  }
  void readJsonBody<unknown>(req).then(async (body) => {
    const parsed = ConfigUndoRequestSchema.safeParse(body)
    if (!parsed.success) {
      respondJson(res, 400, { error: 'invalid_write_input' })
      return
    }
    const payload = deps.undoStore.take(parsed.data.token, Date.now())
    if (payload === undefined) {
      respondJson(res, 410, { error: 'undo_expired' })
      return
    }
    if (payload.kind === 'credential') {
      const restored = await deps.restoreCredential(payload.name, payload.credential)
      if (restored) respondJson(res, 200, { restored: true })
      else respondJson(res, 409, { error: 'undo_conflict' })
      return
    }
    if (deps.configManager === undefined) {
      respondJson(res, 503, { error: 'config_unavailable' })
      return
    }
    const outcome = await deps.configManager.restorePriors(payload.priors)
    if (outcome.kind === 'ok') {
      respondJson(res, 200, { restored: true, revision: outcome.revision })
      return
    }
    respondJson(res, outcome.error === 'undo_conflict' ? 409 : 422, { error: outcome.error })
  }, () => { respondJson(res, 400, { error: 'invalid_write_input' }) })
    .catch(() => { respondJson(res, 500, { error: 'write_failed' }) })
}
