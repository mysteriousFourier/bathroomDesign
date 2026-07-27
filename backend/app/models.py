from __future__ import annotations

from enum import Enum
from typing import Literal

import re

from pydantic import BaseModel, Field, field_validator, model_validator


class SourceKind(str, Enum):
    measured = "measured"
    derived = "derived"
    estimated = "estimated"
    user = "user"


EvidenceRole = Literal[
    "room_dimension",
    "wall_segment",
    "wall_thickness",
    "room_height",
    "ceiling_height",
    "door_size",
    "door_position",
    "drain_position",
    "pipe_box",
    "fixture_dimension",
    "fixture_label",
    "other",
]


class Point2D(BaseModel):
    x_mm: int
    z_mm: int


class Observation(BaseModel):
    field: str
    value: str
    source: SourceKind = SourceKind.estimated
    asset_id: str | None = None
    bbox: ImageBBox | None = None
    confidence: float = Field(default=0.5, ge=0, le=1)
    confirmed: bool = False
    alternatives: list[str] = Field(default_factory=list)
    note: str = ""
    semantic_role: EvidenceRole = "other"
    review_required: bool = False
    rotation_degrees: Literal[0, 90, 180, 270] = 0
    target_id: str | None = None


class OpeningSpec(BaseModel):
    id: str
    kind: Literal["door", "window", "opening"] = "door"
    wall_index: int = Field(ge=0)
    offset_mm: int = Field(ge=0)
    width_mm: int = Field(gt=0)
    height_mm: int = Field(gt=0)
    thickness_mm: int | None = Field(default=None, gt=0)
    sill_mm: int = Field(default=0, ge=0)
    label: str = "门洞"
    source: SourceKind = SourceKind.estimated
    confidence: float = Field(default=0.5, ge=0, le=1)
    swing_direction: Literal["left", "right", "inward", "outward", "unknown"] = "unknown"
    evidence_ids: list[str] = Field(default_factory=list)


class FixtureSpec(BaseModel):
    id: str
    kind: Literal[
        "toilet",
        "vanity",
        "shower",
        "floor_drain",
        "pipe",
        "column",
        "radiator",
        "other",
    ]
    label: str
    x_mm: int
    z_mm: int
    width_mm: int = Field(gt=0)
    depth_mm: int = Field(gt=0)
    height_mm: int = Field(gt=0)
    rotation_deg: int = 0
    source: SourceKind = SourceKind.estimated
    confidence: float = Field(default=0.5, ge=0, le=1)
    evidence_ids: list[str] = Field(default_factory=list)


class WallProfile(BaseModel):
    wall_index: int = Field(ge=0)
    kind: Literal["interior", "exterior", "pipe_chase", "other"] = "interior"
    thickness_mm: int = Field(gt=0)
    source: SourceKind = SourceKind.estimated
    confidence: float = Field(default=0.5, ge=0, le=1)
    evidence_ids: list[str] = Field(default_factory=list)


class CeilingZone(BaseModel):
    id: str
    label: str = "吊顶"
    boundary: list[Point2D] = Field(min_length=3)
    height_mm: int = Field(gt=0)
    source: SourceKind = SourceKind.estimated
    confidence: float = Field(default=0.5, ge=0, le=1)
    evidence_ids: list[str] = Field(default_factory=list)


class ValidationIssue(BaseModel):
    id: str
    severity: Literal["error", "warning", "info"]
    code: str
    message: str
    target_id: str | None = None


