export interface ModelDimension {
  category: string
  file_name: string
  width_mm: number
  depth_mm: number
  height_mm: number
  status: 'verified' | 'review'
  note?: string
}

// Representative geometry bounds supplied with AGEN-44. X maps to width,
// Z to depth and Y to height. A category is only used when the source model
// was parsed successfully; unparsed SKP files deliberately do not enter this map.
export const modelDimensions: Record<string, ModelDimension> = {
  '地漏': { category: '地漏', file_name: '地漏01.fbx', width_mm: 100, depth_mm: 100, height_mm: 44.3, status: 'verified' },
  '花洒': { category: '花洒', file_name: '双头花洒_03.fbx', width_mm: 284.7, depth_mm: 484.9, height_mm: 1327.1, status: 'verified' },
  '热水器': { category: '热水器', file_name: '热水器01.fbx', width_mm: 780.9, depth_mm: 448.1, height_mm: 524.7, status: 'verified' },
  '洗衣机': { category: '洗衣机', file_name: '洗衣机.glb', width_mm: 608, depth_mm: 653, height_mm: 860, status: 'review', note: 'glTF 导出单位需在建模软件抽查' },
  // Every reviewed cabinet asset is a complete 800x520x2000 mm cabinet and
  // mirror assembly. Keeping that full envelope prevents uniform 3D fitting
  // from shrinking an 800 mm cabinet to roughly 340 mm wide.
  '浴室柜': { category: '浴室柜', file_name: '浴室柜12.fbx', width_mm: 800, depth_mm: 520, height_mm: 2000, status: 'verified' },
  '适老浴室柜': { category: '适老浴室柜', file_name: '浴室柜12.fbx', width_mm: 800, depth_mm: 520, height_mm: 2000, status: 'verified', note: '暂无独立适老柜模型，沿用同品类柜体几何' },
  '淋浴椅': { category: '淋浴椅', file_name: '无障碍淋浴室坐凳001.gltf', width_mm: 600, depth_mm: 500, height_mm: 100, status: 'review', note: 'glTF 导出单位和坐凳高度需复核' },
}

export function dimensionsFor(category: string, fallback: Pick<ModelDimension, 'width_mm' | 'depth_mm' | 'height_mm'>) {
  return modelDimensions[category] ?? { category, file_name: 'proxy', status: 'review' as const, note: '附件无可解析模型，使用布局代理尺寸', ...fallback }
}
