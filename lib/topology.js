const {
  COORDINATE_TOLERANCE_MM,
  distance,
  footprintVertices,
  pointInPolygon,
  pointOnSegment,
  samePoint,
  segmentsIntersect,
} = require('./geometry');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function topologyStatus(violations) {
  return violations.some(item => item.status === 'failed') ? 'failed' : 'unverified';
}

function relationStatus(violations, codes) {
  return violations.some(item => codes.includes(item.code) && item.status === 'failed') ? 'failed' : 'confirmed';
}

function adjacentEdges(edgeA, edgeB, edgeCount) {
  return Math.abs(edgeA - edgeB) === 1 || Math.abs(edgeA - edgeB) === edgeCount - 1;
}

function checkBoundaryClosure(boundary, walls, violations) {
  if (boundary.length < 4) {
    violations.push({
      code: 'boundary_closure_invalid',
      status: 'failed',
      path: 'boundary',
      reason: 'room boundary must contain at least 4 vertices for W1D4 topology',
    });
  }

  const boundaryEdges = boundary.map((start, index) => ({
    start,
    end: boundary[(index + 1) % boundary.length],
    index,
  }));

  boundaryEdges.forEach(edge => {
    if (samePoint(edge.start, edge.end)) {
      violations.push({
        code: 'boundary_zero_length_edge',
        status: 'failed',
        path: `boundary[${edge.index}]`,
        reason: `boundary edge ${edge.index} has identical start and end coordinates`,
      });
    }
  });

  for (let i = 0; i < boundaryEdges.length; i++) {
    for (let j = i + 1; j < boundaryEdges.length; j++) {
      if (adjacentEdges(i, j, boundaryEdges.length)) continue;
      if (segmentsIntersect(boundaryEdges[i].start, boundaryEdges[i].end, boundaryEdges[j].start, boundaryEdges[j].end)) {
        violations.push({
          code: 'boundary_self_intersection',
          status: 'failed',
          path: `boundary[${i}],boundary[${j}]`,
          reason: `boundary edge ${i} intersects non-adjacent edge ${j}`,
        });
      }
    }
  }

  if (walls.length !== boundary.length) {
    violations.push({
      code: 'wall_closure_invalid',
      status: 'failed',
      path: 'walls',
      reason: `wall count ${walls.length} does not match boundary edge count ${boundary.length}`,
    });
  }

  walls.forEach((wall, index) => {
    const nextWall = walls[(index + 1) % walls.length];
    const boundaryEdge = boundaryEdges[index];
    if (nextWall && !samePoint(wall.endPoint, nextWall.startPoint)) {
      violations.push({
        code: 'wall_closure_invalid',
        status: 'failed',
        path: `walls[${index}].endPoint`,
        reason: `wall ${index} endPoint does not connect to wall ${(index + 1) % walls.length} startPoint`,
      });
    }
    if (boundaryEdge && (!samePoint(wall.startPoint, boundaryEdge.start) || !samePoint(wall.endPoint, boundaryEdge.end))) {
      violations.push({
        code: 'wall_boundary_mismatch',
        status: 'failed',
        path: `walls[${index}]`,
        reason: `wall ${index} endpoints do not match boundary edge ${index}`,
      });
    }
  });
}

