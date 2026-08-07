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
from backend.app.models import PlanAnnotation, Point2D, RoomSpec, ShapeCorner


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

    assert homepage.status_code == 200
    assert '<div id="root"></div>' in homepage.text
    assert template.status_code == 200
    assert "单房间量房记录" in template.text
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
async def test_model_folder_upload_list_read_and_delete(tmp_path) -> None:
    configure_temp_database(tmp_path)
    db.initialize()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        project_id = (await client.post("/api/projects", json={"name": "模型文件夹"})).json()["id"]
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

        listed = await client.get(f"/api/projects/{project_id}/model-assets")
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()] == [asset["id"]]

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
        assert "只能包含一个" in multiple.json()["detail"]
