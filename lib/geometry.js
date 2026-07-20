const COORDINATE_TOLERANCE_MM = 1;

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function samePoint(a, b) {
  return a && b && a.x === b.x && a.y === b.y;
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function polygonPerimeter(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function signedTriangleArea(a, b, c) {
  return ((b.x - a.x) * (c.y - a.y)) - ((b.y - a.y) * (c.x - a.x));
}

function segmentLength(start, end) {
  return distance(start, end);
}

function distancePointToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, start);

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  const projected = {
    x: start.x + t * dx,
    y: start.y + t * dy,
  };
  return distance(point, projected);
}

function pointOnSegment(point, start, end, toleranceMm = COORDINATE_TOLERANCE_MM) {
  if (!point || !start || !end) return false;
  if (distancePointToSegment(point, start, end) > toleranceMm) return false;
  const minX = Math.min(start.x, end.x) - toleranceMm;
  const maxX = Math.max(start.x, end.x) + toleranceMm;
  const minY = Math.min(start.y, end.y) - toleranceMm;
  const maxY = Math.max(start.y, end.y) + toleranceMm;
  return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
}

function segmentsIntersect(a, b, c, d, toleranceMm = COORDINATE_TOLERANCE_MM) {
  const abC = signedTriangleArea(a, b, c);
  const abD = signedTriangleArea(a, b, d);
  const cdA = signedTriangleArea(c, d, a);
  const cdB = signedTriangleArea(c, d, b);

  if (Math.abs(abC) <= toleranceMm && pointOnSegment(c, a, b, toleranceMm)) return true;
  if (Math.abs(abD) <= toleranceMm && pointOnSegment(d, a, b, toleranceMm)) return true;
  if (Math.abs(cdA) <= toleranceMm && pointOnSegment(a, c, d, toleranceMm)) return true;
  if (Math.abs(cdB) <= toleranceMm && pointOnSegment(b, c, d, toleranceMm)) return true;

  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0);
}

function pointInPolygon(point, polygon, toleranceMm = COORDINATE_TOLERANCE_MM) {
  if (!point || !Array.isArray(polygon) || polygon.length < 3) return false;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (pointOnSegment(point, a, b, toleranceMm)) return true;
  }

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && (point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x);
    if (intersects) inside = !inside;
  }
  return inside;
}

function rotatePoint(point, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

function toAbsoluteFootprintPoint(placement, relativePoint) {
  const rotated = rotatePoint(relativePoint, placement.orientation?.rotationZ || 0);
  return {
    x: Number((placement.position.x + rotated.x).toFixed(6)),
    y: Number((placement.position.y + rotated.y).toFixed(6)),
  };
}

function rectangularFootprintVertices(placement) {
  const halfWidth = placement.footprint.width / 2;
  const halfDepth = placement.footprint.depth / 2;
  return [
    { x: -halfWidth, y: -halfDepth },
    { x: halfWidth, y: -halfDepth },
    { x: halfWidth, y: halfDepth },
    { x: -halfWidth, y: halfDepth },
  ].map(point => toAbsoluteFootprintPoint(placement, point));
}

function circularFootprintVertices(placement, segmentCount = 16) {
  const radius = placement.footprint.width / 2;
  return Array.from({ length: segmentCount }, (_, index) => {
    const radians = (index / segmentCount) * Math.PI * 2;
    return {
      x: Number((placement.position.x + radius * Math.cos(radians)).toFixed(6)),
      y: Number((placement.position.y + radius * Math.sin(radians)).toFixed(6)),
    };
  });
}

function footprintVertices(placement) {
  if (placement.footprint.type === 'circular') {
    return circularFootprintVertices(placement);
  }
  if (placement.footprint.type === 'polygonal') {
    return placement.footprint.vertices.map(vertex => toAbsoluteFootprintPoint(placement, vertex));
  }
  return rectangularFootprintVertices(placement);
}

module.exports = {
  COORDINATE_TOLERANCE_MM,
  cloneJSON,
  samePoint,
  polygonArea,
  polygonPerimeter,
  distance,
  signedTriangleArea,
  segmentLength,
  distancePointToSegment,
  pointOnSegment,
  segmentsIntersect,
  pointInPolygon,
  rotatePoint,
  footprintVertices,
};
