import type { FixtureKind } from './types'

export type PlanTextureLayout = {
  tileWidthMm: number
  tileDepthMm: number
  offsetXmm: number
  offsetZmm: number
}

export type PlanTopCamera = {
  position: [number, number, number]
  up: [number, number, number]
  left: number
  right: number
  top: number
  bottom: number
  near: number
  far: number
  zoom: number
  manual: true
}

/** Keep WebGL top views in SVG viewBox units, regardless of rendered CSS size. */
export function planTopCamera(width: number, height: number): PlanTopCamera {
  return {
    position: [width / 2, 1000, height / 2],
    up: [0, 0, -1],
    left: -width / 2,
    right: width / 2,
    top: height / 2,
    bottom: -height / 2,
    near: 0.01,
    far: 2000,
    zoom: 1,
    manual: true,
  }
}

/** Convert one room coordinate to the shared SVG/WebGL top-view coordinate. */
export function planModelPosition(xMm: number, zMm: number, scale: number, offsetX: number, offsetZ: number): [number, number, number] {
  return [offsetX + xMm * scale, 0, offsetZ + zMm * scale]
}

/** Resolve the physical tile module shown in the top-down plan. */
export function planTextureLayout(
  widthMm: number,
  depthMm: number,
  rotationDeg: 0 | 90 = 0,
  offsetXmm = 0,
  offsetZmm = 0,
): PlanTextureLayout {
  return {
    tileWidthMm: rotationDeg === 90 ? depthMm : widthMm,
    tileDepthMm: rotationDeg === 90 ? widthMm : depthMm,
    offsetXmm,
    offsetZmm,
  }
}

export type FixtureTopAppearance = 'toilet' | 'vanity' | 'shower' | 'utility-point' | 'furniture'

/** Keep plan symbols deterministic even when a fixture has no loadable 3D asset. */
export function fixtureTopAppearance(kind: FixtureKind): FixtureTopAppearance {
  if (kind === 'toilet') return 'toilet'
  if (kind === 'vanity') return 'vanity'
  if (kind === 'shower') return 'shower'
  if (['floor_drain', 'drain', 'water', 'electric'].includes(kind)) return 'utility-point'
  return 'furniture'
}
