export type PhysicalTextureTransform = {
  repeatX: number
  repeatY: number
  offsetX: number
  offsetY: number
}

/** Keep a surface image at its declared physical size, cropping partial panels instead of stretching them. */
export function physicalTextureTransform(
  widthMm: number,
  heightMm: number,
  materialWidthMm: number,
  materialHeightMm: number,
  originXmm = 0,
  originYmm = 0,
): PhysicalTextureTransform {
  return {
    repeatX: widthMm / materialWidthMm,
    repeatY: heightMm / materialHeightMm,
    offsetX: originXmm / materialWidthMm,
    offsetY: originYmm / materialHeightMm,
  }
}

/** Scale meter-based world UVs to a material's declared millimeter size. */
export function physicalWorldTextureTransform(
  materialWidthMm: number,
  materialHeightMm: number,
  originUmm = 0,
  originVmm = 0,
): PhysicalTextureTransform {
  return {
    repeatX: 1000 / materialWidthMm,
    repeatY: 1000 / materialHeightMm,
    offsetX: -originUmm / materialWidthMm,
    offsetY: -originVmm / materialHeightMm,
  }
}
