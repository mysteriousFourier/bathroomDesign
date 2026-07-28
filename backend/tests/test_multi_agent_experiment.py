from __future__ import annotations

from scripts.recognize_template_multi_agent import (
    deterministic_audit,
    normalize_coordinator_arithmetic,
)
from backend.app.models import ShapeCorner, TopologyCandidate


def test_program_recalculates_coordinator_arithmetic_and_rejects_large_residual() -> None:
    result = normalize_coordinator_arithmetic({
        "dimension_chains": [{
            "location": "top",
            "segments_mm": [260, 320, 1640, 615, 1590],
            "overall_mm": 4105,
            "segment_sum_mm": 4325,
            "overall_residual_mm": -220,
            "accepted": True,
        }],
    })

    assert result["dimension_chains"][0]["segment_sum_mm"] == 4425
    assert result["dimension_chains"][0]["overall_residual_mm"] == -320
    assert result["dimension_chains"][0]["accepted"] is False


def test_deterministic_audit_requires_known_topology_and_exact_sample_fields() -> None:
    candidates = [TopologyCandidate(
        id="C3",
        corners=[ShapeCorner(x=index * 10, y=index * 10) for index in range(14)],
    )]
    facts = {
        "dimension_chains": [
            {"location": "top", "segments_mm": [260, 1640, 615, 1590], "overall_mm": 4105},
            {"location": "bottom", "segments_mm": [400, 800, 55, 2855], "overall_mm": 4110},
        ],
        "openings": [{"id": "D1", "CG": 0, "CK": 800, "CH": 2055}],
    }
    visual_audit = {"overall_ceiling_height_mm": 2100}
    layout = {"points": [
        {"kind": "floor_drain"}, {"kind": "floor_drain"},
        {"kind": "drain"}, {"kind": "drain"},
    ]}
    coordinated = normalize_coordinator_arithmetic({
        "selected_topology_id": "C3",
        "dimension_chains": [
            {"location": "top", "segments_mm": [260, 1640, 615, 1590], "overall_mm": 4105},
            {"location": "bottom", "segments_mm": [400, 800, 55, 2855], "overall_mm": 4110},
        ],
        "openings": facts["openings"],
        "overall_ceiling_height_mm": 2100,
        "points": layout["points"],
    })

    result = deterministic_audit(facts, layout, visual_audit, coordinated, candidates)

    assert result["passed"] is True
    assert result["checks"]["horizontal_chains_close"] is True
    assert result["invented_values"] == []
