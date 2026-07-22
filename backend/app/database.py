from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from .config import settings
from .measurement import measurement_from_spec, room_spec_from_measurement
from .models import AssetResponse, MeasurementModel, ProjectResponse, RoomSpec


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Database:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.db_path = data_dir / "studio.sqlite3"
        self.asset_dir = data_dir / "projects"

    def initialize(self) -> None:
        self.asset_dir.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    spec_json TEXT,
                    measurement_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS assets (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    stored_name TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
                );
                """
            )
            columns = {row[1] for row in connection.execute("PRAGMA table_info(projects)").fetchall()}
            if "measurement_json" not in columns:
                connection.execute("ALTER TABLE projects ADD COLUMN measurement_json TEXT")
            legacy_rows = connection.execute(
                "SELECT id, spec_json FROM projects WHERE measurement_json IS NULL AND spec_json IS NOT NULL"
            ).fetchall()
            for row in legacy_rows:
                try:
                    spec = RoomSpec.model_validate_json(row["spec_json"])
                    measurement = measurement_from_spec(spec, row["id"])
                except (ValueError, TypeError):
                    continue
                connection.execute(
                    "UPDATE projects SET measurement_json = ? WHERE id = ?",
                    (measurement.model_dump_json(), row["id"]),
                )

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def create_project(self, name: str) -> ProjectResponse:
        project_id = uuid.uuid4().hex
        timestamp = now_iso()
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO projects (id, name, status, spec_json, measurement_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (project_id, name.strip(), "draft", None, None, timestamp, timestamp),
            )
        return self.get_project(project_id)

    def list_projects(self) -> list[ProjectResponse]:
        with self.connect() as connection:
            rows = connection.execute("SELECT id FROM projects ORDER BY updated_at DESC").fetchall()
        return [self.get_project(row["id"]) for row in rows]

    def get_project(self, project_id: str) -> ProjectResponse:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
            if row is None:
                raise KeyError(project_id)
            assets = connection.execute("SELECT * FROM assets WHERE project_id = ? ORDER BY created_at", (project_id,)).fetchall()
        measurement = MeasurementModel.model_validate_json(row["measurement_json"]) if row["measurement_json"] else None
        spec = room_spec_from_measurement(measurement) if measurement else (
            RoomSpec.model_validate_json(row["spec_json"]) if row["spec_json"] else None
        )
        return ProjectResponse(
            id=row["id"], name=row["name"], status=row["status"], created_at=row["created_at"], updated_at=row["updated_at"], spec=spec,
            measurement=measurement,
            assets=[self._asset_response(asset) for asset in assets],
        )

    def save_spec(self, project_id: str, spec: RoomSpec, status: str = "review") -> ProjectResponse:
        with self.connect() as connection:
            row = connection.execute("SELECT measurement_json FROM projects WHERE id = ?", (project_id,)).fetchone()
            if row is None:
                raise KeyError(project_id)
            revision = 1
            if row["measurement_json"]:
                revision = MeasurementModel.model_validate_json(row["measurement_json"]).revision + 1
            measurement = measurement_from_spec(spec, project_id, revision=revision)
            result = connection.execute(
                "UPDATE projects SET spec_json = ?, measurement_json = ?, status = ?, updated_at = ? WHERE id = ?",
                (spec.model_dump_json(), measurement.model_dump_json(), status, now_iso(), project_id),
            )
            if result.rowcount == 0:
                raise KeyError(project_id)
        return self.get_project(project_id)

    def save_measurement(self, project_id: str, measurement: MeasurementModel, status: str = "review") -> ProjectResponse:
        spec = room_spec_from_measurement(measurement)
        with self.connect() as connection:
            result = connection.execute(
                "UPDATE projects SET spec_json = ?, measurement_json = ?, status = ?, updated_at = ? WHERE id = ?",
                (spec.model_dump_json(), measurement.model_dump_json(), status, now_iso(), project_id),
            )
            if result.rowcount == 0:
                raise KeyError(project_id)
        return self.get_project(project_id)

    def set_status(self, project_id: str, status: str) -> ProjectResponse:
        with self.connect() as connection:
            result = connection.execute(
                "UPDATE projects SET status = ?, updated_at = ? WHERE id = ?",
                (status, now_iso(), project_id),
            )
            if result.rowcount == 0:
                raise KeyError(project_id)
        return self.get_project(project_id)

    def add_asset(self, project_id: str, role: str, filename: str, stored_name: str, mime_type: str, width: int, height: int) -> AssetResponse:
        self.get_project(project_id)
        asset_id = uuid.uuid4().hex
        created_at = now_iso()
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (asset_id, project_id, role, filename, stored_name, mime_type, width, height, created_at),
            )
            connection.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (created_at, project_id))
        return AssetResponse(id=asset_id, project_id=project_id, role=role, filename=filename, mime_type=mime_type, width=width, height=height, created_at=created_at, url=f"/api/assets/{asset_id}/content")

    def get_asset_row(self, asset_id: str) -> sqlite3.Row:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
        if row is None:
            raise KeyError(asset_id)
        return row

    def asset_path(self, row: sqlite3.Row) -> Path:
        return self.asset_dir / row["project_id"] / row["stored_name"]

    def delete_project(self, project_id: str) -> None:
        with self.connect() as connection:
            if connection.execute("DELETE FROM projects WHERE id = ?", (project_id,)).rowcount == 0:
                raise KeyError(project_id)

    @staticmethod
    def _asset_response(row: sqlite3.Row) -> AssetResponse:
        return AssetResponse(id=row["id"], project_id=row["project_id"], role=row["role"], filename=row["filename"], mime_type=row["mime_type"], width=row["width"], height=row["height"], created_at=row["created_at"], url=f"/api/assets/{row['id']}/content")


db = Database(settings.app_data_dir)