class ImageBBox(BaseModel):
    """Coordinates normalized to the displayed image's 0..1000 space."""

    x_min: int = Field(ge=0, le=1000)
    y_min: int = Field(ge=0, le=1000)
    x_max: int = Field(ge=0, le=1000)
    y_max: int = Field(ge=0, le=1000)

    @model_validator(mode="before")
    @classmethod
    def normalize_common_model_formats(cls, value: object) -> object:
        if isinstance(value, (list, tuple)) and len(value) == 4:
            value = {"x_min": value[0], "y_min": value[1], "x_max": value[2], "y_max": value[3]}
        if not isinstance(value, dict):
            return value
        data = dict(value)
        if not {"x_min", "y_min", "x_max", "y_max"}.issubset(data):
            if {"x", "y", "width", "height"}.issubset(data):
                data = {
                    "x_min": data["x"], "y_min": data["y"],
                    "x_max": float(data["x"]) + float(data["width"]),
                    "y_max": float(data["y"]) + float(data["height"]),
                }
            elif {"minx", "miny", "maxx", "maxy"}.issubset(data):
                data = {"x_min": data["minx"], "y_min": data["miny"], "x_max": data["maxx"], "y_max": data["maxy"]}
            elif {"min_x", "min_y", "max_x", "max_y"}.issubset(data):
                data = {"x_min": data["min_x"], "y_min": data["min_y"], "x_max": data["max_x"], "y_max": data["max_y"]}
        try:
            raw_x_min, raw_x_max = sorted((round(float(data["x_min"])), round(float(data["x_max"]))))
            raw_y_min, raw_y_max = sorted((round(float(data["y_min"])), round(float(data["y_max"]))))
            x_min = max(0, min(999, raw_x_min))
            y_min = max(0, min(999, raw_y_min))
            x_max = max(x_min + 1, min(1000, raw_x_max))
            y_max = max(y_min + 1, min(1000, raw_y_max))
        except (KeyError, TypeError, ValueError):
            return data
        return {"x_min": x_min, "y_min": y_min, "x_max": x_max, "y_max": y_max}

    @model_validator(mode="after")
    def ordered(self) -> ImageBBox:
        if self.x_max <= self.x_min or self.y_max <= self.y_min:
            raise ValueError("bbox maximum coordinates must exceed minimum coordinates")
        return self


class VisualEvidence(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    kind: Literal["dimension", "height", "opening", "label", "fixture", "wall", "other"]
    text: str = Field(min_length=1, max_length=300)
    bbox: ImageBBox
    orientation: Literal["horizontal", "vertical", "free"] = "free"
    related_to: str = ""
    view_id: str = "full"
    confidence: float = Field(default=0.5, ge=0, le=1)

    @field_validator("id", mode="before")
    @classmethod
    def coerce_numeric_id(cls, value: object) -> str:
        return str(value)

    @field_validator("related_to", mode="before")
    @classmethod
    def default_null_relation(cls, value: object) -> str:
        return "" if value is None else str(value)

    @field_validator("view_id", mode="before")
    @classmethod
    def coerce_view_id(cls, value: object) -> str:
        return "full" if value is None else str(value)


class PlanEvidenceReport(BaseModel):
    rotation_degrees: Literal[0, 90, 180, 270] = 0
    evidence: list[VisualEvidence] = Field(default_factory=list)
    uncertain: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def discard_empty_evidence(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        if isinstance(data.get("evidence"), list):
            data["evidence"] = [
                item for item in data["evidence"]
                if isinstance(item, (dict, VisualEvidence))
                and (isinstance(item, VisualEvidence) or bool(str(item.get("text", "")).strip()))
            ]
        return data

    @field_validator("uncertain", mode="before")
    @classmethod
    def normalize_uncertain(cls, value: object) -> list[str]:
        if value in (None, {}, ""):
            return []
        if isinstance(value, list):
            return [str(item) for item in value]
        return [str(value)]


class DimensionEvidenceRef(BaseModel):
    value_mm: int = Field(gt=0)
    evidence_ids: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0.5, ge=0, le=1)
    purpose: Literal["wall_segment", "door_opening", "gap"] | None = None

    @field_validator("confidence", mode="before")
    @classmethod
    def default_null_confidence(cls, value: object) -> object:
        return 0.5 if value in (None, "") else value

    @field_validator("evidence_ids", mode="before")
    @classmethod
    def coerce_evidence_ids(cls, value: object) -> list[str]:
        return [str(item) for item in (value or [])]


class CriticalDimensionRoles(BaseModel):
    overall_width: DimensionEvidenceRef | None = None
    overall_depth: DimensionEvidenceRef | None = None
    overall_width_segments: list[DimensionEvidenceRef] = Field(default_factory=list)
    overall_depth_segments: list[DimensionEvidenceRef] = Field(default_factory=list)
    room_height: DimensionEvidenceRef | None = None
    door_width: DimensionEvidenceRef | None = None
    door_height: DimensionEvidenceRef | None = None
    door_right_return: DimensionEvidenceRef | None = None
    uncertain: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def normalize_shorthand_refs(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        def normalize_ref(raw: object) -> object:
            if raw is None or isinstance(raw, (dict, DimensionEvidenceRef)):
                return raw
            text = str(raw)
            evidence_ids = re.findall(r"\bE\d+\b", text, flags=re.IGNORECASE)
            without_ids = re.sub(r"\bE\d+\b", "", text, flags=re.IGNORECASE)
            numbers = re.findall(r"\d+(?:[.,]\d+)?", without_ids)
            if not numbers:
                return None
            token = numbers[-1].replace(",", ".")
            number = float(token)
            value_mm = round(number * 1000) if "." in token and number < 20 else round(number)
            return {"value_mm": value_mm, "evidence_ids": evidence_ids, "confidence": 0.5}

        for field_name in ("overall_width", "overall_depth", "room_height", "door_width", "door_height", "door_right_return"):
            raw = data.get(field_name)
            data[field_name] = normalize_ref(raw)
        for field_name in ("overall_width_segments", "overall_depth_segments"):
            raw_items = data.get(field_name) or []
            if isinstance(raw_items, list):
                data[field_name] = [normalized for item in raw_items if (normalized := normalize_ref(item)) is not None]
        return data


class BoundaryChainSegment(BaseModel):
    value_mm: int = Field(gt=0)
    purpose: Literal["wall_segment", "door_opening", "gap"]
    source_text: str = ""
    evidence_ids: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0.5, ge=0, le=1)

    @field_validator("evidence_ids", mode="before")
    @classmethod
    def coerce_evidence_ids(cls, value: object) -> list[str]:
        return [str(item) for item in (value or [])]


class BoundaryReturn(BaseModel):
    position: Literal["before_door", "after_door"]
    direction: Literal["right", "down", "left", "up"]
    value_mm: int = Field(gt=0)
    source_text: str = ""
    evidence_ids: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0.5, ge=0, le=1)

    @field_validator("evidence_ids", mode="before")
    @classmethod
    def coerce_evidence_ids(cls, value: object) -> list[str]:
        return [str(item) for item in (value or [])]


