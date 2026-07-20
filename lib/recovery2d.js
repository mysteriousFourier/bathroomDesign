const {
  COORDINATE_TOLERANCE_MM,
  polygonArea,
  polygonPerimeter,
  samePoint,
  segmentLength,
  pointOnSegment,
  pointInPolygon,
} = require('./geometry');

const RECOVERY_ENGINE = {
  engine: 'deterministic-2d-recovery',
  version: '1.0.0',
  seed: 2205,
  units: 'mm',
  coordinateSystem: 'finished-floor 2D, X right, Y inward, counterclockwise boundary',
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function requireHeights(measurement) {
  const missing = [];
  for (const key of ['roomHeight', 'groundElevation', 'wallHeight']) {
    if (!measurement.heights || typeof measurement.heights[key] !== 'number') {
      missing.push(`heights.${key}`);
    }
  }
  return missing;
}

function recover2D(measurement) {
  const violations = [];
  const missingHeights = requireHeights(measurement);
  missingHeights.forEach(path => {
    violations.push({
      code: 'missing_required_height',
      status: 'failed',
      path,
      reason: `${path} is required; recovery reads height only from heights.*`,
    });
  });

  if (!Array.isArray(measurement.boundary) || measurement.boundary.length < 4) {
    violations.push({
      code: 'invalid_boundary',
      status: 'failed',
      path: 'boundary',
      reason: 'boundary must contain at least four ordered points',
    });
  }

  const boundary = asArray(measurement.boundary);
  const walls = asArray(measurement.walls);
  const area = boundary.length >= 3 ? polygonArea(boundary) : 0;

  if (boundary.length >= 3 && area <= 0) {
    violations.push({
      code: 'boundary_winding_not_counterclockwise',
      status: 'failed',
      path: 'boundary',
      reason: 'boundary polygon area must be positive in the frozen coordinate system',
    });
  }

  if (walls.length !== boundary.length) {
    violations.push({
      code: 'wall_boundary_count_mismatch',
      status: 'failed',
      path: 'walls',
      reason: `walls length ${walls.length} does not match boundary edge count ${boundary.length}`,
    });
  } else {
    walls.forEach((wall, index) => {
      const start = boundary[index];
      const end = boundary[(index + 1) % boundary.length];
      if (!samePoint(wall.startPoint, start) || !samePoint(wall.endPoint, end)) {
        violations.push({
          code: 'wall_edge_mismatch',
          status: 'failed',
          path: `walls[${index}]`,
          reason: `wall ${index} endpoints do not match boundary edge ${index}`,
        });
      }
    });
  }

  asArray(measurement.openings).forEach((opening, index) => {
    const wall = walls[opening.wallIndex];
    if (!wall) {
      violations.push({
        code: 'opening_missing_wall',
        status: 'failed',
        path: `openings[${index}].wallIndex`,
        reason: `opening references missing wallIndex ${opening.wallIndex}`,
      });
      return;
    }
    if (!pointOnSegment(opening.position, wall.startPoint, wall.endPoint)) {
      violations.push({
        code: 'opening_off_wall',
        status: 'failed',
        path: `openings[${index}].position`,
        reason: `opening ${opening.openingId} position is not on wall ${opening.wallIndex}`,
      });
    }
    if (opening.width > segmentLength(wall.startPoint, wall.endPoint) + COORDINATE_TOLERANCE_MM) {
      violations.push({
        code: 'opening_width_exceeds_wall',
        status: 'failed',
        path: `openings[${index}].width`,
        reason: `opening ${opening.openingId} width exceeds wall ${opening.wallIndex} length`,
      });
    }
  });

  asArray(measurement.drainagePoints).forEach((drain, index) => {
    if (!pointInPolygon(drain.position, boundary)) {
      violations.push({
        code: 'drain_outside_room',
        status: 'failed',
        path: `drainagePoints[${index}].position`,
        reason: `drain ${drain.drainId} is outside room boundary`,
      });
    }
  });

  asArray(measurement.pipeEnclosures).forEach((enclosure, enclosureIndex) => {
    asArray(enclosure.boundary).forEach((point, pointIndex) => {
      if (!pointInPolygon(point, boundary)) {
        violations.push({
          code: 'pipe_enclosure_outside_room',
          status: 'failed',
          path: `pipeEnclosures[${enclosureIndex}].boundary[${pointIndex}]`,
          reason: `pipe enclosure ${enclosure.enclosureId} vertex ${pointIndex} is outside room boundary`,
        });
      }
    });
  });

  return {
    schemaVersion: '1.0.0',
    recoveryId: `REC-${measurement.roomId || 'unknown'}`,
    engine: RECOVERY_ENGINE,
    roomId: measurement.roomId,
    heights: {
      roomHeight: measurement.heights?.roomHeight,
      groundElevation: measurement.heights?.groundElevation,
      wallHeight: measurement.heights?.wallHeight,
      netHeight: measurement.heights?.netHeight,
      doorOpeningHeight: measurement.heights?.doorOpeningHeight,
    },
    geometry: {
      boundaryVertexCount: boundary.length,
      wallCount: walls.length,
      areaMm2: Math.abs(area),
      perimeterMm: boundary.length >= 2 ? polygonPerimeter(boundary) : 0,
      winding: area > 0 ? 'counterclockwise' : 'not_counterclockwise',
      closed: walls.length === boundary.length && violations.every(item => item.code !== 'wall_edge_mismatch'),
    },
    optionalInputs: {
      openingsPresent: Object.prototype.hasOwnProperty.call(measurement, 'openings'),
      drainagePointsPresent: Object.prototype.hasOwnProperty.call(measurement, 'drainagePoints'),
      pipeEnclosuresPresent: Object.prototype.hasOwnProperty.call(measurement, 'pipeEnclosures'),
      openingCount: asArray(measurement.openings).length,
      drainagePointCount: asArray(measurement.drainagePoints).length,
      pipeEnclosureCount: asArray(measurement.pipeEnclosures).length,
    },
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
  };
}

module.exports = {
  RECOVERY_ENGINE,
  recover2D,
};
