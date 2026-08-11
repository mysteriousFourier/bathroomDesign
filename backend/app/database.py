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
from .models import AssetResponse, ChatMessageResponse, ChatSessionResponse, ChatSessionSummary, MeasurementModel, ProjectResponse, RoomSpec


CHAT_GREETING = "您好，我是小和。我会直接读取主界面量房数据计算地面、墙面用量；您只需告诉我使用人群、功能、风格和预算。"


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
                CREATE TABLE IF NOT EXISTS chat_sessions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    quote_json TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_chat_sessions_project_updated
                    ON chat_sessions(project_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
                    ON chat_messages(session_id, created_at);
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
        # RoomSpec carries the editable photo annotation and OCR-to-object
        # bindings that the normalized measurement contract intentionally does
        # not represent. Prefer it for the studio UI and only reconstruct older
        # records that do not have spec_json.
        spec = RoomSpec.model_validate_json(row["spec_json"]) if row["spec_json"] else (
            room_spec_from_measurement(measurement) if measurement else None
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
            measurement = (
                measurement_from_spec(spec, project_id, revision=revision)
                if len(spec.boundary) >= 3
                else None
            )
            result = connection.execute(
                "UPDATE projects SET spec_json = ?, measurement_json = ?, status = ?, updated_at = ? WHERE id = ?",
                (
                    spec.model_dump_json(),
                    measurement.model_dump_json() if measurement else None,
                    status,
                    now_iso(),
                    project_id,
                ),
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

    def restore_status(self, project_id: str, status: str, expected_status: str) -> ProjectResponse:
        with self.connect() as connection:
            row = connection.execute("SELECT status FROM projects WHERE id = ?", (project_id,)).fetchone()
            if row is None:
                raise KeyError(project_id)
            if row["status"] == expected_status:
                connection.execute(
                    "UPDATE projects SET status = ?, updated_at = ? WHERE id = ?",
                    (status, now_iso(), project_id),
                )
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
            if role == "floorplan":
                connection.execute(
                    "UPDATE projects SET updated_at = ? WHERE id = ?",
                    (created_at, project_id),
                )
            else:
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

    def create_chat_session(self, project_id: str, title: str = "新对话") -> ChatSessionResponse:
        session_id = uuid.uuid4().hex
        timestamp = now_iso()
        with self.connect() as connection:
            if connection.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone() is None:
                raise KeyError(project_id)
            connection.execute(
                "INSERT INTO chat_sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (session_id, project_id, title.strip() or "新对话", timestamp, timestamp),
            )
            connection.execute(
                "INSERT INTO chat_messages (id, session_id, role, content, quote_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (uuid.uuid4().hex, session_id, "assistant", CHAT_GREETING, None, timestamp),
            )
        return self.get_chat_session(project_id, session_id)

    def list_chat_sessions(self, project_id: str) -> list[ChatSessionSummary]:
        with self.connect() as connection:
            if connection.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone() is None:
                raise KeyError(project_id)
            rows = connection.execute(
                """
                SELECT session.id, session.project_id, session.title, session.created_at, session.updated_at,
                       COUNT(message.id) AS message_count,
                       COALESCE((
                           SELECT latest.content FROM chat_messages AS latest
                           WHERE latest.session_id = session.id
                           ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
                       ), '') AS last_message
                FROM chat_sessions AS session
                LEFT JOIN chat_messages AS message ON message.session_id = session.id
                WHERE session.project_id = ?
                GROUP BY session.id
                ORDER BY session.updated_at DESC
                """,
                (project_id,),
            ).fetchall()
        return [ChatSessionSummary.model_validate(dict(row)) for row in rows]

    def get_chat_session(self, project_id: str, session_id: str) -> ChatSessionResponse:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM chat_sessions WHERE id = ? AND project_id = ?",
                (session_id, project_id),
            ).fetchone()
            if row is None:
                raise KeyError(session_id)
            message_rows = connection.execute(
                "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at, rowid",
                (session_id,),
            ).fetchall()
        messages = [ChatMessageResponse(
            id=message["id"], role=message["role"], content=message["content"],
            quote=json.loads(message["quote_json"]) if message["quote_json"] else None,
            created_at=message["created_at"],
        ) for message in message_rows]
        return ChatSessionResponse(
            id=row["id"], project_id=row["project_id"], title=row["title"],
            message_count=len(messages), last_message=messages[-1].content if messages else "",
            created_at=row["created_at"], updated_at=row["updated_at"], messages=messages,
        )

    def delete_chat_session(self, project_id: str, session_id: str) -> None:
        with self.connect() as connection:
            deleted = connection.execute(
                "DELETE FROM chat_sessions WHERE id = ? AND project_id = ?",
                (session_id, project_id),
            ).rowcount
            if deleted == 0:
                raise KeyError(session_id)

    def append_chat_turn(self, project_id: str, session_id: str, user_content: str, assistant_content: str, quote: dict[str, object]) -> ChatSessionResponse:
        timestamp = now_iso()
        with self.connect() as connection:
            session = connection.execute(
                "SELECT * FROM chat_sessions WHERE id = ? AND project_id = ?",
                (session_id, project_id),
            ).fetchone()
            if session is None:
                raise KeyError(session_id)
            user_count = connection.execute(
                "SELECT COUNT(*) FROM chat_messages WHERE session_id = ? AND role = 'user'",
                (session_id,),
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO chat_messages (id, session_id, role, content, quote_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (uuid.uuid4().hex, session_id, "user", user_content, None, timestamp),
            )
            connection.execute(
                "INSERT INTO chat_messages (id, session_id, role, content, quote_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (uuid.uuid4().hex, session_id, "assistant", assistant_content, json.dumps(quote, ensure_ascii=False), timestamp),
            )
            title = session["title"]
            if user_count == 0 and title == "新对话":
                title = user_content.strip().replace("\n", " ")[:28] or title
            connection.execute(
                "UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?",
                (title, timestamp, session_id),
            )
        return self.get_chat_session(project_id, session_id)

    @staticmethod
    def _asset_response(row: sqlite3.Row) -> AssetResponse:
        return AssetResponse(id=row["id"], project_id=row["project_id"], role=row["role"], filename=row["filename"], mime_type=row["mime_type"], width=row["width"], height=row["height"], created_at=row["created_at"], url=f"/api/assets/{row['id']}/content")


db = Database(settings.app_data_dir)