class BoundaryChainResult(BaseModel):
    wall_side: Literal["top", "right", "bottom", "left", "unknown"] = "unknown"
    wall_orientation: Literal["horizontal", "vertical", "unknown"] = "unknown"
    traversal: Literal["left_to_right", "right_to_left", "top_to_bottom", "bottom_to_top", "unknown"] = "unknown"
    complete: bool = False
    segments: list[BoundaryChainSegment] = Field(default_factory=list)
    returns: list[BoundaryReturn] = Field(default_factory=list)
    door_height_mm: int | None = Field(default=None, gt=0)
    door_height_text: str = ""
    door_height_evidence_ids: list[str] = Field(default_factory=list)
    door_height_confidence: float = Field(default=0.5, ge=0, le=1)
    uncertain: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def discard_non_axis_segments(cls, value: object) -> object:
        if not isinstance(value, dict) or not isinstance(value.get("segments"), list):
            return value
        data = dict(value)
        allowed = {"wall_segment", "door_opening", "gap"}
        discarded = []
        segments = []
        for item in data["segments"]:
            if isinstance(item, BoundaryChainSegment):
                segments.append(item)
                continue
            if not isinstance(item, dict):
                continue
            purpose = str(item.get("purpose", ""))
            if purpose not in allowed:
                discarded.append(purpose or "unknown")
                continue
            segments.append(item)
        data["segments"] = segments
        if discarded:
            uncertain = list(data.get("uncertain") or [])
            uncertain.append("门墙结果含非轴向字段，已忽略：" + ", ".join(discarded))
            data["uncertain"] = uncertain
        return data

    @field_validator("door_height_confidence", mode="before")
    @classmethod
    def default_null_confidence(cls, value: object) -> object:
        return 0.5 if value is None else value

    @field_validator("door_height_evidence_ids", mode="before")
    @classmethod
    def coerce_door_height_evidence_ids(cls, value: object) -> list[str]:
        return [str(item) for item in (value or [])]


