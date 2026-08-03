from __future__ import annotations

import shutil
import uuid
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError

from .ai import AIConfigurationError, AIResponseError, analyze_floorplan_fast as analyze_floorplan, analyze_photos, evidence_crop_png
from .capture import assess_capture
from .config import settings
from .database import db
from .measurement import measurement_contract_export, validate_measurement
from .model_assets import delete_model_asset, list_model_assets, resolve_model_asset_file, store_model_asset
from .models import (
    AnalysisResponse,
    AssetResponse,
    CaptureAssessment,
    MeasurementModel,
    MeasurementValidationResponse,
    ModelAssetResponse,
    ProjectCreate,
    ProjectResponse,
    RoomSpec,
    ImageBBox,
    ValidationResponse,
)
from .validation import validate_spec


@asynccontextmanager
async def lifespan(_application: FastAPI):
    Image.MAX_IMAGE_PIXELS = settings.max_image_pixels
    db.initialize()
    yield


app = FastAPI(title="量界 API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def project_or_404(project_id: str) -> ProjectResponse:
    try:
        return db.get_project(project_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="项目不存在") from error


def ai_http_error(error: Exception) -> HTTPException:
    if isinstance(error, AIConfigurationError):
        return HTTPException(status_code=503, detail=str(error))
    return HTTPException(status_code=502, detail=str(error))


@app.get("/api/health")
def health() -> dict:
    visual_model = settings.read_model
    fallback_model = None
    return {
        "ok": True,
        "ai_configured": settings.ai_configured,
        "model": visual_model or None,
        "fallback_model": fallback_model,
        "ocr_configured": settings.ocr_engine.lower() == "paddle",
    }


@app.get("/api/projects", response_model=list[ProjectResponse])
def list_projects() -> list[ProjectResponse]:
    return db.list_projects()


@app.post("/api/projects", response_model=ProjectResponse, status_code=201)
def create_project(payload: ProjectCreate) -> ProjectResponse:
    return db.create_project(payload.name)


@app.get("/api/projects/{project_id}", response_model=ProjectResponse)
def get_project(project_id: str) -> ProjectResponse:
    return project_or_404(project_id)


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(project_id: str) -> None:
    project = project_or_404(project_id)
    if project.status == "analysis_running":
        raise HTTPException(status_code=409, detail="项目正在识别，完成后才能删除")
    project_dir = (db.asset_dir / project_id).resolve()
    asset_root = db.asset_dir.resolve()
    db.delete_project(project_id)
    if project_dir.parent == asset_root and project_dir.exists():
        shutil.rmtree(project_dir)


@app.get("/api/projects/{project_id}/model-assets", response_model=list[ModelAssetResponse])
def project_model_assets(project_id: str) -> list[ModelAssetResponse]:
    try:
        return list_model_assets(project_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="项目不存在") from error


@app.post("/api/projects/{project_id}/model-assets", response_model=ModelAssetResponse, status_code=201)
async def upload_model_asset(
    project_id: str,
    files: list[UploadFile] = File(...),
    relative_paths: list[str] = Form(...),
) -> ModelAssetResponse:
    try:
        return await store_model_asset(project_id, files, relative_paths)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="项目不存在") from error


@app.delete("/api/projects/{project_id}/model-assets/{asset_id}", status_code=204)
def remove_model_asset(project_id: str, asset_id: str) -> None:
    try:
        delete_model_asset(project_id, asset_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="项目不存在") from error


@app.get("/api/projects/{project_id}/model-assets/{asset_id}/files/{relative_path:path}")
def model_asset_file(project_id: str, asset_id: str, relative_path: str) -> FileResponse:
    try:
        path, media_type = resolve_model_asset_file(project_id, asset_id, relative_path)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="项目不存在") from error
    return FileResponse(path, media_type=media_type)


