// The reactive overflow backstop predicate under its spec name.
// A thin re-export of the shipped v46 provider-error predicate — both OpenAI and
// Anthropic overflow families are already covered there, so we do NOT duplicate any
// regex. Consumers use this to re-degrade against the overflow-shrunk
// window on a live 400 and re-call once. Retry middleware keeps treating overflow as
// non-transient (it is not retryable), so this predicate never changes retry behavior.
export { isContextOverflow as isContextLengthOverflow } from '../capability/overflow-parse.js'
