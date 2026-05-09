export function warnIfOutOfBounds(
  coords: { x?: number; y?: number },
  viewport: { width: number; height: number },
  actionType: string,
): void {
  const { x, y } = coords
  const { width, height } = viewport
  if (x !== undefined && (x < 0 || x > width)) {
    console.warn(`[${actionType}] x=${x} outside viewport bounds [0, ${width}]`)
  }
  if (y !== undefined && (y < 0 || y > height)) {
    console.warn(`[${actionType}] y=${y} outside viewport bounds [0, ${height}]`)
  }
}
