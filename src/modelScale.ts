export type ModelAxisSize = { x: number; y: number; z: number }

/** Preserve source proportions while fitting a model inside its installation envelope. */
export function uniformModelScale(size: ModelAxisSize, target: ModelAxisSize) {
  return Math.min(
    target.x / Math.max(size.x, 0.001),
    target.y / Math.max(size.y, 0.001),
    target.z / Math.max(size.z, 0.001),
  )
}
