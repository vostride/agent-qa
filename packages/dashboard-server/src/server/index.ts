export { startServer } from './server.js'
export { createRouter } from './routes.js'
export { readJsonBody } from './body-parser.js'
// 400-16 (gap 7): the ONE guarded request-URL parse, published so a cell can drive the producer
// itself rather than a re-implementation of it, and so a future frame that needs to parse a request
// URL has somewhere to import the only parse there is.
export {
  backstopServerError,
  refuseUnparseableRequest,
  tryParseRequestUrl,
} from './request-url.js'

// The injected-host seam, published because the CLI command that starts this server composes the
// host. 2026-10-01: the run-confirm router, its route table and the confirm registry
// that were published beside it are deleted.
export type { AgentHost, AgentRegistryHandle } from '../chat/host.js'
