from io import BytesIO
from uuid import UUID

import httpx
import pytest
from PIL import Image

from backend.app.database import db
from backend.app.config import settings
from backend.app import main as main_module
from backend.app.ai import AIResponseError
from backend.app.main import app
from backend.app.models import PlanAnnotation, Point2D, RoomSpec, ShapeCorner


def configure_temp_database(tmp_path) -> None:
    db.data_dir = tmp_path
    db.db_path = tmp_path / "studio.sqlite3"
    db.asset_dir = tmp_path / "projects"


@pytest.mark.asyncio
async def test_project_upload_and_save_flow(tmp_path, monkeypatch) -> None:
    configure_temp_database(tmp_path)
    monkeypatch.setattr(settings, "openai_base_url", "")
    monkeypatch.setattr(settings, "openai_api_key", "")
    monkeypatch.setattr(settings, "openai_model", "")

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
            "openings": [], "fixtures": [], "observations": [], "issues": [], "confirmed": True,
        }
        saved = await client.put(f"/api/projects/{project_id}/spec", json=spec)
        assert saved.status_code == 200
        assert saved.json()["status"] == "model"
        measurement = saved.json()["measurement"]
        assert measurement["units"] == "mm"
        assert measurement["measurement_id"] == project_id
        assert len(measurement["walls"]) == 4

        validated = await client.post("/api/measurements/validate", json=measurement)
        assert validated.status_code == 200
        assert validated.json()["sufficient"] is True
        assert validated.json()["spec"]["boundary"] == spec["boundary"]

        downloaded = await client.get(f"/api/projects/{project_id}/measurement/download")
        assert downloaded.status_code == 200
        assert downloaded.headers["content-disposition"] == 'attachment; filename="measurement.json"'
        contract_measurement = downloaded.json()
        assert set(contract_measurement) == {
            "schemaVersion", "roomId", "boundary", "walls", "openings",
            "drainagePoints", "pipeEnclosures", "waterSupplyPoints", "heights",
        }
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
        assert imported.json()["measurement"]["revision"] == 3


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
async def test_failed_reanalysis_marks_old_spec_stale_without_deleting_it(tmp_path, monkeypatch) -> None:
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
        assert project["status"] == "analysis_failed"
        assert project["spec"]["height_mm"] == 2600
        assert project["measurement"]["heights"]["room_height_mm"] == 2600
        assert len(project["measurement"]["walls"]) == 3
