const {
  distance,
  footprintVertices,
  pointInPolygon,
  pointOnSegment,
} = require('./geometry');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function topologyStatus(violations) {
  return violations.some(item => item.status === 'failed') ? 'failed' : 'unverified';
}

function buildTopology(measurement, placements = [], products = []) {
  const violations = [];
  const productById = new Map(products.map(product => [product.productId, product]));
  const drainById = new Map(asArray(measurement.drainagePoints).map(drain => [drain.drainId, drain]));
  const boundary = asArray(measurement.boundary);
  const walls = asArray(measurement.walls);

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
        status: walls.length === boundary.length ? 'confirmed' : 'failed',
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
    },
    status: topologyStatus(violations),
    violations,
  };
}

module.exports = {
  buildTopology,
};
