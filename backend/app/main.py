from __future__ import annotations

import hashlib
import csv
import json
import shutil
import uuid
import zipfile
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
import httpx
import asyncio

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError

from .ai import AIConfigurationError, AIResponseError, analyze_floorplan_fast as analyze_floorplan, analyze_photos, cleanup_ai_traces, evidence_crop_png
from .capture import assess_capture
from .config import settings
from .database import db
from .design_chat import design_chat
from .auto_layout import generate_model_layout
from .knowledge_graph import ProductKnowledgeGraph
from .measurement import measurement_contract_export, measurement_from_spec, validate_measurement
from .measurement_import import MeasurementImportError, import_measurement_file, inspect_measurement_file
from .model_assets import bind_model_asset, delete_model_asset, list_model_assets, resolve_model_asset_file, set_model_orientation, store_model_asset
from .models import (
    AnalysisResponse,
    AutoLayoutRequest,
    AssetResponse,
    CaptureAssessment,
    ChatSessionCreate,
    ChatSessionResponse,
    ChatSessionSummary,
    ChatTurnCreate,
    VoiceAudioResponse,
    VoiceTurnResponse,
    DesignChatRequest,
    MeasurementModel,
    MeasurementImportInspection,
    MeasurementImportResponse,
    MeasurementValidationResponse,
    ModelAssetResponse,
    ModelAssetBindingRequest,
    ModelOrientationAutoRequest,
    ModelOrientationRequest,
    ProjectCreate,
    ProjectResponse,
    RoomSpec,
    ImageBBox,
    ValidationResponse,
)
from .validation import validate_spec
from .voice import VoiceConfigurationError, runtime_status, synthesize, transcribe


project_root = Path(__file__).resolve().parents[2]
product_graph = ProductKnowledgeGraph(settings.app_data_dir / "product-knowledge-graph.json")
default_product_catalog = project_root / "backend" / "data" / "product_catalog.csv"
backend_source_version = max(
    (int(path.stat().st_mtime) for path in (project_root / "backend" / "app").glob("*.py")),
    default=0,
)
environment_path = project_root / ".env"
configuration_source = environment_path if environment_path.is_file() else project_root / ".env.example"
backend_config_version = hashlib.sha256(configuration_source.read_bytes()).hexdigest()[:16] if configuration_source.is_file() else None


@asynccontextmanager
async def lifespan(_application: FastAPI):
    Image.MAX_IMAGE_PIXELS = settings.max_image_pixels
    cleanup_ai_traces()
    db.initialize()
    # Ship the approved baseline catalog with the application. Subsequent XLSX/CSV
    # imports keep using the same stable material numbers and update it in place.
    if default_product_catalog.is_file() and not product_graph.path.is_file():
        product_graph.import_catalog(default_product_catalog.name, default_product_catalog.read_bytes())
    yield


app = FastAPI(title="小和 API", version="0.1.0", lifespan=lifespan)

VOICE_GREETING = "您好，我是小和需求助手。请告诉我家庭成员、使用需求、喜欢的风格和预算，我会结合当前量房数据为您规划。"
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
        "service_id": "bathroom-spatial-studio",
        "source_version": backend_source_version,
        "config_version": backend_config_version,
        "ai_configured": settings.ai_configured,
        "chat_configured": settings.chat_configured,
        "model": visual_model or None,
        "chat_model": settings.chat_model or None,
        "fallback_model": fallback_model,
        "ocr_configured": settings.ocr_engine.lower() == "paddle",
        **runtime_status(),
    }

@app.post("/api/knowledge/products/import")
async def import_products(file: UploadFile = File(...)) -> dict:
    content=await file.read(50*1024*1024+1)
    if len(content)>50*1024*1024:raise HTTPException(413,"产品清单不能超过 50 MB")
    try:return product_graph.import_catalog(Path(file.filename or "catalog.xlsx").name,content)
    except (ValueError,KeyError,zipfile.BadZipFile) as error:raise HTTPException(422,str(error)) from error

@app.post("/api/design-chat")
async def design_chat_endpoint(payload: DesignChatRequest) -> dict:
    try:return await design_chat([x.model_dump() for x in payload.messages],product_graph,payload.room.model_dump() if payload.room else None)
    except RuntimeError as error:raise HTTPException(503,str(error)) from error
    except (httpx.HTTPError,KeyError,IndexError) as error:raise HTTPException(502,"对话模型暂时不可用") from error