function buildTopology(measurement, placements = [], products = []) {
  const violations = [];
  const productById = new Map(products.map(product => [product.productId, product]));
  const drainById = new Map(asArray(measurement.drainagePoints).map(drain => [drain.drainId, drain]));
  const boundary = asArray(measurement.boundary);
  const walls = asArray(measurement.walls);
  const placementCountByDrain = placements.reduce((counts, placement) => {
    if (placement.targetDrainagePoint) {
      counts.set(placement.targetDrainagePoint, (counts.get(placement.targetDrainagePoint) || 0) + 1);
    }
    return counts;
  }, new Map());

  checkBoundaryClosure(boundary, walls, violations);

  const wallNodes = walls.map((wall, index) => ({
    id: `wall-${index}`,
    wallIndex: index,
    startPoint: wall.startPoint,
    endPoint: wall.endPoint,
    type: wall.type || 'unverified',
    status: 'confirmed',
  }));

  const openingNodes = asArray(measurement.openings).map((opening, index) => {
    const wall = walls[opening.wallIndex];
    let status = 'confirmed';
    if (!wall || !pointOnSegment(opening.position, wall.startPoint, wall.endPoint)) {
      status = 'failed';
      violations.push({
        code: 'opening_ownership_invalid',
        status: 'failed',
        path: `openings[${index}]`,
        reason: `opening ${opening.openingId} does not belong to wall ${opening.wallIndex}`,
      });
    }
    return {
      id: `opening-${opening.openingId}`,
      openingId: opening.openingId,
      wallIndex: opening.wallIndex,
      ownerWallId: wall ? `wall-${opening.wallIndex}` : null,
      type: opening.type,
      status,
    };
  });

  const drainNodes = asArray(measurement.drainagePoints).map((drain, index) => {
    let status = 'confirmed';
    if (!pointInPolygon(drain.position, boundary)) {
      status = 'failed';
      violations.push({
        code: 'drain_outside_room',
        status: 'failed',
        path: `drainagePoints[${index}]`,
        reason: `drain ${drain.drainId} is outside room boundary`,
      });
    }
    return {
      id: `drain-${drain.drainId}`,
      drainId: drain.drainId,
      type: drain.type,
      position: drain.position,
      status,
    };
  });

  const pipeNodes = asArray(measurement.pipeEnclosures).map((enclosure, enclosureIndex) => {
    let status = 'confirmed';
    asArray(enclosure.boundary).forEach((point, pointIndex) => {
      if (!pointInPolygon(point, boundary)) {
        status = 'failed';
        violations.push({
          code: 'pipe_enclosure_outside_room',
          status: 'failed',
          path: `pipeEnclosures[${enclosureIndex}].boundary[${pointIndex}]`,
          reason: `pipe enclosure ${enclosure.enclosureId} vertex ${pointIndex} is outside room boundary`,
        });
      }
    });
    return {
      id: `pipe-${enclosure.enclosureId}`,
      enclosureId: enclosure.enclosureId,
      status,
    };
  });

  const fixtureNodes = placements.map((placement, index) => {
    const product = productById.get(placement.productId);
    const vertices = footprintVertices(placement);
    const outsideVertexIndexes = vertices
      .map((point, pointIndex) => ({ point, pointIndex }))
      .filter(({ point }) => !pointInPolygon(point, boundary))
      .map(({ pointIndex }) => pointIndex);
    const targetDrain = placement.targetDrainagePoint ? drainById.get(placement.targetDrainagePoint) : null;
    const drainDistanceMm = targetDrain ? distance(placement.position, targetDrain.position) : null;
    let status = 'unverified';

    if (!product) {
      status = 'failed';
      violations.push({
        code: 'fixture_product_missing',
        status: 'failed',
        path: `placements[${index}].productId`,
        reason: `placement ${placement.placementId} references missing product ${placement.productId}`,
      });
    }
    if (product && product.installRequirements?.requiresDrain && !targetDrain) {
      status = 'failed';
      violations.push({
        code: 'fixture_drain_missing',
        status: 'failed',
        path: `placements[${index}].targetDrainagePoint`,
        reason: `placement ${placement.placementId} requires a target drainage point in measurement.drainagePoints`,
      });
    }
    if (outsideVertexIndexes.length > 0) {
      status = 'failed';
      violations.push({
        code: 'fixture_outside_room',
        status: 'failed',
        path: `placements[${index}].footprint`,
        reason: `placement ${placement.placementId} footprint vertices outside room: ${outsideVertexIndexes.join(', ')}`,
      });
    }
    if (targetDrain && !pointInPolygon(targetDrain.position, vertices)) {
      status = 'failed';
      violations.push({
        code: 'fixture_drain_not_in_footprint',
        status: 'failed',
        path: `placements[${index}].targetDrainagePoint`,
        reason: `target drain ${targetDrain.drainId} is not inside fixture ${placement.placementId} footprint`,
      });
    }
    if (targetDrain && drainDistanceMm > COORDINATE_TOLERANCE_MM) {
      violations.push({
        code: 'drainage_alignment_pending_threshold',
        status: 'unverified',
        path: `placements[${index}].targetDrainagePoint`,
        reason: `placement ${placement.placementId} drain offset is ${Number(drainDistanceMm.toFixed(6))} mm; THR-TOPO-003 is pending_business_confirmation`,
      });
    }

    return {
      id: `fixture-${placement.placementId}`,
      placementId: placement.placementId,
      productId: placement.productId,
      targetDrainagePoint: placement.targetDrainagePoint || null,
      footprintType: placement.footprint.type,
      footprintVertices: vertices,
      drainAlignment: targetDrain
        ? {
            targetDrainagePoint: targetDrain.drainId,
            distanceMm: Number(drainDistanceMm.toFixed(6)),
            status: 'unverified',
            reason: 'THR-TOPO-003 is pending_business_confirmation; distance is reported but not accepted',
          }
        : null,
      status,
    };
  });

  return {
    schemaVersion: '1.0.0',
    topologyId: `TOPO-${measurement.roomId || 'unknown'}`,
    roomId: measurement.roomId,
    source: {
      measurementRoomId: measurement.roomId,
      fixturePlacementCount: placements.length,
      productCount: products.length,
      evidenceIds: ['EV-007', 'EV-008'],
    },
    nodes: {
      room: {
        id: `room-${measurement.roomId}`,
        boundaryVertexCount: boundary.length,
        status: 'confirmed',
      },
      walls: wallNodes,
      openings: openingNodes,
      drains: drainNodes,
      pipeEnclosures: pipeNodes,
      fixtures: fixtureNodes,
    },
    relations: {
      wallClosure: {
        wallCount: walls.length,
        boundaryEdgeCount: boundary.length,
        status: relationStatus(violations, ['boundary_closure_invalid', 'boundary_zero_length_edge', 'boundary_self_intersection', 'wall_closure_invalid', 'wall_boundary_mismatch']),
      },
      openingOwnership: openingNodes.map(node => ({
        openingId: node.openingId,
        wallIndex: node.wallIndex,
        ownerWallId: node.ownerWallId,
        status: node.status,
      })),
      fixtureContainment: fixtureNodes.map(node => ({
        placementId: node.placementId,
        footprintType: node.footprintType,
        status: node.status === 'failed' ? 'failed' : 'confirmed',
      })),
      drainAlignment: fixtureNodes
        .filter(node => node.drainAlignment)
        .map(node => ({
          placementId: node.placementId,
          ...node.drainAlignment,
        })),
      sharedDrainage: Array.from(placementCountByDrain.entries())
        .filter(([, placementCount]) => placementCount > 1)
        .map(([drainId, placementCount]) => ({
          drainId,
          placementCount,
          status: 'unverified',
          reason: 'THR-TOPO-005 is pending_business_confirmation; shared drainage is reported but not accepted',
        })),
    },
    status: topologyStatus(violations),
    violations,
  };
}

module.exports = {
  buildTopology,
};
