// A types-only seam, so rebuild logic carries no model runtime code.
export interface EmbedderPort {
  // The profile's document prefix is applied inside; callers pass the bare rendering.
  embedDocument(rendering: string): Promise<Float32Array>

  // The profile's query prefix is applied inside; callers pass the bare rendering.
  embedQuery(rendering: string): Promise<Float32Array>
}