@app.post("/api/auto-layout")
async def auto_layout_endpoint(payload: AutoLayoutRequest) -> dict:
    try:
        return await generate_model_layout(
            payload.room.model_dump(),
            product_graph,
            payload.requirements,
            payload.previous_layout,
            payload.geometry_feedback,
        )
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error
    except ValueError as error:
        raise HTTPException(502, f"大模型布局无效：{error}") from error
    except httpx.HTTPError as error:
        raise HTTPException(502, f"大模型连接失败（{type(error).__name__}）：{str(error)[:300]}") from error
    except (KeyError, IndexError) as error:
        raise HTTPException(502, "大模型响应缺少必要字段") from error


@app.get("/api/projects/{project_id}/chat-sessions", response_model=list[ChatSessionSummary])
def list_project_chat_sessions(project_id: str) -> list[ChatSessionSummary]:
    try:
        return db.list_chat_sessions(project_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="项目不存在") from error


@app.post("/api/projects/{project_id}/chat-sessions", response_model=ChatSessionResponse, status_code=201)
def create_project_chat_session(project_id: str, payload: ChatSessionCreate) -> ChatSessionResponse:
    try:
        return db.create_chat_session(project_id, payload.title)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="项目不存在") from error


@app.get("/api/projects/{project_id}/chat-sessions/{session_id}", response_model=ChatSessionResponse)
def get_project_chat_session(project_id: str, session_id: str) -> ChatSessionResponse:
    try:
        return db.get_chat_session(project_id, session_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="对话不存在") from error


@app.delete("/api/projects/{project_id}/chat-sessions/{session_id}", status_code=204)
def delete_project_chat_session(project_id: str, session_id: str) -> Response:
    try:
        db.delete_chat_session(project_id, session_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="对话不存在") from error
    return Response(status_code=204)


@app.post("/api/projects/{project_id}/chat-sessions/{session_id}/messages", response_model=ChatSessionResponse)
async def append_project_chat_message(project_id: str, session_id: str, payload: ChatTurnCreate) -> ChatSessionResponse:
    try:
        session = db.get_chat_session(project_id, session_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="对话不存在") from error
    if sum(message.role == "user" for message in session.messages) >= 20:
        raise HTTPException(status_code=422, detail="当前对话已达到 20 轮，请新建对话继续")
    messages = [{"role": message.role, "content": message.content} for message in session.messages]
    messages.append({"role": "user", "content": payload.content})
    try:
        result = await design_chat(messages, product_graph, payload.room.model_dump() if payload.room else None)
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from error
    except (httpx.HTTPError, KeyError, IndexError) as error:
        raise HTTPException(502, "对话模型暂时不可用") from error
    return db.append_chat_turn(project_id, session_id, payload.content, result["message"], result)


@app.post("/api/projects/{project_id}/chat-sessions/{session_id}/voice-turn", response_model=VoiceTurnResponse)
async def append_project_voice_turn(
    project_id: str,
    session_id: str,
    audio: UploadFile = File(...),
    room_json: str = Form(...),
) -> VoiceTurnResponse:
    if audio.content_type and not audio.content_type.startswith("audio/"):
        raise HTTPException(415, "请上传浏览器录制的音频")
    content = await audio.read(settings.max_upload_mb * 1024 * 1024 + 1)
    if len(content) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, "录音文件过大")
    try:
        room = RoomSpec.model_validate_json(room_json)
        session = db.get_chat_session(project_id, session_id)
        transcript = await asyncio.to_thread(transcribe, content, Path(audio.filename or "recording.webm").suffix or ".webm")
        messages = [{"role": message.role, "content": message.content} for message in session.messages]
        messages.append({"role": "user", "content": transcript})
        result = await design_chat(messages, product_graph, room.model_dump())
        updated = db.append_chat_turn(project_id, session_id, transcript, result["message"], result)
        speech, audio_mime_type = await asyncio.to_thread(synthesize, result["message"])
        return VoiceTurnResponse(transcript=transcript, session=updated, audio_base64=speech, audio_mime_type=audio_mime_type)
    except KeyError as error:
        raise HTTPException(404, "对话不存在") from error
    except VoiceConfigurationError as error:
        raise HTTPException(503, str(error)) from error
    except (ValueError, RuntimeError) as error:
        raise HTTPException(422, str(error)) from error
    except httpx.HTTPError as error:
        raise HTTPException(502, "对话模型暂时不可用") from error