@app.post("/api/projects/{project_id}/assets", response_model=AssetResponse, status_code=201)
async def upload_asset(
    project_id: str,
    role: str = Form(...),
    file: UploadFile = File(...),
) -> AssetResponse:
    project_or_404(project_id)
    if role not in {"floorplan", "photo"}:
        raise HTTPException(status_code=422, detail="role 必须是 floorplan 或 photo")
    content = await file.read(settings.max_upload_mb * 1024 * 1024 + 1)
    if len(content) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"单张图片不能超过 {settings.max_upload_mb} MB")
    try:
        with Image.open(BytesIO(content)) as image:
            image.verify()
        with Image.open(BytesIO(content)) as image:
            width, height = image.size
            image_format = (image.format or "").upper()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise HTTPException(status_code=415, detail="文件不是安全有效的图片") from error
    format_map = {"JPEG": (".jpg", "image/jpeg"), "PNG": (".png", "image/png"), "WEBP": (".webp", "image/webp")}
    if image_format not in format_map:
        raise HTTPException(status_code=415, detail="仅支持 JPG、PNG 和 WebP")
    extension, mime_type = format_map[image_format]
    stored_name = uuid.uuid4().hex + extension
    project_dir = db.asset_dir / project_id
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / stored_name).write_bytes(content)
    safe_filename = Path(file.filename or f"image{extension}").name[:180]
    return db.add_asset(project_id, role, safe_filename, stored_name, mime_type, width, height)


@app.get("/api/assets/{asset_id}/content")
def asset_content(asset_id: str) -> FileResponse:
    try:
        row = db.get_asset_row(asset_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="图片不存在") from error
    path = db.asset_path(row)
    if not path.exists():
        raise HTTPException(status_code=404, detail="图片文件不存在")
    return FileResponse(path, media_type=row["mime_type"], content_disposition_type="inline")


@app.get("/api/assets/{asset_id}/capture-assessment", response_model=CaptureAssessment)
def capture_assessment(asset_id: str) -> CaptureAssessment:
    try:
        row = db.get_asset_row(asset_id)
        return assess_capture(db.asset_path(row))
    except (KeyError, ValueError, OSError) as error:
        raise HTTPException(status_code=404, detail="无法检查这张图片") from error


