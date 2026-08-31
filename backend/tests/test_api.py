from io import BytesIO
from pathlib import Path
from uuid import UUID

import httpx
import pytest
from PIL import Image

from backend.app.database import db
from backend.app.config import PROJECT_ROOT, settings
from backend.app import main as main_module
from backend.app.ai import AIResponseError
from backend.app.main import app
from backend.app.models import BoundaryEdge, ImageBBox, Observation, PlanAnnotation, Point2D, RoomSpec, ShapeCorner


def configure_temp_database(tmp_path) -> None:
    db.data_dir = tmp_path
    db.db_path = tmp_path / "studio.sqlite3"
    db.asset_dir = tmp_path / "projects"


@pytest.mark.asyncio
async def test_frontend_and_template_routes_do_not_depend_on_working_directory(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        homepage = await client.get("/")
        template = await client.get("/measurement-template.html")
        model_manifest = await client.get("/model-library/manifest.json")

    assert homepage.status_code == 200
    assert '<div id="root"></div>' in homepage.text
    assert homepage.headers["cache-control"] == "no-store, no-cache, must-revalidate"
    assert template.status_code == 200
    assert "单房间量房记录" in template.text
    assert model_manifest.status_code == 200
    assert model_manifest.json()["assets"]
    assert PROJECT_ROOT == Path(__file__).resolve().parents[2]
    assert settings.app_data_dir.is_absolute()


@pytest.mark.asyncio
async def test_measurement_file_inspection_and_svg_import_updates_project(tmp_path) -> None:
    configure_temp_database(tmp_path)
    db.initialize()
    svg = b'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3600 2400">
      <path id="room-boundary" d="M0 0H3600V2400H0Z"/>
      <circle id="floor-drain" cx="2800" cy="1700" r="50"/>
    </svg>'''
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project = (await client.post("/api/projects", json={"name": "SVG 导入"})).json()
        inspection = await client.post(
            f"/api/projects/{project['id']}/measurement/import/inspect",
            files={"file": ("room.svg", svg, "image/svg+xml")},
        )
        unchanged = await client.get(f"/api/projects/{project['id']}")

        assert inspection.status_code == 200
        assert inspection.json()["format"] == "svg"
        assert inspection.json()["can_import"] is True
        assert unchanged.json()["measurement"] is None

        imported = await client.post(
            f"/api/projects/{project['id']}/measurement/import",
            data={"unit": "mm", "height_mm": "2750"},
            files={"file": ("room.svg", svg, "image/svg+xml")},
        )

    assert imported.status_code == 200, imported.text
    result = imported.json()
    assert result["project"]["status"] == "review"
    assert result["project"]["spec"]["height_mm"] == 2750
    assert result["project"]["spec"]["boundary"][2] == {"x_mm": 3600, "z_mm": 2400}
    assert result["project"]["spec"]["fixtures"][0]["kind"] == "floor_drain"
    assert result["project"]["measurement"]["anchors"][0]["x_mm"] == 2800


@pytest.mark.asyncio
async def test_project_upload_and_save_flow(tmp_path, monkeypatch) -> None:
    configure_temp_database(tmp_path)
    monkeypatch.setattr(settings, "openai_base_url", "")
    monkeypatch.setattr(settings, "openai_api_key", "")
    monkeypatch.setattr(settings, "read_model", "")

    async def editable_analysis(*_args, **_kwargs):
        return RoomSpec(
            name="待校正卫生间",
            boundary=[
                Point2D(x_mm=0, z_mm=0), Point2D(x_mm=3000, z_mm=0),
                Point2D(x_mm=3000, z_mm=2000), Point2D(x_mm=0, z_mm=2000),
            ],
            height_mm=2100,
            plan_annotation=PlanAnnotation(
                rotation_degrees=270,
                boundary=[
                    ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
                    ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
                ],
                confirmed=False,
            ),
            warnings=["未可靠识别完整总长宽，请在图片或属性面板中补录"],
        )

    monkeypatch.setattr(main_module, "analyze_floorplan", editable_analysis)
    db.initialize()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        health = await client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["ok"] is True
        assert health.json()["service_id"] == "bathroom-spatial-studio"
        assert health.json()["source_version"] > 0
        assert health.json()["config_version"]
        assert "chat_model" in health.json()

        created = await client.post("/api/projects", json={"name": "测试卫生间"})
        assert created.status_code == 201
        project_id = created.json()["id"]

        image_data = BytesIO()
        Image.new("RGB", (320, 240), "white").save(image_data, "JPEG")
        uploaded = await client.post(
            f"/api/projects/{project_id}/assets",
            data={"role": "floorplan"},
            files={"file": ("plan.jpg", image_data.getvalue(), "image/jpeg")},
        )
        assert uploaded.status_code == 201
        asset = uploaded.json()
        assert asset["width"] == 320
        content = await client.get(asset["url"])
        assert content.status_code == 200
        assert content.headers["content-type"].startswith("image/jpeg")

        analyzed = await client.post(f"/api/projects/{project_id}/analyze-plan")
        assert analyzed.status_code == 200
        assert analyzed.json()["sufficient"] is True
        assert len(analyzed.json()["spec"]["boundary"]) == 4
        assert analyzed.json()["spec"]["plan_annotation"]["rotation_degrees"] == 270
        assert len(analyzed.json()["spec"]["plan_annotation"]["boundary"]) == 4

        spec = {
            "schema_version": "1.0",
            "name": "测试卫生间",
            "boundary": [{"x_mm": 0, "z_mm": 0}, {"x_mm": 1800, "z_mm": 0}, {"x_mm": 1800, "z_mm": 2400}, {"x_mm": 0, "z_mm": 2400}],
            "height_mm": 2600,
            "wall_thickness_mm": 100,
            "strip_existing_finish": True,
            "finish_surface_offset_mm": 20,
            "wall_finish_thickness_mm": 25,
            "openings": [],
            "fixtures": [{
                "id": "drain-1", "kind": "drain", "label": "排水点", "x_mm": 900, "z_mm": 600,
                "width_mm": 60, "depth_mm": 60, "height_mm": 10, "rotation_deg": 0,
                "source": "user", "confidence": 1, "bound_wall_index": 0,
            }],
            "dry_wet_zones": [{
                "id": "wet-1", "kind": "wet", "label": "湿区", "source": "derived", "confidence": 0.9,
                "boundary": [{"x_mm": 0, "z_mm": 0}, {"x_mm": 900, "z_mm": 0}, {"x_mm": 900, "z_mm": 1200}, {"x_mm": 0, "z_mm": 1200}],
            }],
            "wall_finish_profiles": [{
                "wall_index": 0, "thickness_mm": 50, "source": "derived", "confidence": 0.92,
                "generated_from_bound_point": True,
            }],
            "observations": [], "issues": [], "confirmed": True,
        }
        saved = await client.put(f"/api/projects/{project_id}/spec", json=spec)
        assert saved.status_code == 200
        assert saved.json()["status"] == "model"
        assert saved.json()["spec"]["fixtures"][0]["bound_wall_index"] == 0
        assert saved.json()["spec"]["strip_existing_finish"] is True
        assert saved.json()["spec"]["finish_surface_offset_mm"] == 20
        assert saved.json()["spec"]["wall_finish_thickness_mm"] == 25
        assert saved.json()["spec"]["dry_wet_zones"][0]["kind"] == "wet"
        assert saved.json()["spec"]["wall_finish_profiles"][0]["thickness_mm"] == 50
        measurement = saved.json()["measurement"]
        assert measurement["units"] == "mm"
        assert measurement["measurement_id"] == project_id
        assert measurement["surface_treatment"] == {
            "strip_existing_finish": True,
            "existing_finish_thickness_mm": 20,
            "new_finish_thickness_mm": 25,
            "wall_finish_profiles": saved.json()["spec"]["wall_finish_profiles"],
        }
        assert len(measurement["walls"]) == 4

        validated = await client.post("/api/measurements/validate", json=measurement)
        assert validated.status_code == 200
        assert validated.json()["sufficient"] is True
        assert validated.json()["spec"]["boundary"] == spec["boundary"]
        assert validated.json()["spec"]["strip_existing_finish"] is True
        assert validated.json()["spec"]["finish_surface_offset_mm"] == 20
        assert validated.json()["spec"]["wall_finish_thickness_mm"] == 25
        assert validated.json()["spec"]["wall_finish_profiles"][0]["thickness_mm"] == 50

        downloaded = await client.get(f"/api/projects/{project_id}/measurement/download")
        assert downloaded.status_code == 200
        assert downloaded.headers["content-disposition"] == 'attachment; filename="measurement.json"'
        contract_measurement = downloaded.json()
        assert set(contract_measurement) == {
            "schemaVersion", "roomId", "boundary", "walls", "openings",
            "drainagePoints", "pipeEnclosures", "waterSupplyPoints", "measurementPoints", "heights",
        }
        assert contract_measurement["schemaVersion"] == "1.1.0"
        assert contract_measurement["roomId"] == str(UUID(project_id))
        assert contract_measurement["heights"]["roomHeight"] == 2600
        assert contract_measurement["walls"][0]["startPoint"] == {"x": 0, "y": 0}
        assert "measurement_id" not in contract_measurement
        assert "schema_version" not in contract_measurement
        exported_validation = await client.post("/api/measurements/validate", json=contract_measurement)
        assert exported_validation.status_code == 422

        measurement["room"]["name"] = "从量房文件重建"
        measurement["confirmed"] = False
        imported = await client.put(f"/api/projects/{project_id}/measurement", json=measurement)
        assert imported.status_code == 200
        assert imported.json()["status"] == "review"
        assert imported.json()["spec"]["name"] == "从量房文件重建"
        assert imported.json()["measurement"]["revision"] == 2


@pytest.mark.asyncio
async def test_uploading_new_floorplan_preserves_previous_spec_and_measurement(tmp_path) -> None:
    configure_temp_database(tmp_path)
    db.initialize()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project_id = (await client.post("/api/projects", json={"name": "replace plan"})).json()["id"]
        spec = RoomSpec(
            boundary=[
                Point2D(x_mm=0, z_mm=0), Point2D(x_mm=1800, z_mm=0),
                Point2D(x_mm=1800, z_mm=2400), Point2D(x_mm=0, z_mm=2400),
            ],
            height_mm=2600,
            confirmed=True,
        )
        await client.put(f"/api/projects/{project_id}/spec", json=spec.model_dump(mode="json"))
        image_data = BytesIO()
        Image.new("RGB", (640, 480), "white").save(image_data, "JPEG")

        uploaded = await client.post(
            f"/api/projects/{project_id}/assets",
            data={"role": "floorplan"},
            files={"file": ("replacement.jpg", image_data.getvalue(), "image/jpeg")},
        )
        refreshed = await client.get(f"/api/projects/{project_id}")

    assert uploaded.status_code == 201
    assert refreshed.json()["status"] == "model"
    assert refreshed.json()["spec"]["height_mm"] == 2600
    assert refreshed.json()["measurement"]["heights"]["room_height_mm"] == 2600


@pytest.mark.asyncio
async def test_incomplete_pixel_annotation_saves_without_measurement(tmp_path) -> None:
    configure_temp_database(tmp_path)
    db.initialize()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        created = await client.post("/api/projects", json={"name": "逐段尺寸待补"})
        project_id = created.json()["id"]
        spec = RoomSpec(
            boundary=[],
            plan_annotation=PlanAnnotation(
                boundary=[
                    ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
                    ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
                ],
                edge_chain=[
                    {"direction": "right", "length_mm": None},
                    {"direction": "down", "length_mm": None},
                    {"direction": "left", "length_mm": None},
                    {"direction": "up", "length_mm": None},
                ],
                confirmed=False,
            ),
        )

        saved = await client.put(f"/api/projects/{project_id}/spec", json=spec.model_dump(mode="json"))

        assert saved.status_code == 200
        assert saved.json()["measurement"] is None
        assert saved.json()["spec"]["boundary"] == []
        assert len(saved.json()["spec"]["plan_annotation"]["edge_chain"]) == 4


@pytest.mark.asyncio
async def test_incomplete_plan_analysis_returns_null_measurement(tmp_path, monkeypatch) -> None:
    configure_temp_database(tmp_path)

    async def incomplete_analysis(*_args, **_kwargs):
        return RoomSpec(
            boundary=[],
            plan_annotation=PlanAnnotation(
                boundary=[
                    ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
                    ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
                ],
                edge_chain=[
                    {"direction": "right", "length_mm": None},
                    {"direction": "down", "length_mm": None},
                    {"direction": "left", "length_mm": None},
                    {"direction": "up", "length_mm": None},
                ],
                confirmed=False,
            ),
        )

    monkeypatch.setattr(main_module, "analyze_floorplan", incomplete_analysis)
    db.initialize()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project_id = (await client.post("/api/projects", json={"name": "识别尺寸待补"})).json()["id"]
        image_data = BytesIO()
        Image.new("RGB", (320, 240), "white").save(image_data, "JPEG")
        await client.post(
            f"/api/projects/{project_id}/assets",
            data={"role": "floorplan"},
            files={"file": ("plan.jpg", image_data.getvalue(), "image/jpeg")},
        )

        analyzed = await client.post(f"/api/projects/{project_id}/analyze-plan")

        assert analyzed.status_code == 200
        assert analyzed.json()["measurement"] is None
        assert analyzed.json()["spec"]["boundary"] == []
        assert analyzed.json()["sufficient"] is False


@pytest.mark.asyncio
async def test_closed_segment_annotation_saves_measurement(tmp_path) -> None:
    configure_temp_database(tmp_path)
    db.initialize()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        created = await client.post("/api/projects", json={"name": "逐段尺寸已闭合"})
        project_id = created.json()["id"]
        spec = RoomSpec(
            boundary=[
                Point2D(x_mm=0, z_mm=0), Point2D(x_mm=2400, z_mm=0),
                Point2D(x_mm=2400, z_mm=1600), Point2D(x_mm=0, z_mm=1600),
            ],
            plan_annotation=PlanAnnotation(
                boundary=[
                    ShapeCorner(x=100, y=100), ShapeCorner(x=900, y=100),
                    ShapeCorner(x=900, y=900), ShapeCorner(x=100, y=900),
                ],
                edge_chain=[
                    {"direction": "right", "length_mm": 2400},
                    {"direction": "down", "length_mm": 1600},
                    {"direction": "left", "length_mm": 2400},
                    {"direction": "up", "length_mm": 1600},
                ],
                confirmed=True,
            ),
            confirmed=True,
        )

        saved = await client.put(f"/api/projects/{project_id}/spec", json=spec.model_dump(mode="json"))

        assert saved.status_code == 200
        assert len(saved.json()["measurement"]["walls"]) == 4
        assert saved.json()["spec"]["plan_annotation"]["confirmed"] is True
        assert saved.json()["spec"]["plan_annotation"]["edge_chain"][0]["length_mm"] == 2400


@pytest.mark.asyncio
async def test_rejects_non_image_upload(tmp_path) -> None:
    configure_temp_database(tmp_path)
    db.initialize()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project_id = (await client.post("/api/projects", json={"name": "错误文件测试"})).json()["id"]
        response = await client.post(
            f"/api/projects/{project_id}/assets",
            data={"role": "photo"},
            files={"file": ("notes.txt", b"not an image", "text/plain")},
        )
        assert response.status_code == 415


@pytest.mark.asyncio
async def test_new_floorplan_and_site_photo_both_preserve_old_geometry(tmp_path) -> None:
    configure_temp_database(tmp_path)
    db.initialize()
    image_data = BytesIO()
    Image.new("RGB", (320, 240), "white").save(image_data, "JPEG")
    payload = image_data.getvalue()
    spec = RoomSpec(
        boundary=[
            Point2D(x_mm=0, z_mm=0), Point2D(x_mm=2400, z_mm=0),
            Point2D(x_mm=2400, z_mm=1600), Point2D(x_mm=0, z_mm=1600),
        ],
        height_mm=2600,
    ).model_dump(mode="json")

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project_id = (await client.post("/api/projects", json={"name": "底图隔离"})).json()["id"]
        assert (await client.put(f"/api/projects/{project_id}/spec", json=spec)).status_code == 200

        floorplan = await client.post(
            f"/api/projects/{project_id}/assets", data={"role": "floorplan"},
            files={"file": ("new-plan.jpg", payload, "image/jpeg")},
        )
        assert floorplan.status_code == 201
        refreshed = (await client.get(f"/api/projects/{project_id}")).json()
        assert refreshed["spec"] is not None
        assert refreshed["measurement"] is not None
        assert refreshed["status"] == "review"

        assert (await client.put(f"/api/projects/{project_id}/spec", json=spec)).status_code == 200
        photo = await client.post(
            f"/api/projects/{project_id}/assets", data={"role": "photo"},
            files={"file": ("site.jpg", payload, "image/jpeg")},
        )
        assert photo.status_code == 201
        retained = (await client.get(f"/api/projects/{project_id}")).json()
        assert retained["spec"] is not None
        assert retained["measurement"] is not None
        assert retained["status"] == "review"


@pytest.mark.asyncio
async def test_reanalysis_reuses_rotation_only_for_same_floorplan(tmp_path, monkeypatch) -> None:
    configure_temp_database(tmp_path)
    db.initialize()
    requested_rotations: list[int | None] = []

    async def capture_rotation(*_args, **kwargs):
        requested_rotations.append(kwargs.get("rotation_degrees"))
        return RoomSpec(
            boundary=[
                Point2D(x_mm=0, z_mm=0), Point2D(x_mm=1800, z_mm=0),
                Point2D(x_mm=1800, z_mm=2400), Point2D(x_mm=0, z_mm=2400),
            ],
            height_mm=2600,
        )

    monkeypatch.setattr(main_module, "analyze_floorplan", capture_rotation)
    image_data = BytesIO()
    Image.new("RGB", (200, 320), "white").save(image_data, "JPEG")
    payload = image_data.getvalue()

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project_id = (await client.post("/api/projects", json={"name": "旋转继承"})).json()["id"]
        first_asset = (await client.post(
            f"/api/projects/{project_id}/assets",
            data={"role": "floorplan"},
            files={"file": ("first.jpg", payload, "image/jpeg")},
        )).json()
        saved_spec = RoomSpec(
            boundary=[
                Point2D(x_mm=0, z_mm=0), Point2D(x_mm=1800, z_mm=0),
                Point2D(x_mm=1800, z_mm=2400), Point2D(x_mm=0, z_mm=2400),
            ],
            height_mm=2600,
            plan_annotation=PlanAnnotation(rotation_degrees=270, boundary=[], confirmed=False),
            observations=[Observation(
                field="ocr:E1", value="1800", asset_id=first_asset["id"], rotation_degrees=270,
            )],
        )
        await client.put(f"/api/projects/{project_id}/spec", json=saved_spec.model_dump(mode="json"))

        same_plan = await client.post(f"/api/projects/{project_id}/analyze-plan")
        explicit_angle = await client.post(f"/api/projects/{project_id}/analyze-plan?rotation_degrees=90")
        await client.post(
            f"/api/projects/{project_id}/assets",
            data={"role": "floorplan"},
            files={"file": ("second.jpg", payload, "image/jpeg")},
        )
        new_plan = await client.post(f"/api/projects/{project_id}/analyze-plan")

    assert same_plan.status_code == 200
    assert explicit_angle.status_code == 200
    assert new_plan.status_code == 200
    assert requested_rotations == [270, 90, None]


@pytest.mark.asyncio
async def test_reanalysis_rejects_a_regressed_misaligned_draft(tmp_path, monkeypatch) -> None:
    configure_temp_database(tmp_path)
    db.initialize()
    image_data = BytesIO()
    Image.new("RGB", (200, 320), "white").save(image_data, "JPEG")

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project_id = (await client.post("/api/projects", json={"name": "拒绝错位回退"})).json()["id"]
        asset = (await client.post(
            f"/api/projects/{project_id}/assets",
            data={"role": "floorplan"},
            files={"file": ("plan.jpg", image_data.getvalue(), "image/jpeg")},
        )).json()
        edges = [
            BoundaryEdge(direction=direction, length_mm=length, role="wall", confidence=0.9)
            for direction, length in (("right", 1800), ("down", 2400), ("left", 1800), ("up", 2400))
        ]
        saved_spec = RoomSpec(
            boundary=[
                Point2D(x_mm=0, z_mm=0), Point2D(x_mm=1800, z_mm=0),
                Point2D(x_mm=1800, z_mm=2400), Point2D(x_mm=0, z_mm=2400),
            ],
            height_mm=2600,
            plan_annotation=PlanAnnotation(
                rotation_degrees=270,
                boundary=[
                    ShapeCorner(x=250, y=200), ShapeCorner(x=750, y=200),
                    ShapeCorner(x=750, y=800), ShapeCorner(x=250, y=800),
                ],
                edge_chain=edges,
                confirmed=False,
            ),
            observations=[Observation(
                field="ocr:E1", value="1800", asset_id=asset["id"], rotation_degrees=270,
                bbox=ImageBBox(x_min=300, y_min=100, x_max=400, y_max=150),
            )],
        )
        await client.put(f"/api/projects/{project_id}/spec", json=saved_spec.model_dump(mode="json"))

        async def misaligned_analysis(*_args, **_kwargs):
            return RoomSpec(
                boundary=saved_spec.boundary,
                height_mm=2600,
                plan_annotation=PlanAnnotation(
                    rotation_degrees=270,
                    boundary=[
                        ShapeCorner(x=20, y=20), ShapeCorner(x=980, y=20),
                        ShapeCorner(x=980, y=980), ShapeCorner(x=20, y=980),
                    ],
                    edge_chain=edges,
                    confirmed=False,
                ),
                observations=[Observation(
                    field="ocr:E2", value="1800", asset_id=asset["id"], rotation_degrees=270,
                    bbox=ImageBBox(x_min=300, y_min=100, x_max=400, y_max=150),
                )],
            )

        monkeypatch.setattr(main_module, "analyze_floorplan", misaligned_analysis)
        response = await client.post(f"/api/projects/{project_id}/analyze-plan")
        persisted = (await client.get(f"/api/projects/{project_id}")).json()

    assert response.status_code == 502
    assert "新轮廓与已保存房型明显错位" in response.json()["detail"]
    assert persisted["spec"]["plan_annotation"]["boundary"][0] == {"x": 250, "y": 200, "role": "wall_corner", "confidence": 0.5}


@pytest.mark.asyncio
async def test_failed_reanalysis_restores_status_and_preserves_old_result(tmp_path, monkeypatch) -> None:
    configure_temp_database(tmp_path)
    db.initialize()
    statuses_during_analysis: list[str] = []

    async def fail_analysis(*_args, **_kwargs):
        statuses_during_analysis.append(db.get_project(project_id).status)
        raise AIResponseError("轮廓未闭合")

    monkeypatch.setattr(main_module, "analyze_floorplan", fail_analysis)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project_id = (await client.post("/api/projects", json={"name": "保留旧数据"})).json()["id"]
        image_data = BytesIO()
        Image.new("RGB", (320, 240), "white").save(image_data, "JPEG")
        await client.post(
            f"/api/projects/{project_id}/assets", data={"role": "floorplan"},
            files={"file": ("plan.jpg", image_data.getvalue(), "image/jpeg")},
        )
        old_spec = {
            "boundary": [{"x_mm": 0, "z_mm": 0}, {"x_mm": 1800, "z_mm": 0}, {"x_mm": 1800, "z_mm": 2400}],
            "height_mm": 2600,
        }
        await client.put(f"/api/projects/{project_id}/spec", json=old_spec)

        failed = await client.post(f"/api/projects/{project_id}/analyze-plan?rotation_degrees=0")
        assert failed.status_code >= 400
        assert statuses_during_analysis == ["analysis_running"]
        project = (await client.get(f"/api/projects/{project_id}")).json()
        assert project["status"] == "review"
        assert project["spec"]["height_mm"] == 2600
        assert project["measurement"]["heights"]["room_height_mm"] == 2600
        assert len(project["measurement"]["walls"]) == 3


@pytest.mark.asyncio
async def test_successful_reanalysis_returns_draft_without_overwriting_old_result(tmp_path, monkeypatch) -> None:
    configure_temp_database(tmp_path)
    db.initialize()

    async def replacement_analysis(*_args, **_kwargs):
        return RoomSpec(
            name="新一轮草稿",
            boundary=[
                Point2D(x_mm=0, z_mm=0), Point2D(x_mm=3000, z_mm=0),
                Point2D(x_mm=3000, z_mm=2000), Point2D(x_mm=0, z_mm=2000),
            ],
            height_mm=2800,
        )

    monkeypatch.setattr(main_module, "analyze_floorplan", replacement_analysis)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project_id = (await client.post("/api/projects", json={"name": "生成草稿隔离"})).json()["id"]
        old_spec = RoomSpec(
            name="上一轮结果",
            boundary=[
                Point2D(x_mm=0, z_mm=0), Point2D(x_mm=1800, z_mm=0),
                Point2D(x_mm=1800, z_mm=2400), Point2D(x_mm=0, z_mm=2400),
            ],
            height_mm=2600,
        )
        await client.put(f"/api/projects/{project_id}/spec", json=old_spec.model_dump(mode="json"))
        image_data = BytesIO()
        Image.new("RGB", (320, 240), "white").save(image_data, "JPEG")
        await client.post(
            f"/api/projects/{project_id}/assets", data={"role": "floorplan"},
            files={"file": ("new-plan.jpg", image_data.getvalue(), "image/jpeg")},
        )

        analyzed = await client.post(f"/api/projects/{project_id}/analyze-plan")
        persisted = (await client.get(f"/api/projects/{project_id}")).json()

    assert analyzed.status_code == 200
    assert analyzed.json()["spec"]["name"] == "新一轮草稿"
    assert analyzed.json()["measurement"]["heights"]["room_height_mm"] == 2800
    assert persisted["status"] == "review"
    assert persisted["spec"]["name"] == "上一轮结果"
    assert persisted["measurement"]["heights"]["room_height_mm"] == 2600


@pytest.mark.asyncio
async def test_project_cannot_be_deleted_during_analysis(tmp_path) -> None:
    configure_temp_database(tmp_path)
    db.initialize()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project_id = (await client.post("/api/projects", json={"name": "识别中项目"})).json()["id"]
        db.set_status(project_id, "analysis_running")

        response = await client.delete(f"/api/projects/{project_id}")

        assert response.status_code == 409
        assert "正在识别" in response.json()["detail"]
        assert (await client.get(f"/api/projects/{project_id}")).status_code == 200


@pytest.mark.asyncio
async def test_project_chat_sessions_persist_messages_quotes_and_history(tmp_path, monkeypatch) -> None:
    configure_temp_database(tmp_path)
    db.initialize()

    async def fake_design_chat(messages, _graph, _room=None):
        assert messages[-1] == {"role": "user", "content": "成人淋浴，喜欢素雅，预算2万元"}
        return {
            "message": "需求已完整，结构化报价已生成。",
            "requirements": {"collected": {"使用人群": ["成人"]}, "missing_fields": [], "complete": True},
            "style_match": {"user_terms": ["素雅"], "catalog_style": "素雅", "confidence": 1, "status": "matched", "candidates": [], "resolver_version": "test"},
            "surfaces": {"source": "test", "floor_area_sqm": 6, "ceiling_area_sqm": 6, "wall_gross_area_sqm": 20, "opening_area_sqm": 0, "wall_net_area_sqm": 20, "waste_rate": .1, "floor_purchase_sqm": 6.6, "ceiling_purchase_sqm": 6.6, "wall_purchase_sqm": 22, "floor_layout": "", "ceiling_layout": "", "wall_layout": "", "warnings": []},
            "material_quotes": [{"product_id": "wall", "材料编号": "QB1", "材料名称": "墙板", "单价": 80, "单位": "平米", "采购量": 22, "材料小计": 1760, "来源": "test"}],
            "furniture_candidates": [], "furniture_quotes": [{"product_id": "toilet", "材料编号": "MT1", "家具名称": "马桶", "单价": 1200, "单位": "件", "数量": 1, "家具小计": 1200, "来源": "test"}], "selected_furniture": [],
            "material_total": 1760, "furniture_price_range": {"min": 1200, "max": 1200}, "total_price_range": {"min": 2960, "max": 2960}, "furniture_total": 1200, "quote_total": 2960, "pricing_status": "final", "equipment": {}, "products": [],
        }

    monkeypatch.setattr(main_module, "design_chat", fake_design_chat)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        first_project = (await client.post("/api/projects", json={"name": "会话房型 A"})).json()["id"]
        second_project = (await client.post("/api/projects", json={"name": "会话房型 B"})).json()["id"]
        created = await client.post(f"/api/projects/{first_project}/chat-sessions", json={"title": "新对话"})
        assert created.status_code == 201
        session_id = created.json()["id"]
        sent = await client.post(
            f"/api/projects/{first_project}/chat-sessions/{session_id}/messages",
            json={"content": "成人淋浴，喜欢素雅，预算2万元"},
        )
        assert sent.status_code == 200, sent.text
        assert sent.json()["title"] == "成人淋浴，喜欢素雅，预算2万元"
        assert sent.json()["messages"][-1]["quote"]["quote_total"] == 2960

        history = (await client.get(f"/api/projects/{first_project}/chat-sessions")).json()
        assert history[0]["id"] == session_id and history[0]["message_count"] == 3
        reloaded = (await client.get(f"/api/projects/{first_project}/chat-sessions/{session_id}")).json()
        assert [message["role"] for message in reloaded["messages"]] == ["assistant", "user", "assistant"]
        assert (await client.get(f"/api/projects/{second_project}/chat-sessions")).json() == []
        assert (await client.get(f"/api/projects/{second_project}/chat-sessions/{session_id}")).status_code == 404

        deleted = await client.delete(f"/api/projects/{first_project}/chat-sessions/{session_id}")
        assert deleted.status_code == 204
        assert (await client.get(f"/api/projects/{first_project}/chat-sessions")).json() == []
        assert (await client.get(f"/api/projects/{first_project}/chat-sessions/{session_id}")).status_code == 404
        assert (await client.delete(f"/api/projects/{first_project}/chat-sessions/{session_id}")).status_code == 404
        with db.connect() as connection:
            assert connection.execute("SELECT COUNT(*) FROM chat_messages WHERE session_id = ?", (session_id,)).fetchone()[0] == 0


@pytest.mark.asyncio
async def test_model_folder_upload_list_read_and_delete(tmp_path) -> None:
    configure_temp_database(tmp_path)
    db.initialize()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project_id = (await client.post("/api/projects", json={"name": "模型文件夹"})).json()["id"]
        second_project_id = (await client.post("/api/projects", json={"name": "复用模型的项目"})).json()["id"]
        uploaded = await client.post(
            f"/api/projects/{project_id}/model-assets",
            data={"relative_paths": ["basin/model.gltf", "basin/model.bin", "basin/textures/albedo.png"]},
            files=[
                ("files", ("model.gltf", b'{"asset":{"version":"2.0"}}', "model/gltf+json")),
                ("files", ("model.bin", b"binary-mesh", "application/octet-stream")),
                ("files", ("albedo.png", b"texture", "image/png")),
            ],
        )

        assert uploaded.status_code == 201
        asset = uploaded.json()
        assert asset["format"] == "gltf"
        assert asset["file_count"] == 3
        assert asset["sha256"] == "f74cabc3532658af0aa3e7abdd6939d22aa5cd78849dc06e3817248fe1c3788d"
        assert asset["library_scope"] == "shared"
        assert asset["src"].startswith("/api/model-assets/")

        duplicate = await client.post(
            f"/api/projects/{second_project_id}/model-assets",
            data={"relative_paths": ["basin/model.gltf", "basin/model.bin", "basin/textures/albedo.png"]},
            files=[
                ("files", ("model.gltf", b'{"asset":{"version":"2.0"}}', "model/gltf+json")),
                ("files", ("model.bin", b"different-dependency-is-not-a-second-model", "application/octet-stream")),
                ("files", ("albedo.png", b"different-texture", "image/png")),
            ],
        )
        assert duplicate.status_code == 201
        assert duplicate.json()["id"] == asset["id"]
        assert duplicate.json()["deduplicated"] is True

        listed = await client.get(f"/api/projects/{project_id}/model-assets")
        assert listed.status_code == 200
        shared_assets = [item for item in listed.json() if item["library_scope"] == "shared"]
        assert [item["id"] for item in shared_assets] == [asset["id"]]
        assert any(item["library_scope"] == "builtin" for item in listed.json())
        second_project_assets = (await client.get(f"/api/projects/{second_project_id}/model-assets")).json()
        assert [item["id"] for item in second_project_assets if item["library_scope"] == "shared"] == [asset["id"]]

        corrected = await client.put(
            f"/api/projects/{project_id}/model-assets/{asset['id']}/orientation",
            json={"view": "left"},
        )
        assert corrected.status_code == 200
        assert corrected.json()["orientation_view"] == "left"
        assert corrected.json()["orientation_corrected"] is True
        assert corrected.json()["orientation_source"] == "manual"
        reloaded = next(item for item in (await client.get(f"/api/projects/{project_id}/model-assets")).json() if item["id"] == asset["id"])
        assert reloaded["orientation_view"] == "left"

        model_file = await client.get(asset["src"])
        assert model_file.status_code == 200
        assert model_file.content == b'{"asset":{"version":"2.0"}}'
        assert model_file.headers["content-type"].startswith("model/gltf+json")

        deleted = await client.delete(f"/api/projects/{project_id}/model-assets/{asset['id']}")
        assert deleted.status_code == 204
        assert (await client.get(asset["src"])).status_code == 404


@pytest.mark.asyncio
async def test_model_upload_rejects_unsafe_paths_and_multiple_primary_files(tmp_path) -> None:
    configure_temp_database(tmp_path)
    db.initialize()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project_id = (await client.post("/api/projects", json={"name": "模型校验"})).json()["id"]
        unsafe = await client.post(
            f"/api/projects/{project_id}/model-assets",
            data={"relative_paths": "../model.glb"},
            files={"files": ("model.glb", b"glTF", "model/gltf-binary")},
        )
        assert unsafe.status_code == 422
        assert "路径不安全" in unsafe.json()["detail"]

        multiple = await client.post(
            f"/api/projects/{project_id}/model-assets",
            data={"relative_paths": ["a.glb", "b.obj"]},
            files=[
                ("files", ("a.glb", b"glTF", "model/gltf-binary")),
                ("files", ("b.obj", b"o mesh", "text/plain")),
            ],
        )
        assert multiple.status_code == 422
        assert "一个主模型" in multiple.json()["detail"]


@pytest.mark.asyncio
async def test_shared_model_requires_exact_product_binding_for_layout(tmp_path) -> None:
    configure_temp_database(tmp_path)
    db.initialize()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project_id = (await client.post("/api/projects", json={"name": "产品模型绑定"})).json()["id"]
        smart_toilet = await client.post(
            f"/api/projects/{project_id}/model-assets",
            data={"relative_paths": "智能坐便器.fbx"},
            files={"files": ("智能坐便器.fbx", b"smart-toilet-model", "application/octet-stream")},
        )
        generic = await client.post(
            f"/api/projects/{project_id}/model-assets",
            data={"relative_paths": "普通模型.fbx"},
            files={"files": ("普通模型.fbx", b"generic-model", "application/octet-stream")},
        )

        assert smart_toilet.json()["catalog_codes"] == []
        assert smart_toilet.json()["binding_status"] == "unbound"
        bound = await client.put(f"/api/projects/{project_id}/model-assets/{smart_toilet.json()['id']}/binding", json={"catalog_code":"MT3"})

    assert bound.json()["catalog_codes"] == ["MT3"]
    assert bound.json()["product_ids"] == ["8d29797a7862c52c3e74"]
    assert bound.json()["binding_status"] == "bound"
    assert generic.json()["catalog_codes"] == []
    assert generic.json()["binding_status"] == "unbound"

    from backend.app.design_chat import _model_lookup
    lookup = _model_lookup({"id": "8d29797a7862c52c3e74", "attributes": {"材料编号": "MT3", "材料名称": "马桶", "风格": "通用", "规格型号": "智能马桶"}}, {})
    assert lookup["model_asset_id"] == smart_toilet.json()["id"]
    assert lookup["model_asset_src"].endswith("/%E6%99%BA%E8%83%BD%E5%9D%90%E4%BE%BF%E5%99%A8.fbx")
    assert lookup["model_dimensions_mm"] == {"width": 380.0, "depth": 680.0, "height": 760.0}


def test_model_lookup_applies_reviewed_orientation_to_bounds(monkeypatch):
    from backend.app import design_chat
    from backend.app.models import ModelAssetResponse
    asset = ModelAssetResponse(
        id="a" * 64, project_id="project", label="侧放马桶", filename="toilet.fbx", format="fbx",
        bytes=1, sha256="a" * 64, file_count=1, created_at="2026-01-01T00:00:00+00:00",
        src="/api/model-assets/test", category="马桶", dimensions_mm={"width": 380, "depth": 760, "height": 680},
        catalog_codes=["MT-ROTATED"], binding_status="bound", orientation_view="top", orientation_corrected=True,
        orientation_source="manual", orientation_mapping={"right":"right","left":"left","top":"front","bottom":"back","front":"bottom","back":"top"},
    )
    monkeypatch.setattr(design_chat, "list_shared_model_assets", lambda: [asset])
    lookup=design_chat._model_lookup({"id":"product","attributes":{"材料编号":"MT-ROTATED","材料名称":"马桶","风格":"通用","规格型号":"test"}}, {})
    assert lookup["model_dimensions_mm"] == {"width":380,"depth":680,"height":760}
    assert lookup["model_orientation_mapping"] == asset.orientation_mapping
    assert lookup["binding_status"] == "bound"


def test_model_lookup_keeps_reviewed_shower_envelope() -> None:
    from backend.app.design_chat import _model_lookup

    lookup = _model_lookup(
        {"id": "shower-product", "attributes": {"材料编号": "HS2-1", "材料名称": "花洒", "风格": "通用", "规格型号": "恒温花洒"}},
        {},
    )
    assert lookup["model_dimensions_mm"] == {"width": 285.0, "depth": 485.0, "height": 1327.0}


def test_model_lookup_applies_builtin_orientation_override(monkeypatch):
    """Builtin library assets must inherit reviewed orientation from the overrides file."""
    from backend.app import design_chat, model_assets
    mapping = {"right": "right", "left": "left", "top": "front", "bottom": "back", "front": "bottom", "back": "top"}
    overrides = {"builtin-36980709c907": {"orientation_view": "top", "orientation_mapping": mapping, "orientation_corrected": True, "orientation_source": "manual"}}
    monkeypatch.setattr(design_chat, "list_shared_model_assets", lambda: [])
    monkeypatch.setattr(model_assets, "_orientation_overrides", lambda: overrides)
    lookup = design_chat._model_lookup({"id": "product", "attributes": {"材料编号": "XYJ1-1", "材料名称": "洗衣机", "风格": "通用", "规格型号": "test"}}, {})
    assert lookup["model_asset_id"] == "builtin-36980709c907"
    assert lookup["model_orientation_view"] == "top"
    assert lookup["model_orientation_mapping"] == mapping
    assert lookup["binding_status"] == "bound"


@pytest.mark.asyncio
async def test_model_binding_can_create_product_and_rejects_category_mismatch(tmp_path, monkeypatch) -> None:
    configure_temp_database(tmp_path)
    monkeypatch.setattr(main_module.product_graph, "path", tmp_path / "product-graph.json")
    db.initialize()
    code = f"NEW-{tmp_path.name}"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project_id = (await client.post("/api/projects", json={"name":"新增 SKU"})).json()["id"]
        asset = await client.post(f"/api/projects/{project_id}/model-assets", data={"relative_paths":"普通模型.fbx"}, files={"files":("普通模型.fbx",b"new-basin-model","application/octet-stream")})
        missing = await client.put(f"/api/projects/{project_id}/model-assets/{asset.json()['id']}/binding", json={"catalog_code":code})
        assert missing.status_code == 404
        created = await client.put(f"/api/projects/{project_id}/model-assets/{asset.json()['id']}/binding", json={"catalog_code":code,"new_product":{"材料名称":"浴室柜","规格型号":"600mm","单价":"999","数量单位":"件"}})
        assert created.status_code == 200
        assert created.json()["catalog_codes"] == [code]
        assert main_module.product_graph.product_by_code(code)["id"] == created.json()["product_ids"][0]


@pytest.mark.asyncio
async def test_product_options_endpoint_includes_new_graph_category_and_model(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(main_module.product_graph, "path", tmp_path / "product-graph.json")
    product = main_module.product_graph.create_product({"材料编号":"NEW-01","材料名称":"新种类","规格型号":"新型号","单价":"99","数量单位":"件"})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/knowledge/product-options")
    assert response.status_code == 200
    assert response.json() == {"categories":["新种类"],"products":[{"id":product["id"],"code":"NEW-01","category":"新种类","model":"新型号","price":"99","unit":"件","attributes":product["attributes"]}]}
