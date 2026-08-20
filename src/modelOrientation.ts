import { Euler } from 'three'

export type ModelOrientationView = 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | null

/** Deterministic quarter-turn used by both library preview and room rendering. */
export function modelOrientation(view: ModelOrientationView) {
  if (view === 'top') return new Euler(Math.PI / 2, 0, 0)
  if (view === 'bottom') return new Euler(-Math.PI / 2, 0, 0)
  if (view === 'left') return new Euler(0, Math.PI / 2, 0)
  if (view === 'right') return new Euler(0, -Math.PI / 2, 0)
  if (view === 'back') return new Euler(0, Math.PI, 0)
  return new Euler(0, 0, 0)
}
