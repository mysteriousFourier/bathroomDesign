import { Euler } from 'three'

export type ModelOrientationView = 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | null

/** Place the selectable cube around models regardless of their source unit scale. */
export function orientationCubePlacement(modelSize: [number, number, number]) {
  return { side: Math.max(...modelSize) * 1.12, centerY: modelSize[1] / 2 }
}

/** Deterministic quarter-turn used by both library preview and room rendering. */
export function modelOrientation(view: ModelOrientationView) {
  if (view === 'top') return new Euler(Math.PI / 2, 0, 0)
  if (view === 'bottom') return new Euler(-Math.PI / 2, 0, 0)
  if (view === 'left') return new Euler(0, Math.PI / 2, 0)
  if (view === 'right') return new Euler(0, -Math.PI / 2, 0)
  if (view === 'back') return new Euler(0, Math.PI, 0)
  return new Euler(0, 0, 0)
}