class EvidenceItem(BaseModel):
    evidence_id: str | None = None
    text: str
    meaning: str = ""
    bbox: ImageBBox | None = None
    confidence: float = Field(default=0.5, ge=0, le=1)

    @field_validator("bbox", mode="before")
    @classmethod
    def discard_incomplete_bbox(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        required = ("x_min", "y_min", "x_max", "y_max")
        if not all(key in value and value[key] not in (None, "") for key in required):
            return None
        return value

    @field_validator("confidence", mode="before")
    @classmethod
    def default_null_confidence(cls, value: object) -> object:
        return 0.5 if value in (None, "") else value


class OpeningCandidate(BaseModel):
    kind: Literal["door", "window", "opening"] = "door"
    wall_index: int | None = Field(default=0, ge=0)
    offset_mm: int | None = Field(default=0, ge=0)
    width_mm: int = Field(gt=0)
    height_mm: int | None = Field(default=None, gt=0)
    sill_mm: int | None = Field(default=0, ge=0)
    label: str = "门洞"
    confidence: float = Field(default=0.5, ge=0, le=1)
    evidence_ids: list[str] = Field(default_factory=list)

    @field_validator("confidence", mode="before")
    @classmethod
    def default_null_confidence(cls, value: object) -> object:
        return 0.5 if value is None else value


class BoundaryEdge(BaseModel):
    """One ordered orthogonal edge of the usable room boundary."""

    direction: Literal["right", "down", "left", "up"]
    length_mm: int | None = Field(default=None, gt=0)
    role: Literal["wall", "door_jamb", "structure_return", "other"] = "wall"
    evidence_ids: list[str] = Field(default_factory=list)
    confidence: float = Field(default=0.5, ge=0, le=1)

    @field_validator("role", mode="before")
    @classmethod
    def normalize_role(cls, value: object) -> str:
        aliases = {
            "wall_segment": "wall",
            "gap": "other",
            "door_opening": "door_jamb",
            "return": "structure_return",
        }
        text = str(value or "wall")
        return aliases.get(text, text)

    @field_validator("confidence", mode="before")
    @classmethod
    def default_null_confidence(cls, value: object) -> object:
        return 0.5 if value is None else value

    @field_validator("evidence_ids", mode="before")
    @classmethod
    def coerce_evidence_ids(cls, value: object) -> list[str]:
        return [str(item) for item in (value or [])]


class ShapeCorner(BaseModel):
    x: int = Field(ge=0, le=1000)
    y: int = Field(ge=0, le=1000)
    role: Literal["wall_corner", "structure_return", "door_jamb", "other"] = "wall_corner"
    confidence: float = Field(default=0.5, ge=0, le=1)


class ShapeTraceResult(BaseModel):
    corners: list[ShapeCorner] = Field(default_factory=list)
    closed: bool = False
    uncertain: list[str] = Field(default_factory=list)

    @field_validator("uncertain", mode="before")
    @classmethod
    def normalize_uncertain(cls, value: object) -> list[str]:
        if value in (None, {}, ""):
            return []
        return [str(item) for item in value] if isinstance(value, list) else [str(value)]


class TopologyCandidate(BaseModel):
    id: str
    corners: list[ShapeCorner]
    pixel_support: float = Field(default=0.5, ge=0, le=1)


class TopologyCandidateSelection(BaseModel):
    selected_id: str | None = None
    accepted: bool = False
    confidence: float = Field(default=0.5, ge=0, le=1)
    missing_features: list[str] = Field(default_factory=list)

    @field_validator("confidence", mode="before")
    @classmethod
    def default_confidence(cls, value: object) -> object:
        return 0.5 if value in (None, "") else value

    @field_validator("missing_features", mode="before")
    @classmethod
    def normalize_missing_features(cls, value: object) -> list[str]:
        if value in (None, {}, ""):
            return []
        return [str(item) for item in value] if isinstance(value, list) else [str(value)]


class FixtureCandidate(BaseModel):
    kind: Literal["floor_drain", "pipe", "column", "other"]
    label: str
    x_mm: int | None = None
    z_mm: int | None = None
    width_mm: int | None = Field(default=None, gt=0)
    depth_mm: int | None = Field(default=None, gt=0)
    height_mm: int | None = Field(default=None, gt=0)
    confidence: float = Field(default=0.5, ge=0, le=1)
    evidence_ids: list[str] = Field(default_factory=list)

    @field_validator("kind", mode="before")
    @classmethod
    def normalize_kind(cls, value: object) -> str:
        text = str(value).lower()
        if any(token in text for token in ("drain", "地漏", "排水")):
            return "floor_drain"
        if any(token in text for token in ("pipe", "管")):
            return "pipe"
        if any(token in text for token in ("column", "柱")):
            return "column"
        return text if text in {"floor_drain", "pipe", "column", "other"} else "other"


class PlanExtraction(BaseModel):
    overall_width_mm: int | None = Field(default=None, gt=0)
    overall_depth_mm: int | None = Field(default=None, gt=0)
    height_mm: int | None = Field(default=None, gt=0)
    boundary: list[Point2D] = Field(default_factory=list)
    edge_chain: list[BoundaryEdge] = Field(default_factory=list)
    openings: list[OpeningCandidate] = Field(default_factory=list)
    fixtures: list[FixtureCandidate] = Field(default_factory=list)
    evidence: list[EvidenceItem] = Field(default_factory=list)
    uncertain: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def discard_malformed_supporting_evidence(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        if isinstance(data.get("evidence"), list):
            data["evidence"] = [
                item for item in data["evidence"]
                if isinstance(item, (dict, EvidenceItem))
                and (isinstance(item, EvidenceItem) or bool(item.get("text")))
            ]
        uncertain = data.get("uncertain")
        if uncertain in (None, {}, ""):
            data["uncertain"] = []
        elif not isinstance(uncertain, list):
            data["uncertain"] = [str(uncertain)]
        return data


class PlanAnnotation(BaseModel):
    rotation_degrees: Literal[0, 90, 180, 270] = 0
    boundary: list[ShapeCorner] = Field(default_factory=list)
    edge_chain: list[BoundaryEdge] = Field(default_factory=list)
    confirmed: bool = False


class RoomSpec(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    name: str = "卫生间"
    boundary: list[Point2D] = Field(default_factory=list)
    height_mm: int | None = Field(default=None, gt=0)
    wall_thickness_mm: int = Field(default=100, gt=0)
    wall_profiles: list[WallProfile] = Field(default_factory=list)
    openings: list[OpeningSpec] = Field(default_factory=list)
    fixtures: list[FixtureSpec] = Field(default_factory=list)
    ceiling_zones: list[CeilingZone] = Field(default_factory=list)
    observations: list[Observation] = Field(default_factory=list)
    plan_annotation: PlanAnnotation | None = None
    issues: list[ValidationIssue] = Field(default_factory=list)
    confirmed: bool = False

    @model_validator(mode="after")
    def unique_ids(self) -> RoomSpec:
        ids = [item.id for item in [*self.openings, *self.fixtures, *self.ceiling_zones]]
        if len(ids) != len(set(ids)):
            raise ValueError("opening, fixture and ceiling zone ids must be unique")
        wall_indexes = [item.wall_index for item in self.wall_profiles]
        if len(wall_indexes) != len(set(wall_indexes)):
            raise ValueError("wall profile indexes must be unique")
        return self


class MeasurementCoordinateSystem(BaseModel):
    origin: Literal["boundary_min_x_min_z"] = "boundary_min_x_min_z"
    x_axis: Literal["right"] = "right"
    z_axis: Literal["down"] = "down"
    y_axis: Literal["up"] = "up"
    dimension_basis: Literal["finished_surface_clear"] = "finished_surface_clear"


class MeasurementRoom(BaseModel):
    name: str = "卫生间"
    length_mm: int = Field(gt=0)
    width_mm: int = Field(gt=0)


class MeasurementHeights(BaseModel):
    room_height_mm: int | None = Field(default=None, gt=0)
    wall_height_mm: int | None = Field(default=None, gt=0)
    net_height_mm: int | None = Field(default=None, gt=0)
    ground_elevation_mm: int = 0
    source: SourceKind = SourceKind.estimated
    confidence: float = Field(default=0.5, ge=0, le=1)
    status: Literal["verified", "unverified", "provisional"] = "unverified"
    evidence_ids: list[str] = Field(default_factory=list)


class MeasurementWall(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    index: int = Field(ge=0)
    start: Point2D
    end: Point2D
    thickness_mm: int = Field(default=100, gt=0)
    length_mm: int = Field(gt=0)
    source: SourceKind = SourceKind.derived
    confidence: float = Field(default=0.5, ge=0, le=1)
    status: Literal["verified", "unverified", "provisional"] = "unverified"
    evidence_ids: list[str] = Field(default_factory=list)


class MeasurementOpening(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    kind: Literal["door", "window", "opening"] = "door"
    wall_id: str = Field(min_length=1, max_length=80)
    offset_mm: int = Field(ge=0)
    width_mm: int = Field(gt=0)
    height_mm: int = Field(gt=0)
    thickness_mm: int | None = Field(default=None, gt=0)
    sill_mm: int = Field(default=0, ge=0)
    label: str = "门洞"
    swing_direction: Literal["left", "right", "inward", "outward", "unknown"] = "unknown"
    source: SourceKind = SourceKind.estimated
    confidence: float = Field(default=0.5, ge=0, le=1)
    status: Literal["verified", "unverified", "provisional"] = "unverified"
    evidence_ids: list[str] = Field(default_factory=list)


class MeasurementAnchor(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    kind: Literal[
        "toilet", "vanity", "shower", "floor_drain", "pipe", "column", "radiator", "other"
    ]
    label: str
    x_mm: int
    z_mm: int
    ground_elevation_mm: int = 0
    width_mm: int = Field(gt=0)
    depth_mm: int = Field(gt=0)
    height_mm: int = Field(gt=0)
    rotation_deg: int = 0
    source: SourceKind = SourceKind.estimated
    confidence: float = Field(default=0.5, ge=0, le=1)
    status: Literal["verified", "unverified", "provisional"] = "unverified"
    evidence_ids: list[str] = Field(default_factory=list)


class MeasurementEvidence(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    field: str
    raw_text: str
    normalized_value: str = ""
    unit: Literal["mm", "text"] = "text"
    source: SourceKind = SourceKind.estimated
    asset_id: str | None = None
    bbox: ImageBBox | None = None
    confidence: float = Field(default=0.5, ge=0, le=1)
    status: Literal["verified", "unverified", "provisional"] = "unverified"
    alternatives: list[str] = Field(default_factory=list)
    note: str = ""
    semantic_role: EvidenceRole = "other"
    review_required: bool = False
    rotation_degrees: Literal[0, 90, 180, 270] = 0
    target_id: str | None = None


class MeasurementModel(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    measurement_id: str = Field(min_length=1, max_length=100)
    revision: int = Field(default=1, ge=1)
    units: Literal["mm"] = "mm"
    coordinate_system: MeasurementCoordinateSystem = Field(default_factory=MeasurementCoordinateSystem)
    room: MeasurementRoom
    heights: MeasurementHeights = Field(default_factory=MeasurementHeights)
    walls: list[MeasurementWall] = Field(default_factory=list)
    openings: list[MeasurementOpening] = Field(default_factory=list)
    anchors: list[MeasurementAnchor] = Field(default_factory=list)
    evidence: list[MeasurementEvidence] = Field(default_factory=list)
    source_asset_ids: list[str] = Field(default_factory=list)
    unresolved_fields: list[str] = Field(default_factory=list)
    issues: list[ValidationIssue] = Field(default_factory=list)
    confirmed: bool = False

    @model_validator(mode="after")
    def stable_unique_ids(self) -> MeasurementModel:
        wall_ids = [wall.id for wall in self.walls]
        object_ids = [item.id for item in [*self.openings, *self.anchors]]
        evidence_ids = [item.id for item in self.evidence]
        if len(wall_ids) != len(set(wall_ids)) or len(object_ids) != len(set(object_ids)):
            raise ValueError("measurement wall and object ids must be unique")
        if len(evidence_ids) != len(set(evidence_ids)):
            raise ValueError("measurement evidence ids must be unique")
        return self


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class AssetResponse(BaseModel):
    id: str
    project_id: str
    role: Literal["floorplan", "photo"]
    filename: str
    mime_type: str
    width: int
    height: int
    created_at: str
    url: str


class ProjectResponse(BaseModel):
    id: str
    name: str
    status: str
    created_at: str
    updated_at: str
    spec: RoomSpec | None = None
    measurement: MeasurementModel | None = None
    assets: list[AssetResponse] = Field(default_factory=list)


class AnalysisResponse(BaseModel):
    spec: RoomSpec
    measurement: MeasurementModel
    sufficient: bool
    missing: list[str]


class ValidationResponse(BaseModel):
    issues: list[ValidationIssue]
    sufficient: bool
    missing: list[str]


class MeasurementValidationResponse(BaseModel):
    measurement: MeasurementModel
    spec: RoomSpec | None = None
    issues: list[ValidationIssue]
    sufficient: bool
    missing: list[str]
