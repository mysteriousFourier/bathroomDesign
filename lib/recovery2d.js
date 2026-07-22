const {
  COORDINATE_TOLERANCE_MM,
  polygonArea,
  polygonPerimeter,
  samePoint,
  segmentLength,
  pointOnSegment,
  pointInPolygon,
  segmentsIntersect,
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

function isPoint(value) {
  return value && typeof value.x === 'number' && typeof value.y === 'number';
}

function intervalsOverlap(a, b) {
  return Math.max(a.start, b.start) <= Math.min(a.end, b.end) + COORDINATE_TOLERANCE_MM;
}

function openingInterval(opening, wall) {
  if (!isPoint(wall.startPoint) || !isPoint(wall.endPoint)) return null;
  const length = segmentLength(wall.startPoint, wall.endPoint);
  if (length === 0 || !isPoint(opening.position)) return null;
  const dx = wall.endPoint.x - wall.startPoint.x;
  const dy = wall.endPoint.y - wall.startPoint.y;
  const center = ((opening.position.x - wall.startPoint.x) * dx + (opening.position.y - wall.startPoint.y) * dy) / length;
  const halfWidth = opening.width / 2;
  return {
    start: center - halfWidth,
    end: center + halfWidth,
    length,
  };
}

function boundaryHasSelfIntersection(boundary) {
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i];
    const b = boundary[(i + 1) % boundary.length];
    for (let j = i + 1; j < boundary.length; j++) {
      const adjacent = Math.abs(i - j) === 1 || (i === 0 && j === boundary.length - 1);
      if (adjacent) continue;
      const c = boundary[j];
      const d = boundary[(j + 1) % boundary.length];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
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

  if (boundary.length >= 4 && boundaryHasSelfIntersection(boundary)) {
    violations.push({
      code: 'self_intersecting_boundary',
      status: 'failed',
      path: 'boundary',
      reason: 'boundary polygon edges must not cross each other',
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
      if (!isPoint(wall.startPoint) || !isPoint(wall.endPoint)) {
        violations.push({
          code: 'wall_missing_endpoint',
          status: 'failed',
          path: `walls[${index}]`,
          reason: `wall ${index} must include numeric startPoint and endPoint`,
        });
      }
      if (typeof wall.thickness === 'number' && wall.thickness <= 0) {
        violations.push({
          code: 'non_positive_wall_thickness',
          status: 'failed',
          path: `walls[${index}].thickness`,
          reason: `wall ${index} thickness must be positive`,
        });
      }
    });
  }

  const openingsByWall = new Map();
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
    if (!isPoint(opening.position)) {
      violations.push({
        code: 'opening_missing_position',
        status: 'failed',
        path: `openings[${index}].position`,
        reason: `opening ${opening.openingId} must include a numeric position`,
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
    const interval = openingInterval(opening, wall);
    if (interval && (interval.start < -COORDINATE_TOLERANCE_MM || interval.end > interval.length + COORDINATE_TOLERANCE_MM)) {
      violations.push({
        code: 'opening_width_exceeds_wall',
        status: 'failed',
        path: `openings[${index}].width`,
        reason: `opening ${opening.openingId} width or position exceeds wall ${opening.wallIndex} extents`,
      });
    }
    if (interval) {
      const existing = openingsByWall.get(opening.wallIndex) || [];
      existing.forEach(other => {
        if (intervalsOverlap(interval, other.interval)) {
          violations.push({
            code: 'opening_overlap',
            status: 'failed',
            path: `openings[${index}]`,
            reason: `opening ${opening.openingId} overlaps opening ${other.openingId} on wall ${opening.wallIndex}`,
          });
        }
      });
      existing.push({ openingId: opening.openingId, interval });
      openingsByWall.set(opening.wallIndex, existing);
    }
  });

  asArray(measurement.drainagePoints).forEach((drain, index) => {
    if (!isPoint(drain.position)) {
      violations.push({
        code: 'drain_missing_position',
        status: 'failed',
        path: `drainagePoints[${index}].position`,
        reason: `drain ${drain.drainId} must include a numeric position`,
      });
      return;
    }
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
    if (!Array.isArray(enclosure.boundary) || enclosure.boundary.length < 4) {
      violations.push({
        code: 'pipe_enclosure_missing_boundary',
        status: 'failed',
        path: `pipeEnclosures[${enclosureIndex}].boundary`,
        reason: `pipe enclosure ${enclosure.enclosureId} must include a boundary with at least four points`,
      });
      return;
    }
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
