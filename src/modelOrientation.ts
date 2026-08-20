import { Euler, Vector3 } from 'three'

export type ModelOrientationView = 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | null

export type OrientationFace = Exclude<ModelOrientationView, null>
export type OrientationMapping = Partial<Record<OrientationFace, OrientationFace>>

const faceNormals: Record<OrientationFace, Vector3> = {
  front: new Vector3(0, 0, 1),
  back: new Vector3(0, 0, -1),
  top: new Vector3(0, 1, 0),
  bottom: new Vector3(0, -1, 0),
  left: new Vector3(-1, 0, 0),
  right: new Vector3(1, 0, 0),
}

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

const opposite: Record<OrientationFace, OrientationFace> = { front: 'back', back: 'front', top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

/** Resolve three or more physical->semantic face pairs to one of the 24 legal cube rotations. */
export function resolveOrientationMapping(mapping: OrientationMapping) {
  const pairs = Object.entries(mapping) as [OrientationFace, OrientationFace][]
  if (pairs.length < 3) return null
  const quarterTurns = [0, Math.PI / 2, Math.PI, -Math.PI / 2]
  for (const x of quarterTurns) for (const y of quarterTurns) for (const z of quarterTurns) {
    const rotation = new Euler(x, y, z, 'XYZ')
    const valid = pairs.every(([physical, semantic]) => faceNormals[physical].clone().applyEuler(rotation).distanceToSquared(faceNormals[semantic]) < 1e-8)
    if (valid) return rotation
  }
  return null
}

export function completeOrientationMapping(mapping: OrientationMapping) {
  const rotation = resolveOrientationMapping(mapping)
  if (!rotation) return null
  return Object.fromEntries((Object.entries(faceNormals) as [OrientationFace, Vector3][]).map(([physical, normal]) => {
    const rotated = normal.clone().applyEuler(rotation)
    const semantic = (Object.entries(faceNormals) as [OrientationFace, Vector3][]).find(([, value]) => rotated.distanceToSquared(value) < 1e-8)![0]
    return [physical, semantic]
  })) as Record<OrientationFace, OrientationFace>
}

export function mappingFromLegacyView(view: ModelOrientationView): Record<OrientationFace, OrientationFace> {
  return orientationFaceLabels(view)
}

export function resolvedModelOrientation(mapping: OrientationMapping | null | undefined, legacyView: ModelOrientationView) {
  return mapping ? resolveOrientationMapping(mapping) ?? modelOrientation(legacyView) : modelOrientation(legacyView)
}

/** Labels shown on the original, stationary model after a physical face is chosen as front. */
export function orientationFaceLabels(selected: ModelOrientationView): Record<OrientationFace, OrientationFace> {
  const rotation = modelOrientation(selected)
  const entries = Object.entries(faceNormals).map(([physicalFace, normal]) => {
    const rotated = normal.clone().applyEuler(rotation)
    const semanticFace = (Object.entries(faceNormals) as [OrientationFace, Vector3][])
      .find(([, direction]) => rotated.distanceToSquared(direction) < 1e-8)?.[0]
    if (!semanticFace) throw new Error(`Unsupported orientation for ${physicalFace}`)
    return [physicalFace, semanticFace]
  })
  return Object.fromEntries(entries) as Record<OrientationFace, OrientationFace>
}
