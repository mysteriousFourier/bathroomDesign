from backend.app.models import FixtureSpec, OpeningSpec, Point2D, RoomSpec
from backend.app.validation import polygon_area, validate_spec


def rectangle() -> list[Point2D]:
    return [Point2D(x_mm=0, z_mm=0), Point2D(x_mm=2400, z_mm=0), Point2D(x_mm=2400, z_mm=1800), Point2D(x_mm=0, z_mm=1800)]


def test_valid_room_is_sufficient() -> None:
    spec = RoomSpec(boundary=rectangle(), height_mm=2600)
    issues, sufficient, missing = validate_spec(spec)
    assert issues == []
    assert sufficient is True
    assert missing == []
    assert polygon_area(spec.boundary) == 4_320_000


def test_missing_height_blocks_generation() -> None:
    issues, sufficient, missing = validate_spec(RoomSpec(boundary=rectangle()))
    assert sufficient is False
    assert "房间净高" in missing
    assert any(issue.code == "missing_height" for issue in issues)


def test_opening_outside_wall_is_error() -> None:
    spec = RoomSpec(
        boundary=rectangle(),
        height_mm=2600,
        openings=[OpeningSpec(id="door", wall_index=0, offset_mm=2000, width_mm=800, height_mm=2100)],
    )
    issues, sufficient, _ = validate_spec(spec)
    assert sufficient is False
    assert any(issue.code == "opening_outside" for issue in issues)


def test_diagonal_boundary_is_blocked_before_modeling() -> None:
    spec = RoomSpec(
        boundary=[
            Point2D(x_mm=0, z_mm=0), Point2D(x_mm=2400, z_mm=100),
            Point2D(x_mm=2400, z_mm=1800), Point2D(x_mm=0, z_mm=1800),
        ],
        height_mm=2600,
    )
    issues, sufficient, missing = validate_spec(spec)

    assert sufficient is False
    assert any(issue.code == "non_orthogonal_boundary" for issue in issues)
    assert "仅由水平和垂直非零线段组成的房间轮廓" in missing


def test_zero_length_and_collinear_overlap_are_rejected() -> None:
    points = rectangle()
    zero_length = RoomSpec(
        boundary=[*points[:2], points[1], *points[2:]],
        height_mm=2600,
    )
    overlap = RoomSpec(
        boundary=[
            Point2D(x_mm=0, z_mm=0), Point2D(x_mm=2400, z_mm=0),
            Point2D(x_mm=2400, z_mm=1800), Point2D(x_mm=0, z_mm=1800),
            Point2D(x_mm=0, z_mm=900), Point2D(x_mm=1200, z_mm=900),
            Point2D(x_mm=1200, z_mm=1800), Point2D(x_mm=0, z_mm=1800),
        ],
        height_mm=2600,
    )

    zero_issues, zero_sufficient, _ = validate_spec(zero_length)
    overlap_issues, overlap_sufficient, _ = validate_spec(overlap)

    assert zero_sufficient is False
    assert any(issue.code == "zero_length_boundary" for issue in zero_issues)
    assert overlap_sufficient is False
    assert any(issue.code == "self_intersection" for issue in overlap_issues)


def test_fixture_outside_is_warning_only() -> None:
    spec = RoomSpec(
        boundary=rectangle(),
        height_mm=2600,
        fixtures=[FixtureSpec(id="wc", kind="toilet", label="马桶", x_mm=3000, z_mm=900, width_mm=400, depth_mm=700, height_mm=780)],
    )
    issues, sufficient, _ = validate_spec(spec)
    assert sufficient is True
    assert any(issue.code == "fixture_outside" for issue in issues)


def test_fixture_collision_is_reported() -> None:
    spec = RoomSpec(
        boundary=rectangle(),
        height_mm=2600,
        fixtures=[
            FixtureSpec(id="wc", kind="toilet", label="马桶", x_mm=1000, z_mm=900, width_mm=400, depth_mm=700, height_mm=780),
            FixtureSpec(id="sink", kind="vanity", label="台盆", x_mm=1100, z_mm=950, width_mm=600, depth_mm=500, height_mm=850),
        ],
    )
    issues, sufficient, _ = validate_spec(spec)
    assert sufficient is True
    assert any(issue.code == "fixture_collision" for issue in issues)