@app.get("/api/assets/{asset_id}/crop")
def evidence_crop(
    asset_id: str,
    x_min: int,
    y_min: int,
    x_max: int,
    y_max: int,
    rotation_degrees: int = 0,
) -> Response:
    """Serve a padded OCR evidence crop; source images remain in the asset store."""
    try:
        row = db.get_asset_row(asset_id)
        bbox = ImageBBox(x_min=x_min, y_min=y_min, x_max=x_max, y_max=y_max)
        if rotation_degrees not in (0, 90, 180, 270):
            raise ValueError("rotation_degrees")
        content = evidence_crop_png(db.asset_path(row), rotation_degrees, bbox)
    except (KeyError, ValueError, OSError) as error:
        raise HTTPException(status_code=404, detail="证据裁片不存在") from error
    return Response(content=content, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@app.post("/api/projects/{project_id}/analyze-plan", response_model=AnalysisResponse)
async def analyze_plan_endpoint(project_id: str, rotation_degrees: int | None = None) -> AnalysisResponse:
    project = project_or_404(project_id)
    plans = [asset for asset in project.assets if asset.role == "floorplan"]
    if not plans:
        raise HTTPException(status_code=422, detail="请先上传平面图")
    row = db.get_asset_row(plans[-1].id)
    try:
        if rotation_degrees not in (None, 0, 90, 180, 270):
            raise HTTPException(status_code=422, detail="rotation_degrees 只能是 0、90、180 或 270")
        # Persist progress so a browser refresh does not turn an in-flight analysis into an empty state.
        db.set_status(project_id, "analysis_running")
        spec = await analyze_floorplan(db.asset_path(row), asset_id=plans[-1].id, rotation_degrees=rotation_degrees)
    except AIConfigurationError as error:
        db.set_status(project_id, "analysis_failed")
        raise ai_http_error(error) from error
    except AIResponseError as error:
        db.set_status(project_id, "analysis_failed")
        raise ai_http_error(error) from error
    ai_issues = spec.issues
    issues, sufficient, missing = validate_spec(spec)
    spec.issues = [*ai_issues, *issues]
    saved = db.save_spec(project_id, spec, "review")
    return AnalysisResponse(spec=saved.spec or spec, measurement=saved.measurement, sufficient=sufficient, missing=missing)


@app.post("/api/projects/{project_id}/analyze-photos", response_model=AnalysisResponse)
async def analyze_photos_endpoint(project_id: str) -> AnalysisResponse:
    project = project_or_404(project_id)
    if project.spec is None:
        raise HTTPException(status_code=422, detail="请先分析并确认平面图")
    photo_assets = [asset for asset in project.assets if asset.role == "photo"]
    if not photo_assets:
        raise HTTPException(status_code=422, detail="没有可分析的现场照片")
    paths = [db.asset_path(db.get_asset_row(asset.id)) for asset in photo_assets]
    try:
        spec = await analyze_photos(project.spec, paths)
    except (AIConfigurationError, AIResponseError) as error:
        raise ai_http_error(error) from error
    issues, sufficient, missing = validate_spec(spec)
    spec.issues = issues
    saved = db.save_spec(project_id, spec, "review")
    return AnalysisResponse(spec=saved.spec or spec, measurement=saved.measurement, sufficient=sufficient, missing=missing)


@app.put("/api/projects/{project_id}/spec", response_model=ProjectResponse)
def update_spec(project_id: str, spec: RoomSpec) -> ProjectResponse:
    project_or_404(project_id)
    issues, sufficient, _ = validate_spec(spec)
    spec.issues = issues
    status = "model" if sufficient and spec.confirmed else "review"
    return db.save_spec(project_id, spec, status)


@app.post("/api/projects/{project_id}/validate", response_model=ValidationResponse)
def validate_project(project_id: str) -> ValidationResponse:
    project = project_or_404(project_id)
    if project.measurement is not None:
        issues, sufficient, missing, _ = validate_measurement(project.measurement)
        return ValidationResponse(issues=issues, sufficient=sufficient, missing=missing)
    if project.spec is None:
        raise HTTPException(status_code=422, detail="项目还没有结构化模型")
    issues, sufficient, missing = validate_spec(project.spec)
    return ValidationResponse(issues=issues, sufficient=sufficient, missing=missing)


@app.post("/api/measurements/validate", response_model=MeasurementValidationResponse)
def validate_measurement_payload(measurement: MeasurementModel) -> MeasurementValidationResponse:
    issues, sufficient, missing, spec = validate_measurement(measurement)
    return MeasurementValidationResponse(
        measurement=measurement, spec=spec, issues=issues, sufficient=sufficient, missing=missing,
    )


@app.get("/api/projects/{project_id}/measurement", response_model=MeasurementModel)
def get_measurement(project_id: str) -> MeasurementModel:
    project = project_or_404(project_id)
    if project.measurement is None:
        raise HTTPException(status_code=422, detail="项目还没有量房数据")
    return project.measurement


@app.get("/api/projects/{project_id}/measurement/download")
def download_measurement(project_id: str) -> JSONResponse:
    measurement = get_measurement(project_id)
    return JSONResponse(
        content=measurement_contract_export(measurement),
        headers={"Content-Disposition": 'attachment; filename="measurement.json"'},
    )


@app.put("/api/projects/{project_id}/measurement", response_model=ProjectResponse)
def update_measurement(project_id: str, measurement: MeasurementModel) -> ProjectResponse:
    project = project_or_404(project_id)
    revision = (project.measurement.revision + 1) if project.measurement else 1
    measurement = measurement.model_copy(update={
        "measurement_id": project_id,
        "revision": revision,
    })
    issues, sufficient, missing, spec = validate_measurement(measurement)
    if spec is None or any(issue.severity == "error" for issue in issues):
        detail = "；".join(issue.message for issue in issues if issue.severity == "error") or "量房数据不完整"
        if missing:
            detail += "；缺少：" + "、".join(missing)
        raise HTTPException(status_code=422, detail=detail)
    status = "model" if sufficient and measurement.confirmed else "review"
    return db.save_measurement(project_id, measurement, status)


project_root = Path(__file__).resolve().parents[2]
dist_dir = project_root / "dist"
template_file = project_root / "public" / "measurement-template.html"


@app.get("/measurement-template.html", include_in_schema=False)
def measurement_template() -> FileResponse:
    if not template_file.is_file():
        raise HTTPException(status_code=404, detail="量房模板文件不存在")
    return FileResponse(template_file, media_type="text/html; charset=utf-8")


if dist_dir.exists():
    app.mount("/", StaticFiles(directory=dist_dir, html=True), name="frontend")
