from pathlib import Path

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=PROJECT_ROOT / ".env", extra="ignore")

    openai_base_url: str = ""
    openai_api_key: str = ""
    read_model: str = Field(
        default="",
        validation_alias=AliasChoices("READ_MODEL", "OPENAI_VISION_MODEL", "OPENAI_FAST_MODEL", "OPENAI_MODEL"),
    )
    chat_model: str = Field(
        default="",
        validation_alias=AliasChoices("CHAT_MODEL", "OPENAI_COORDINATOR_MODEL", "OPENAI_MODEL"),
    )
    app_data_dir: Path = PROJECT_ROOT / "backend" / "data"
    max_upload_mb: int = 20
    max_image_pixels: int = 30_000_000
    ai_timeout_seconds: int = 120
    ai_max_retries: int = 3
    ai_retry_base_seconds: float = 0.75
    ai_max_tool_rounds: int = 4
    # Model responses can contain recognized room measurements. Keep response
    # tracing opt-in so normal runs do not persist that data outside the project DB.
    ai_trace_enabled: bool = False
    # Bound the optional on-disk response trace store. Cleanup runs at startup
    # and after each write, so enabling tracing cannot create an unbounded log.
    ai_trace_retention_days: int = 30
    ai_trace_max_files: int = 2000
    ai_trace_max_bytes: int = 50_000_000
    ai_compare_topology_models: bool = False
    ai_wall_crop_concurrency: int = 4
    # Keep the refined OCR run as the canonical cache so wall-crop and
    # global-vision alternatives survive between analysis stages.
    ocr_cache_dir: Path = PROJECT_ROOT / ".tmp" / "ocr-fast"
    ocr_cache_ttl_hours: int = 24
    ocr_engine: str = "paddle"
    paddleocr_python: str = ""
    ocr_timeout_seconds: int = 180
    funasr_model: str = "paraformer-zh"
    funasr_vad_model: str = "fsmn-vad"
    funasr_punc_model: str = ""
    voice_model_cache_dir: Path = PROJECT_ROOT / ".tmp" / "modelscope"
    voice_tts_provider: str = "edge"
    edge_tts_voice: str = "zh-CN-XiaoxiaoNeural"
    melotts_speaker: str = "ZH"
    melotts_speed: float = 1.0
    # JSON argv or a command template using {input}/{output}; output must be GLB.
    model_converter_command: str = ""
    model_conversion_timeout_seconds: int = 180

    @field_validator("app_data_dir", "ocr_cache_dir", "voice_model_cache_dir", mode="after")
    @classmethod
    def resolve_project_path(cls, value: Path) -> Path:
        return value if value.is_absolute() else PROJECT_ROOT / value

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # A project-local .env must win over unrelated machine-wide API keys.
        return init_settings, dotenv_settings, env_settings, file_secret_settings

    @property
    def ai_configured(self) -> bool:
        return bool(self.openai_base_url and self.openai_api_key and self.read_model)

    @property
    def chat_configured(self) -> bool:
        return bool(self.openai_base_url and self.openai_api_key and self.chat_model)


settings = Settings()
