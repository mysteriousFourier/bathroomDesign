import { describe, expect, it } from 'vitest'
import { applyLayoutSolution, generateLayoutSolutions, optimizeFloorLayout } from './layoutEngine'
import { manualRoom } from './spec'
import { modelDimensions } from './modelDimensions'
import graphOutput from './generated-layout-products.json'
import type { LayoutLevelDecision } from './types'

describe('deterministic requirement layout engine', () => {
  const room = manualRoom(3200, 2600, 2700)
  room.openings.push({ id: 'D1', kind: 'door', wall_index: 0, offset_mm: 1300, width_mm: 800, height_mm: 2100, sill_mm: 0, label: 'D1', source: 'measured', confidence: 1 })
  const solutions = generateLayoutSolutions(room)

  it('generates three demands at three price tiers for the same measured room', () => {
    expect(solutions).toHaveLength(9)
    expect(new Set(solutions.map((x) => x.demand)).size).toBe(3)
    expect(new Set(solutions.map((x) => x.budget)).size).toBe(3)
    expect(solutions.every((x) => x.total_price > 0 && x.product_lines.length > 0)).toBe(true)
    for (const demand of new Set(solutions.map((x) => x.demand))) {
      const variants = solutions.filter((x) => x.demand === demand)
      expect(new Set(variants.map((x) => `${x.wet_zone.x_mm},${x.wet_zone.z_mm}`)).size).toBe(3)
      expect(new Set(variants.map((x) => x.fixtures.map((f) => `${f.kind}:${f.x_mm},${f.z_mm},${f.rotation_deg}`).join('|'))).size).toBe(3)
    }
  })

  it('uses exact model-selected graph products for coordinates, quote lines, and 3D fixtures', () => {
    const products = graphOutput.scenarios.standard_shower.products
      .filter((product) => ['花洒', '热水器', '马桶', '浴室柜'].includes(product.category))
      .filter((product) => product.category !== '马桶' || product.code === 'MT1')
      .filter((product, index, all) => all.findIndex((item) => item.category === product.category) === index)
      .map((product) => ({ product_id:product.graph_id, catalog_code:product.code, category:product.category, spec:product.spec, unit_price:product.price, price_unit:'件', ...(product.code === 'MT1' ? { model_lookup:{ product_id:product.graph_id, catalog_code:product.code, category:product.category, catalog_style:'通用', normalized_requested_style:'素雅', spec:product.spec, model_asset_id:'snapshot-mt1', model_asset_src:'/model-library/test-mt1.glb', model_asset_format:'glb' as const, model_asset_label:'MT1 backend snapshot', model_dimensions_mm:{ width:431, depth:711, height:777 }, layout_fixture_kind:'马桶', binding_status:'bound' as const } } : {}) }))
    const instruction = (fixture_role:string, wall:'north'|'south'|'east'|'west', zone:'dry'|'wet'|'service', near='') => ({ fixture_role, wall, zone, near, min_clearance_mm:fixture_role === 'wet_zone' || fixture_role === 'heater' ? 0 : 600 })
    const levels = (['basic','comfort','premium'] as const).map((tier, index) => ({ id:`level${index+1}` as const, name:`真实产品方案 ${index+1}`, reason:'真实产品驱动', demand_profile:'standard_shower' as const, product_tier:tier, product_ids:products.map((product) => product.product_id), products, layout_script:{ version:'layout-script-v1' as const, demand:'standard_shower' as const, budget:tier, instructions:[instruction('wet_zone',index===0?'east':index===1?'west':'south','wet','shower_drain'),instruction('vanity','west','dry'),instruction('toilet','north','dry','toilet_drain'),instruction('heater','east','service','wet_zone')], source:'deterministic-rule-engine' as const } })) as LayoutLevelDecision[]
    const [solution] = generateLayoutSolutions(room, { style:'素雅', levels })
    expect(solution.selected_product_ids).toEqual(products.map((product) => product.product_id))
    expect(solution.product_lines.map((line) => line.code)).toEqual(products.map((product) => product.catalog_code))
    expect(products.every((product) => solution.fixtures.some((fixture) => fixture.label.startsWith(`${product.catalog_code} `)))).toBe(true)
    expect(solution.checks.find((check) => check.code === 'KG-SELECTION')?.passed).toBe(true)
    expect(solution.anchors.every((anchor) => Number.isInteger(anchor.x_mm) && anchor.instruction.includes('最小净距'))).toBe(true)
    const snapshotToilet = solution.fixtures.find((fixture) => fixture.label.startsWith('MT1 '))
    expect(snapshotToilet && [snapshotToilet.width_mm, snapshotToilet.depth_mm, snapshotToilet.height_mm]).toEqual([431, 711, 777])
    expect(snapshotToilet?.model_asset?.src).toBe('/model-library/test-mt1.glb')
    const applied = applyLayoutSolution(room, solution)
    expect(products.every((product) => applied.fixtures.some((fixture) => fixture.id.includes(product.product_id)))).toBe(true)
  })

  it('uses directional front clearance and blocks an unsatisfiable layout', () => {
    const products = graphOutput.scenarios.standard_shower.products
      .filter((product) => ['花洒', '热水器', '马桶', '浴室柜'].includes(product.category))
      .filter((product, index, all) => all.findIndex((item) => item.category === product.category) === index)
      .map((product) => ({ product_id:product.graph_id, catalog_code:product.code, category:product.category, spec:product.spec, unit_price:product.price, price_unit:'件' }))
    const makeLevels = (clearance:number) => (['basic','comfort','premium'] as const).map((tier, index) => ({
      id:`level${index+1}` as const, name:`净空测试 ${index+1}`, reason:'净空测试', demand_profile:'standard_shower' as const,
      product_tier:tier, product_ids:products.map((product) => product.product_id), products,
      layout_script:{ version:'layout-script-v1' as const, demand:'standard_shower' as const, budget:tier, source:'deterministic-rule-engine' as const, instructions:[
        { fixture_role:'wet_zone', wall:'east' as const, zone:'wet' as const, near:'shower_drain', min_clearance_mm:0 },
        { fixture_role:'vanity', wall:'west' as const, zone:'dry' as const, min_clearance_mm:clearance },
        { fixture_role:'toilet', wall:'north' as const, zone:'dry' as const, near:'toilet_drain', min_clearance_mm:clearance },
        { fixture_role:'heater', wall:'east' as const, zone:'service' as const, near:'wet_zone', min_clearance_mm:0 },
      ] },
    })) as LayoutLevelDecision[]
    const feasible = generateLayoutSolutions(room, { levels:makeLevels(200) })[0]
    const constrained = generateLayoutSolutions(room, { levels:makeLevels(5000) })[0]
    expect(constrained.solver_trace.feasible_candidates).toBeLessThan(feasible.solver_trace.feasible_candidates)
    expect(constrained.checks.find((check) => check.code === 'G02-CLEARANCE')).toMatchObject({ passed:false, severity:'error' })
    expect(() => applyLayoutSolution(room, constrained)).toThrow(/G02-CLEARANCE/)
  })

  it('quotes equipment and fixed-board surface materials for every tier', () => {
    for (const solution of solutions) {
      expect(solution.material_lines.map((line) => line.category).sort()).toEqual(['吊顶', '地砖', '墙板'])
      expect(solution.material_lines.every((line) => line.quantity > 0 && line.subtotal > 0)).toBe(true)
      expect(solution.surface_materials.wall?.dimensions_mm).toEqual({ width: 600, depth: 10, height: 3000 })
      expect(solution.surface_materials.floor?.dimensions_mm).toEqual({ width: 3000, depth: 1200, height: 10 })
      expect(solution.material_lines.find((line) => line.category === '墙板')?.model_asset_id).toBe(solution.surface_materials.wall?.id)
      expect(solution.material_lines.find((line) => line.category === '地砖')?.model_asset_id).toBe(solution.surface_materials.floor?.id)
      expect(solution.total_price).toBeCloseTo(solution.equipment_price + solution.material_price, 2)
    }
  })

  it('always aligns the tile long edge with the room short edge', () => {
    expect(optimizeFloorLayout(manualRoom(4105, 2160, 2700), 3000, 1200).rotation_deg).toBe(90)
    expect(optimizeFloorLayout(manualRoom(2100, 3600, 2700), 3000, 1200).rotation_deg).toBe(0)
    expect(optimizeFloorLayout(manualRoom(4105, 2160, 2700), 1200, 3000).rotation_deg).toBe(0)
    expect(solutions.every((solution) => solution.floor_layout.rotation_deg === 90)).toBe(true)
    expect(solutions.every((solution) => solution.floor_layout.description.includes('长边沿房型短边'))).toBe(true)
  })

  it('emits exact semantic anchor coordinates and geometry checks', () => {
    expect(solutions.every((x) => x.anchors.length === x.fixtures.length)).toBe(true)
    expect(solutions.every((x) => x.anchors.every((a) => Number.isInteger(a.x_mm) && Number.isInteger(a.z_mm)))).toBe(true)
    expect(solutions.every((x) => x.checks.some((c) => c.code === 'G01-COLLISION'))).toBe(true)
    expect(solutions.every((x) => x.checks.every((c) => c.severity && c.source))).toBe(true)
    expect(solutions.every((x) => x.checks.some((c) => c.code === 'INPUT-DRAIN' && !c.passed))).toBe(true)
    expect(solutions.every((x) => x.score >= 0 && x.score <= 100)).toBe(true)
    expect(solutions.every((x) => x.layout_script.source === 'requirement-rule-engine')).toBe(true)
    expect(solutions.every((x) => x.layout_script.instructions.some((i) => i.fixture_role === 'wet_zone'))).toBe(true)
    expect(solutions.every((x) => x.solver_trace.candidates_evaluated > 0 && x.solver_trace.feasible_candidates > 0)).toBe(true)
    expect(solutions.every((x) => x.checks.some((c) => c.code === 'G05' && c.source === '栅格可达性'))).toBe(true)
  })

  it('blocks applying a candidate with a hard rule violation', () => {
    const invalid = structuredClone(solutions[0])
    invalid.checks.push({ code: 'G01', passed: false, severity: 'error', source: '几何', message: '测试越界' })
    expect(() => applyLayoutSolution(room, invalid)).toThrow(/G01/)
  })

  it('applies a candidate without changing the measured boundary or openings', () => {
    const applied = applyLayoutSolution(room, solutions[0])
    expect(applied.boundary).toEqual(room.boundary)
    expect(applied.openings).toEqual(room.openings)
    expect(applied.fixtures).toEqual(solutions[0].fixtures)
    expect(applied.dry_wet_zones?.[0].boundary).toHaveLength(4)
  })

  it('keeps wet area out of furniture and never adds an enclosure to accessible layouts', () => {
    const elderly = solutions.filter((solution) => solution.demand === 'elderly_safe')
    expect(elderly).toHaveLength(3)
    expect(elderly.every((solution) => solution.fixtures.every((fixture) => fixture.kind !== 'shower' && !fixture.label.includes('淋浴区') && !fixture.label.includes('淋浴隔断')))).toBe(true)
    expect(elderly.every((solution) => solution.fixtures.some((fixture) => fixture.label.startsWith('LYY-1')))).toBe(true)
    expect(elderly.every((solution) => applyLayoutSolution(room, solution).dry_wet_zones?.[0].label.includes('非家具'))).toBe(true)
  })

  it('uses supplied model bounds for categories that have parsed geometry', () => {
    const laundry = solutions.find((solution) => solution.demand === 'laundry')!
    const washer = laundry.fixtures.find((fixture) => fixture.label.includes('洗衣机'))!
    expect([washer.width_mm, washer.depth_mm, washer.height_mm]).toEqual([608, 653, 860])
    expect(washer.label).toContain(modelDimensions['洗衣机'].file_name)

    const vanity = laundry.fixtures.find((fixture) => fixture.kind === 'vanity')!
    expect([vanity.width_mm, vanity.depth_mm, vanity.height_mm]).toEqual([800, 500, 560])
    expect(laundry.fixtures.find((fixture) => fixture.label.includes('热水器'))?.elevation_mm).toBeGreaterThan(1200)
    expect(laundry.fixtures.find((fixture) => fixture.label.includes('花洒'))?.elevation_mm).toBe(700)
    expect(laundry.checks.find((item) => item.code === 'MODEL-DIMENSIONS')?.message).toContain('马桶')
  })
})
