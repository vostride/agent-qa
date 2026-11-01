import { parsePartialJson, type LanguageModelMiddleware } from 'ai'

export function repairMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',

    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate()
      const content = await Promise.all(
        result.content.map(async (part) => {
          if (part.type !== 'tool-call' || typeof part.input !== 'string') return part

          try {
            JSON.parse(part.input)
            return part
          } catch {
            const repaired = await parsePartialJson(part.input)
            if (
              (repaired.state === 'repaired-parse' || repaired.state === 'successful-parse') &&
              repaired.value !== undefined
            ) {
              return { ...part, input: JSON.stringify(repaired.value) }
            }

            return part
          }
        }),
      )

      return { ...result, content }
    },

    wrapStream({ doStream }) {
      // Tool-call JSON repair is load-bearing only for generated responses today.
      return doStream()
    },
  }
}
