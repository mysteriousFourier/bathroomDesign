import { describe, expect, it } from 'vitest'
import { applyLayoutSolution, blocksDoorEnvelope, blocksUseClearance, blocksWindowEnvelope, frontClearanceEnvelope, generateDeterministicLayoutSolutions, generateLayoutSolutions, optimizeFloorLayout } from './layoutEngine'
import { finishedRoomBoundary, fixtureLocalFootprint, manualRoom, projectPointToWall } from './spec'
import { modelDimensions } from './modelDimensions'
import graphOutput from './generated-layout-products.json'
import type { LayoutLevelDecision } from './types'
import { selectAutomaticLayoutSolution } from './components/SolutionList'

describe('deterministic requirement layout engine', () => {
  const room = manualRoom(3200, 2600, 2700)
  room.openings.push({ id: 'D1', kind: 'door', wall_index: 0, offset_mm: 1300, width_mm: 800, height_mm: 2100, sill_mm: 0, label: 'D1', source: 'measured', confidence: 1 })
  const solutions = generateLayoutSolutions(room)

  it('checks every door, respects reverse wall direction, and differentiates outward/sliding doors', () => {
    const multi = manualRoom(3000, 2400, 2600)
    multi.openings.push(
      { id:'reverse', kind:'door', wall_index:2, offset_mm:400, width_mm:800, height_mm:2100, sill_mm:0, label:'反向墙内开门', source:'measured', confidence:1, opening_form:'hinged', swing_direction:'inward' },
      { id:'sliding', kind:'door', wall_index:1, offset_mm:500, width_mm:800, height_mm:2100, sill_mm:0, label:'推拉门', source:'measured', confidence:1, opening_form:'sliding', swing_direction:'unknown' },
    )
    const floorFixture=(x_mm:number,z_mm:number)=>({ id:'test', kind:'vanity' as const, label:'柜体', x_mm,z_mm,width_mm:300,depth_mm:300,height_mm:800,elevation_mm:0,rotation_deg:30,source:'derived' as const,confidence:1 })
    expect(blocksDoorEnvelope(multi,floorFixture(2200,1700))).toBe(true)
    expect(blocksDoorEnvelope(multi,floorFixture(2550,1200))).toBe(true)
    expect(blocksDoorEnvelope(multi,floorFixture(2200,1200))).toBe(false)
    expect(blocksDoorEnvelope(multi,{...floorFixture(2200,1700),elevation_mm:1500})).toBe(false)
  })

  it('blocks furniture that intersects a window opening while allowing furniture below its sill', () => {
    const roomWithWindow = manualRoom(3000, 2400, 2600)
    roomWithWindow.openings.push({ id:'W1', kind:'window', wall_index:1, offset_mm:500, width_mm:1000, height_mm:1200, sill_mm:900, label:'W1', source:'measured', confidence:1 })
    const inWindow = { id:'window-furniture', kind:'vanity' as const, label:'浴室柜', x_mm:2900, z_mm:1000, width_mm:300, depth_mm:300, height_mm:850, elevation_mm:0, rotation_deg:0, source:'derived' as const, confidence:1 }
    const belowSill = { ...inWindow, id:'below-sill', elevation_mm:100, height_mm:800 }
    expect(blocksWindowEnvelope(roomWithWindow, inWindow)).toBe(true)
    expect(blocksWindowEnvelope(roomWithWindow, belowSill)).toBe(false)
  })

  it('generates one measured-room constraint solution instead of fixed 3 by 3 templates', () => {
    expect(solutions).toHaveLength(1)
    expect(solutions[0]).toMatchObject({ id:'automatic-layout', title:'当前约束求解结果', layout_label:'量房约束自动布局' })
    expect(solutions[0].total_price).toBeGreaterThan(0)
    expect(solutions[0].product_lines.length).toBeGreaterThan(0)
  })

  it('provides three distinct deterministic alternatives for auto-layout fallback', () => {
    const fallback = generateDeterministicLayoutSolutions(room, { style:'素雅' })
    expect(fallback).toHaveLength(3)
    expect(new Set(fallback.map((solution) => solution.id))).toEqual(new Set(['level1', 'level2', 'level3']))
    expect(fallback.every((solution) => solution.checks.every((check) => check.passed || check.severity !== 'error'))).toBe(true)
    expect(new Set(fallback.map((solution) => {
      const vanity = solution.fixtures.find((fixture) => fixture.kind === 'vanity')!
      return `${vanity.x_mm}:${vanity.z_mm}:${vanity.rotation_deg}`
    })).size).toBe(3)
    const toilets = fallback.map((solution) => solution.fixtures.find((fixture) => fixture.kind === 'toilet')!)
    expect(toilets.every((toilet) => toilet.label.startsWith('MT3 马桶'))).toBe(true)
    expect(toilets.every((toilet) => toilet.model_asset?.src.includes('/api/model-assets/ce23ef42c17da53def16083f77c3c0dd/'))).toBe(true)
    expect(toilets.every((toilet) => [toilet.width_mm, toilet.depth_mm, toilet.height_mm].join(':') === '380:680:760')).toBe(true)
  })

  it('keeps local fallback layouts inside the finished boundary across room proportions', () => {
    for (const [width, depth] of [[2800, 2400], [3600, 2200], [2400, 3200]] as const) {
      const candidate = generateLayoutSolutions(manualRoom(width, depth, 2600))[0]
      expect(candidate.checks.filter((check) => !check.passed && check.severity === 'error').map((check) => check.code)).toEqual([])
      expect(candidate.wet_zone.width_mm).toBeGreaterThanOrEqual(800)
      expect(candidate.wet_zone.depth_mm).toBeGreaterThanOrEqual(800)
    }
  })

  it('prefers a wet-zone corner with two finished-wall contacts when plumbing is not fixed', () => {
    const openRoom = manualRoom(3200, 2600, 2600)
    const solution = generateLayoutSolutions(openRoom)[0]
    const finished = finishedRoomBoundary({ ...openRoom, wall_finish_gap_mm:35 })
    const minX = Math.min(...finished.map((point) => point.x_mm)), maxX = Math.max(...finished.map((point) => point.x_mm))
    const minZ = Math.min(...finished.map((point) => point.z_mm)), maxZ = Math.max(...finished.map((point) => point.z_mm))
    const wet = solution.wet_zone
    const contacts = [
      Math.abs(wet.x_mm - wet.width_mm / 2 - minX), Math.abs(wet.x_mm + wet.width_mm / 2 - maxX),
      Math.abs(wet.z_mm - wet.depth_mm / 2 - minZ), Math.abs(wet.z_mm + wet.depth_mm / 2 - maxZ),
    ].filter((distance) => distance <= 25).length
    expect(contacts).toBeGreaterThanOrEqual(2)
  })

  it('treats measured non-toilet fixtures and utility points as movable evidence', () => {
    const measured = manualRoom(3200, 2600, 2600)
    measured.fixtures.push(
      { id:'measured-vanity', kind:'vanity', label:'实测浴室柜', x_mm:300, z_mm:300, width_mm:800, depth_mm:500, height_mm:850, rotation_deg:0, source:'measured', confidence:1 },
      { id:'measured-shower', kind:'shower', label:'实测淋浴区', x_mm:2900, z_mm:2200, width_mm:900, depth_mm:900, height_mm:2000, rotation_deg:0, source:'measured', confidence:1 },
      { id:'basin-water', kind:'water', label:'台盆给水', point_usage:'basin', x_mm:150, z_mm:1200, width_mm:40, depth_mm:40, height_mm:10, rotation_deg:0, source:'measured', confidence:1 },
    )
    const solution = generateLayoutSolutions(measured)[0]
    expect(solution.checks.filter((check) => !check.passed && check.severity === 'error').map((check) => check.code)).toEqual([])
    const applied = applyLayoutSolution(measured, solution)
    expect(applied.fixtures.some((fixture) => fixture.id === 'measured-vanity')).toBe(false)
    expect(applied.fixtures.some((fixture) => fixture.id === 'basin-water')).toBe(true)
  })

  it('uses exact model-selected graph products for coordinates, quote lines, and 3D fixtures', () => {
    const products = graphOutput.scenarios.standard_shower.products
      .filter((product) => ['花洒', '热水器', '马桶', '浴室柜'].includes(product.category))
      .filter((product) => product.category !== '马桶' || product.code === 'MT1')
      .filter((product, index, all) => all.findIndex((item) => item.category === product.category) === index)
      .map((product) => ({ product_id:product.graph_id, catalog_code:product.code, category:product.category, spec:product.spec, unit_price:product.price, price_unit:'件', ...(product.code === 'MT1' ? { model_lookup:{ product_id:product.graph_id, catalog_code:product.code, category:product.category, catalog_style:'通用', normalized_requested_style:'素雅', spec:product.spec, model_asset_id:'snapshot-mt1', model_asset_src:'/model-library/test-mt1.glb', model_asset_format:'glb' as const, model_asset_label:'MT1 backend snapshot', model_dimensions_mm:{ width:431, depth:711, height:777 }, layout_fixture_kind:'马桶', binding_status:'bound' as const } } : {}) }))
    const instruction = (fixture_role:string, wall:'north'|'south'|'east'|'west', zone:'dry'|'wet'|'service', near='') => ({ fixture_role, wall, zone, near, min_clearance_mm:fixture_role === 'wet_zone' || fixture_role === 'heater' ? 0 : 600 })
    const levels = (['basic','comfort','premium'] as const).map((tier, index) => ({ id:`level${index+1}` as const, name:`真实产品方案 ${index+1}`, reason:'真实产品驱动', demand_profile:'standard_shower' as const, product_tier:tier, product_ids:products.map((product) => product.product_id), products, layout_script:{ version:'layout-script-v1' as const, demand:'standard_shower' as const, budget:tier, instructions:[instruction('wet_zone','east','wet','shower_drain'),instruction('vanity','west','dry'),instruction('toilet','north','dry','toilet_drain'),instruction('heater','east','service','wet_zone')], source:'deterministic-rule-engine' as const } })) as LayoutLevelDecision[]
    const generated = generateLayoutSolutions(room, { style:'素雅', levels })
    const [solution] = generated
    expect(new Set(generated.map((candidate) => { const vanity=candidate.fixtures.find((fixture)=>fixture.kind==='vanity')!;return `${vanity.x_mm},${vanity.z_mm},${vanity.rotation_deg}` })).size).toBe(3)
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

  it('uses the solved fixture rotation for front clearance when the model wall conflicts', () => {
    const toilet = { id:'toilet', kind:'toilet', label:'马桶', x_mm:3596, z_mm:1455, width_mm:380, depth_mm:700, height_mm:760, rotation_deg:180, source:'derived', confidence:1 } as const
    const clearance = frontClearanceEnvelope(toilet, { fixture_role:'toilet', wall:'east', zone:'service', near:'马桶排水', min_clearance_mm:400 })!
    expect(clearance.x_mm).toBe(toilet.x_mm)
    expect(clearance.z_mm).toBeLessThan(toilet.z_mm)
    expect(clearance.width_mm).toBe(toilet.width_mm)
    expect(clearance.depth_mm).toBe(400)
  })

  it('allows use clearance over an open wet floor zone but not over a solid fixture', () => {
    const toilet = { id:'toilet', kind:'toilet', label:'马桶', x_mm:3596, z_mm:1455, width_mm:380, depth_mm:680, height_mm:760, rotation_deg:180, source:'derived', confidence:1 } as const
    const clearance = frontClearanceEnvelope(toilet, { fixture_role:'toilet', wall:'east', zone:'dry', min_clearance_mm:800 })!
    const wetZone = { id:'wet', kind:'shower', label:'方案淋浴湿区', x_mm:3600, z_mm:702, width_mm:900, depth_mm:900, height_mm:2000, rotation_deg:0, source:'derived', confidence:1 } as const
    const vanity = { ...wetZone, id:'vanity', kind:'vanity', label:'浴室柜' } as const
    expect(blocksUseClearance(toilet, clearance, wetZone)).toBe(false)
    expect(blocksUseClearance(toilet, clearance, vanity)).toBe(true)
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
    expect(solutions[0].floor_layout.rotation_deg).toBe(90)
    expect(solutions[0].floor_layout.description).toContain('长边沿房型短边')
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

  it('selects the highest-scoring valid solution for one-click automatic layout', () => {
    const candidates = [structuredClone(solutions[0]), structuredClone(solutions[0]), structuredClone(solutions[0])]
    candidates[0].id = 'candidate-1'
    candidates[1].id = 'candidate-2'
    candidates[2].id = 'candidate-3'
    candidates[0].score = 70
    candidates[1].score = 95
    candidates[2].score = 99
    candidates[2].checks.push({ code: 'TEST-BLOCK', passed: false, severity: 'error', source: 'test', message: 'blocked' })
    expect(selectAutomaticLayoutSolution(candidates)?.id).toBe(candidates[1].id)
  })

  it('applies a candidate without changing the measured boundary or openings', () => {
    room.fixtures.push({ id:'measured-drain', kind:'drain', label:'马桶排水', point_usage:'toilet', x_mm:500, z_mm:300, width_mm:110, depth_mm:110, height_mm:10, rotation_deg:0, source:'measured', confidence:1 })
    const applied = applyLayoutSolution(room, solutions[0])
    expect(applied.boundary).toEqual(room.boundary)
    expect(applied.openings).toEqual(room.openings)
    expect(applied.fixtures.find((fixture) => fixture.id === 'measured-drain')).toEqual(room.fixtures.find((fixture) => fixture.id === 'measured-drain'))
    expect(applied.fixtures.filter((fixture) => fixture.layout_generated)).toHaveLength(solutions[0].fixtures.length)
    expect(applied.dry_wet_zones?.[0].boundary).toHaveLength(4)
    expect(applyLayoutSolution(applied, solutions[0]).dry_wet_zones).toHaveLength(1)
  })

  it('anchors the generated toilet to the measured toilet drain and preserves every measured point', () => {
    const anchoredRoom = manualRoom(3200, 2600, 2700)
    anchoredRoom.fixtures.push(
      { id:'toilet-drain', kind:'drain', label:'马桶排水', point_usage:'toilet', x_mm:500, z_mm:305, width_mm:110, depth_mm:110, height_mm:10, rotation_deg:0, source:'measured', confidence:1 },
      { id:'toilet-for-toilet-drain', kind:'toilet', label:'马桶占位', x_mm:500, z_mm:305, width_mm:380, depth_mm:700, height_mm:760, rotation_deg:0, source:'derived', confidence:.9, evidence_ids:['toilet-drain:toilet-drain'] },
      { id:'shower-drain', kind:'floor_drain', label:'淋浴地漏', point_usage:'shower', x_mm:2700, z_mm:2100, width_mm:120, depth_mm:120, height_mm:10, rotation_deg:0, source:'measured', confidence:1 },
      { id:'basin-water', kind:'water', label:'台盆给水', point_usage:'basin', x_mm:150, z_mm:1200, width_mm:40, depth_mm:40, height_mm:10, rotation_deg:0, source:'measured', confidence:1 },
    )
    const solution = generateLayoutSolutions(anchoredRoom).find((candidate) => !candidate.checks.some((check) => check.severity === 'error' && !check.passed))!
    const applied = applyLayoutSolution(anchoredRoom, solution)
    expect(anchoredRoom.fixtures.filter((point) => point.kind !== 'toilet').every((point) => applied.fixtures.some((fixture) => fixture.id === point.id))).toBe(true)
    expect(applied.fixtures.some((fixture) => fixture.id === 'toilet-for-toilet-drain')).toBe(false)
    const toilet = applied.fixtures.find((fixture) => fixture.layout_generated && fixture.kind === 'toilet')!
    expect(Math.hypot(toilet.x_mm - 500, toilet.z_mm - 305)).toBeLessThanOrEqual(600)
    expect(solution.checks.find((check) => check.code === 'PLUMBING-TOILET')?.passed).toBe(true)
    expect(applied.fixtures.filter((fixture) => fixture.kind === 'floor_drain')).toHaveLength(1)
  })

  it('fits a toilet near a finished-wall corner while keeping the drain within the 600 mm adjustment limit', () => {
    const compact = manualRoom(1595, 1790, 2600)
    compact.fixtures.push({ id:'corner-toilet-drain', kind:'drain', label:'马桶排水', point_usage:'toilet', x_mm:1304, z_mm:1428, width_mm:110, depth_mm:110, height_mm:10, rotation_deg:0, source:'user', confidence:1 })
    const solution = generateLayoutSolutions(compact)[0]
    const toilet = solution.fixtures.find((fixture) => fixture.kind === 'toilet')!
    expect(solution.checks.find((check) => check.code === 'G01')).toMatchObject({ passed:true })
    expect(solution.checks.find((check) => check.code === 'G02-CLEARANCE')).toMatchObject({ passed:true })
    expect(Math.hypot(toilet.x_mm - 1304, toilet.z_mm - 1428)).toBeLessThanOrEqual(600)
  })

  it('uses supplied model bounds for categories that have parsed geometry', () => {
    const laundryRoom = structuredClone(room)
    laundryRoom.fixtures.push({ id:'washer-water', kind:'water', label:'洗衣机给水', point_usage:'general', x_mm:200, z_mm:1800, width_mm:40, depth_mm:40, height_mm:10, rotation_deg:0, source:'measured', confidence:1 })
    const laundry = generateLayoutSolutions(laundryRoom)[0]
    const washer = laundry.fixtures.find((fixture) => fixture.label.includes('洗衣机'))!
    expect([washer.width_mm, washer.depth_mm].sort((a, b) => a - b)).toEqual([608, 653])
    expect(fixtureLocalFootprint({ ...washer, rotation_deg:90 })).toEqual({ width_mm:washer.depth_mm, depth_mm:washer.width_mm })
    expect(washer.height_mm).toBe(860)
    expect(washer.label).toContain(modelDimensions['洗衣机'].file_name)
    expect(laundry.fixtures.some((fixture) => fixture.label === '自动洗衣机进水点' && fixture.kind === 'water')).toBe(true)
    expect(laundry.fixtures.some((fixture) => fixture.label === '自动洗衣机电点' && fixture.kind === 'electric')).toBe(true)
    const showerHead = laundry.fixtures.find((fixture) => fixture.label.includes('花洒') && !fixture.label.includes('扶手'))!
    const showerWaterPoints = laundry.fixtures.filter((fixture) => fixture.kind === 'water' && fixture.point_usage === 'shower')
    const showerWallIsVertical = showerHead.bound_wall_index === 1 || showerHead.bound_wall_index === 3
    expect(showerWallIsVertical ? showerHead.z_mm : showerHead.x_mm).toBe(showerWallIsVertical ? laundry.wet_zone.z_mm : laundry.wet_zone.x_mm)
    expect(showerWaterPoints).toHaveLength(2)
    expect(showerWaterPoints.every((fixture) => fixture.bound_wall_index === showerHead.bound_wall_index)).toBe(true)
    expect(showerWaterPoints.reduce((sum, fixture) => sum + (showerWallIsVertical ? fixture.z_mm : fixture.x_mm), 0) / 2).toBe(showerWallIsVertical ? showerHead.z_mm : showerHead.x_mm)
    expect(showerWaterPoints.every((fixture) => {
      const projection = projectPointToWall(finishedRoomBoundary({ ...laundryRoom, wall_finish_gap_mm:35 }), fixture.bound_wall_index!, fixture)
      return projection?.distance_mm === 0
    })).toBe(true)

    const vanity = laundry.fixtures.find((fixture) => fixture.kind === 'vanity')!
    expect([vanity.width_mm, vanity.depth_mm].sort((a, b) => a - b)).toEqual([200, 800])
    expect(vanity.height_mm).toBe(800)
    expect(vanity.x_mm - vanity.width_mm / 2).toBeGreaterThanOrEqual(finishedRoomBoundary({ ...laundryRoom, wall_finish_gap_mm:35 })[3].x_mm + 5)
    expect(laundry.fixtures.find((fixture) => fixture.label.includes('热水器'))?.elevation_mm).toBeGreaterThan(1200)
    expect(laundry.fixtures.find((fixture) => fixture.label.includes('花洒'))?.elevation_mm).toBe(700)
    expect(laundry.checks.find((item) => item.code === 'G06-WALL-ATTACH')).toMatchObject({ severity:'warning' })
    expect(laundry.checks.find((item) => item.code === 'MEP-AUTO-POINTS')).toMatchObject({ passed:true, severity:'error' })
    expect(laundry.checks.find((item) => item.code === 'MODEL-DIMENSIONS')?.message).toContain('马桶')
  })

  it('keeps the accessible vanity fully inside the 35 mm wall-panel boundary', () => {
    const product = graphOutput.scenarios.elderly_safe.products.find((item) => item.category === '适老浴室柜')!
    const level = {
      id:'level1' as const, name:'适老柜贴墙', reason:'适老柜墙板安装', demand_profile:'elderly_safe' as const, product_tier:'comfort' as const,
      product_ids:[product.graph_id], products:[{ product_id:product.graph_id, catalog_code:product.code, category:product.category, spec:product.spec, unit_price:product.price, price_unit:'件' }],
      layout_script:{ version:'layout-script-v1' as const, demand:'elderly_safe' as const, budget:'comfort' as const, source:'deterministic-rule-engine' as const, instructions:[
        { fixture_role:'wet_zone', wall:'east' as const, zone:'wet' as const, min_clearance_mm:0 },
        { fixture_role:'vanity', wall:'west' as const, zone:'dry' as const, min_clearance_mm:600 },
      ] },
    } satisfies LayoutLevelDecision
    const vanity = generateLayoutSolutions(room, { levels:[level] }).at(0)!.fixtures.find((fixture) => fixture.kind === 'vanity')!
    const finished = finishedRoomBoundary({ ...room, wall_finish_gap_mm:35 })
    expect(vanity.bound_wall_index).toBe(3)
    expect(vanity.x_mm - vanity.depth_mm / 2).toBe(finished[3].x_mm + 5)
  })

  it('resolves semantic walls against the actual segments of a non-rectangular room', () => {
    const measuredRoom = manualRoom(4105, 2160, 2200)
    measuredRoom.boundary = [
      {x_mm:0,z_mm:320},{x_mm:0,z_mm:2160},{x_mm:1255,z_mm:2160},{x_mm:1255,z_mm:1840},
      {x_mm:4105,z_mm:1840},{x_mm:4105,z_mm:0},{x_mm:2515,z_mm:0},{x_mm:2515,z_mm:610},
      {x_mm:1900,z_mm:610},{x_mm:1900,z_mm:0},{x_mm:260,z_mm:0},{x_mm:260,z_mm:320},
    ]
    measuredRoom.fixtures.push(
      {id:'shower-drain-nonrect',kind:'floor_drain',label:'淋浴地漏',point_usage:'shower',x_mm:3775,z_mm:276,width_mm:75,depth_mm:75,height_mm:10,rotation_deg:0,source:'measured',confidence:1},
      {id:'toilet-drain-nonrect',kind:'drain',label:'马桶排水',point_usage:'toilet',x_mm:3596,z_mm:1455,width_mm:110,depth_mm:110,height_mm:10,rotation_deg:0,source:'measured',confidence:1},
      {id:'toilet-for-toilet-drain-nonrect',kind:'toilet',label:'排污点临时马桶',x_mm:3596,z_mm:1455,width_mm:380,depth_mm:700,height_mm:760,rotation_deg:180,source:'derived',confidence:.9,evidence_ids:['toilet-drain:toilet-drain-nonrect']},
    )
    const solution = generateLayoutSolutions(measuredRoom)[0]
    const vanity = solution.fixtures.find((fixture)=>fixture.kind==='vanity')!
    const showerHead = solution.fixtures.find((fixture)=>fixture.label.includes('花洒')&&!fixture.label.includes('扶手'))!
    const showerPoints = solution.fixtures.filter((fixture)=>fixture.point_usage==='shower'&&fixture.kind==='water')
    expect(vanity.bound_wall_index).toBe(3)
    expect(showerHead.bound_wall_index).toBe(5)
    expect(showerPoints.every((fixture)=>fixture.bound_wall_index===showerHead.bound_wall_index)).toBe(true)
    expect(solution.checks.filter((check)=>check.severity==='error'&&!check.passed).map((check)=>check.code)).toEqual([])

    const accessibleProducts = [...graphOutput.scenarios.elderly_safe.products, graphOutput.scenarios.laundry.products.find((product)=>product.category==='洗衣机')!]
      .filter((product,index,all)=>all.findIndex((item)=>item.category===product.category)===index)
      .map((product)=>({product_id:product.graph_id,catalog_code:product.code,category:product.category,spec:product.spec,unit_price:product.price,price_unit:'件'}))
    const walls = [
      {wet:'east',vanity:'west',heater:'east'},
      {wet:'west',vanity:'south',heater:'west'},
      {wet:'south',vanity:'north',heater:'south'},
    ] as const
    const accessibleLevels = (['basic','comfort','premium'] as const).map((tier,index)=>({
      id:`level${index+1}` as 'level1'|'level2'|'level3',name:`适老方案 ${index+1}`,reason:'凹形房间适老求解',demand_profile:'elderly_safe' as const,product_tier:tier,
      product_ids:accessibleProducts.map((product)=>product.product_id),products:accessibleProducts,
      layout_script:{version:'layout-script-v1' as const,demand:'elderly_safe' as const,budget:tier,source:'deterministic-rule-engine' as const,instructions:[
        {fixture_role:'wet_zone',wall:walls[index].wet,zone:'wet' as const,min_clearance_mm:0},
        {fixture_role:'vanity',wall:walls[index].vanity,zone:'dry' as const,min_clearance_mm:600},
        {fixture_role:'toilet',wall:'nearest_plumbing' as const,zone:'dry' as const,min_clearance_mm:800},
        {fixture_role:'heater',wall:walls[index].heater,zone:'service' as const,min_clearance_mm:0},
        {fixture_role:'washer',wall:'south' as const,zone:'service' as const,min_clearance_mm:600},
        {fixture_role:'grab_bars',wall:walls[index].wet,zone:'wet' as const,min_clearance_mm:0},
      ]},
    })) satisfies LayoutLevelDecision[]
    const accessible = generateLayoutSolutions(measuredRoom,{levels:accessibleLevels})
    expect(accessible.map((candidate)=>candidate.checks.filter((check)=>check.severity==='error'&&!check.passed).map((check)=>check.code))).toEqual([[],[],[]])
  })
})
