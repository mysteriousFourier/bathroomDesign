from pathlib import Path

from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_base_url: str = ""
    openai_api_key: str = ""
    openai_model: str = ""
    openai_quality_model: str = ""
    openai_fallback_model: str = ""
    app_data_dir: Path = Path("backend/data")
    max_upload_mb: int = 20
    max_image_pixels: int = 30_000_000
    ai_timeout_seconds: int = 120
    ai_max_retries: int = 3
    ai_retry_base_seconds: float = 0.75
    ai_max_tool_rounds: int = 4
    ai_trace_enabled: bool = True
    ai_compare_topology_models: bool = False
    ai_quality_timeout_seconds: int = 35
    # Keep the refined OCR run as the canonical cache. It contains the
    # vision-corrected alternatives used for the real floorplan sample.
    ocr_cache_dir: Path = Path(".tmp/ocr-fast")
    ocr_cache_ttl_hours: int = 24
    ocr_engine: str = "paddle"
    paddleocr_python: str = ""
    ocr_timeout_seconds: int = 180

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
        return bool(self.openai_base_url and self.openai_api_key and self.openai_model)


settings = Settings()
