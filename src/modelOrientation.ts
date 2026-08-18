import { Euler } from 'three'

export type ModelOrientationView = 'front' | 'top' | 'side' | null

/** Deterministic quarter-turn used by both library preview and room rendering. */
export function modelOrientation(view: ModelOrientationView) {
  if (view === 'top') return new Euler(Math.PI / 2, 0, 0)
  if (view === 'side') return new Euler(0, Math.PI / 2, 0)
  return new Euler(0, 0, 0)
}