@app.get("/api/voice/greeting", response_model=VoiceAudioResponse)
async def voice_greeting() -> VoiceAudioResponse:
    try:
        speech, audio_mime_type = await asyncio.to_thread(synthesize, VOICE_GREETING)
        return VoiceAudioResponse(text=VOICE_GREETING, audio_base64=speech, audio_mime_type=audio_mime_type)
    except VoiceConfigurationError as error:
        raise HTTPException(503, str(error)) from error
    except RuntimeError as error:
        raise HTTPException(422, str(error)) from error


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


@app.put("/api/projects/{project_id}/model-assets/{asset_id}/binding", response_model=ModelAssetResponse)
def bind_project_model_asset(project_id: str, asset_id: str, request: ModelAssetBindingRequest) -> ModelAssetResponse:
    code = request.catalog_code.strip()
    product = product_graph.product_by_code(code)
    if product is None and default_product_catalog.is_file():
        with default_product_catalog.open("r", encoding="utf-8-sig", newline="") as source:
            row = next((item for item in csv.DictReader(source) if (item.get("材料编号") or "").strip() == code), None)
        if row:
            attributes = {key: value.strip() for key, value in row.items() if key and value and value.strip()}
            category = attributes["材料名称"]
            product = {"id": hashlib.sha256(f"{code}|{category}".encode()).hexdigest()[:20], "attributes": attributes, "active": True}
    if product is None and request.new_product is not None:
        attributes = {**request.new_product, "材料编号": code}
        try: product = product_graph.create_product(attributes)
        except ValueError as error: raise HTTPException(status_code=422, detail=str(error)) from error
    if product is None:
        raise HTTPException(status_code=404, detail="产品目录中不存在该 SKU；请补充新产品资料后再绑定")
    return bind_model_asset(project_id, asset_id, product)


@app.delete("/api/projects/{project_id}/model-assets/{asset_id}", status_code=204)
def remove_model_asset(project_id: str, asset_id: str) -> None:
    try:
        delete_model_asset(project_id, asset_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="项目不存在") from error


@app.put("/api/projects/{project_id}/model-assets/{asset_id}/orientation", response_model=ModelAssetResponse)
def correct_model_orientation(project_id: str, asset_id: str, request: ModelOrientationRequest) -> ModelAssetResponse:
    return set_model_orientation(project_id, asset_id, request.view, "manual")


@app.post("/api/projects/{project_id}/model-assets/{asset_id}/orientation/auto", response_model=ModelAssetResponse)
async def auto_correct_model_orientation(project_id: str, asset_id: str, request: ModelOrientationAutoRequest) -> ModelAssetResponse:
    if not request.preview_data_url.startswith("data:image/"):
        raise HTTPException(status_code=422, detail="模型预览图无效")
    if not settings.ai_configured:
        raise HTTPException(status_code=503, detail="视觉模型尚未配置，请人工选择方向")
    prompt = (
        "你是3D家具模型入库质检员。观察等轴测预览，判断该模型当前最适合作为标准正视图、顶视图还是侧视图。"
        "只返回 JSON，例如 {\"view\":\"front\"}；view 只能是 front、top、side。"
    )
    async with httpx.AsyncClient(timeout=settings.ai_timeout_seconds) as client:
        response = await client.post(
            settings.openai_base_url.rstrip("/") + "/chat/completions",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            json={"model": settings.read_model, "temperature": 0, "response_format": {"type": "json_object"}, "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": request.preview_data_url, "detail": "high"}}]}]},
        )
        response.raise_for_status()
    try:
        payload = json.loads(response.json()["choices"][0]["message"]["content"])
        view = payload["view"]
        if view not in {"front", "top", "side"}: raise ValueError
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=502, detail="视觉模型未返回有效方向") from error
    return set_model_orientation(project_id, asset_id, view, "auto")


@app.get("/api/projects/{project_id}/model-assets/{asset_id}/files/{relative_path:path}")
def model_asset_file(project_id: str, asset_id: str, relative_path: str) -> FileResponse:
    try:
        project_or_404(project_id)
        path, media_type = resolve_model_asset_file(asset_id, relative_path)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="项目不存在") from error
    return FileResponse(path, media_type=media_type)


