// A re-export of the provider-error predicate; overflow stays non-retryable for retry middleware.
export { isContextOverflow as isContextLengthOverflow } from '../capability/overflow-parse.js'