@app.get("/api/model-assets/{asset_id}/files/{relative_path:path}")
def shared_model_asset_file(asset_id: str, relative_path: str) -> FileResponse:
    path, media_type = resolve_model_asset_file(asset_id, relative_path)
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
    previous_status = project.status
    try:
        if rotation_degrees not in (None, 0, 90, 180, 270):
            raise HTTPException(status_code=422, detail="rotation_degrees 只能是 0、90、180 或 270")
        db.set_status(project_id, "analysis_running")
        spec = await analyze_floorplan(db.asset_path(row), asset_id=plans[-1].id, rotation_degrees=rotation_degrees)
    except AIConfigurationError as error:
        raise ai_http_error(error) from error
    except AIResponseError as error:
        raise ai_http_error(error) from error
    finally:
        db.restore_status(project_id, previous_status, "analysis_running")
    ai_issues = spec.issues
    issues, sufficient, missing = validate_spec(spec)
    spec.issues = [*ai_issues, *issues]
    revision = (project.measurement.revision + 1) if project.measurement else 1
    measurement = measurement_from_spec(spec, project_id, revision=revision) if len(spec.boundary) >= 3 else None
    return AnalysisResponse(spec=spec, measurement=measurement, sufficient=sufficient, missing=missing)


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
    revision = (project.measurement.revision + 1) if project.measurement else 1
    measurement = measurement_from_spec(spec, project_id, revision=revision) if len(spec.boundary) >= 3 else None
    return AnalysisResponse(spec=spec, measurement=measurement, sufficient=sufficient, missing=missing)


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


async def _measurement_import_content(file: UploadFile) -> tuple[bytes, str]:
    content = await file.read(settings.max_upload_mb * 1024 * 1024 + 1)
    if len(content) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"量房文件不能超过 {settings.max_upload_mb} MB")
    if not content:
        raise HTTPException(status_code=422, detail="量房文件为空")
    return content, Path(file.filename or "measurement").name[:180]


@app.post("/api/projects/{project_id}/measurement/import/inspect", response_model=MeasurementImportInspection)
async def inspect_measurement_import(project_id: str, file: UploadFile = File(...)) -> MeasurementImportInspection:
    project_or_404(project_id)
    content, filename = await _measurement_import_content(file)
    try:
        return MeasurementImportInspection.model_validate(inspect_measurement_file(content, filename))
    except MeasurementImportError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=f"量房文件检查失败：{error}") from error


@app.post("/api/projects/{project_id}/measurement/import", response_model=MeasurementImportResponse)
async def import_project_measurement(
    project_id: str,
    file: UploadFile = File(...),
    unit: str = Form("auto"),
    layer: str | None = Form(None),
    height_mm: int = Form(2600),
) -> MeasurementImportResponse:
    project_or_404(project_id)
    content, filename = await _measurement_import_content(file)
    try:
        imported = import_measurement_file(content, filename, unit=unit, layer=layer or None, height_mm=height_mm)
    except MeasurementImportError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=f"量房文件导入失败：{error}") from error
    issues, sufficient, _ = validate_spec(imported.spec)
    imported.spec.issues = [*imported.spec.issues, *issues]
    project = db.save_spec(project_id, imported.spec, "review")
    return MeasurementImportResponse(
        project=project,
        source_format=imported.source_format,
        source_unit=imported.source_unit,
        scale_to_mm=imported.scale_to_mm,
        selected_layer=imported.selected_layer,
        warnings=imported.warnings + ([] if sufficient else ["导入数据尚未通过建模门禁，请在二维审图中校正"]),
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


dist_dir = project_root / "dist"
template_file = project_root / "public" / "measurement-template.html"
model_library_dir = project_root / "public" / "model-library"


@app.get("/measurement-template.html", include_in_schema=False)
def measurement_template() -> FileResponse:
    if not template_file.is_file():
        raise HTTPException(status_code=404, detail="量房模板文件不存在")
    return FileResponse(template_file, media_type="text/html; charset=utf-8")


if model_library_dir.exists():
    app.mount("/model-library", StaticFiles(directory=model_library_dir), name="model-library")


if dist_dir.exists():
    app.mount("/", StaticFiles(directory=dist_dir, html=True), name="frontend")
