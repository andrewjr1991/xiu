#!/usr/bin/env python3
"""Inspect and explicitly migrate Xiu Search Auth SQLite databases."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import stat
import sys
import time
from contextlib import closing
from pathlib import Path


DEVICE_COLUMNS = (
    "id",
    "name",
    "secret_hash",
    "created_at",
    "last_seen_at",
    "last_ip",
    "revoked_at",
)


def resolved_path(value: str, data_root: str, *, existing: bool) -> Path:
    root = Path(data_root).resolve(strict=True)
    candidate = Path(value)
    if not candidate.is_absolute():
        raise ValueError("database path must be absolute")
    if candidate.is_symlink():
        raise ValueError("symbolic-link database paths are not allowed")
    resolved = candidate.resolve(strict=existing)
    if resolved == root or root not in resolved.parents:
        raise ValueError("database path must stay inside the data root")
    if existing and not stat.S_ISREG(resolved.stat().st_mode):
        raise ValueError("database path must be a regular file")
    return resolved


def connect_readonly(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}


def device_count(path: Path) -> int:
    try:
        with closing(connect_readonly(path)) as connection:
            columns = table_columns(connection, "devices")
            if not columns:
                return 0
            if not set(DEVICE_COLUMNS).issubset(columns):
                raise ValueError(f"database candidate {path.name} has an incompatible devices schema")
            return int(connection.execute("SELECT COUNT(*) FROM devices").fetchone()[0])
    except sqlite3.Error as error:
        raise ValueError(f"database candidate {path.name} is unreadable") from error


def inspect_databases(target_value: str, data_root: str) -> dict[str, object]:
    root = Path(data_root).resolve(strict=True)
    target = resolved_path(target_value, data_root, existing=False)
    target_count = device_count(target) if target.exists() else 0
    candidates: list[dict[str, object]] = []
    for path in sorted(root.glob("*.sqlite3")):
        if path.is_symlink():
            raise ValueError("symbolic-link database candidates are not allowed")
        if not path.is_file():
            raise ValueError("database candidates must be regular files")
        if path.resolve() == target:
            continue
        count = device_count(path)
        if count:
            candidates.append({"file": path.name, "devices": count})
    return {
        "status": "migration_required" if target_count == 0 and candidates else "ok",
        "target": target.name,
        "targetDevices": target_count,
        "candidates": candidates,
    }


def ensure_schema(connection: sqlite3.Connection) -> None:
    connection.execute("""
        CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            secret_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER,
            last_ip TEXT,
            revoked_at INTEGER
        )
    """)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS device_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            action TEXT NOT NULL,
            occurred_at INTEGER NOT NULL,
            request_id TEXT NOT NULL
        )
    """)
    if not set(DEVICE_COLUMNS).issubset(table_columns(connection, "devices")):
        raise ValueError("target devices table has an incompatible schema")


def database_backup(target: Path) -> Path:
    suffix = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    backup = target.with_name(f"{target.name}.backup.{suffix}-{os.getpid()}")
    descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    try:
        with closing(sqlite3.connect(target)) as source, closing(sqlite3.connect(backup)) as destination:
            source.backup(destination)
        os.chmod(backup, 0o600)
    except BaseException:
        backup.unlink(missing_ok=True)
        raise
    return backup


def migration_plan(source: Path, target: Path) -> tuple[list[tuple[object, ...]], int]:
    with closing(connect_readonly(source)) as source_db:
        if not set(DEVICE_COLUMNS).issubset(table_columns(source_db, "devices")):
            raise ValueError("source devices table has an incompatible schema")
        source_rows = [tuple(row[column] for column in DEVICE_COLUMNS) for row in source_db.execute(
            f"SELECT {', '.join(DEVICE_COLUMNS)} FROM devices ORDER BY id"
        )]

    existing: dict[str, tuple[object, ...]] = {}
    if target.exists():
        with closing(connect_readonly(target)) as target_db:
            columns = table_columns(target_db, "devices")
            if columns and not set(DEVICE_COLUMNS).issubset(columns):
                raise ValueError("target devices table has an incompatible schema")
            if columns:
                existing = {
                    str(row[0]): tuple(row)
                    for row in target_db.execute(f"SELECT {', '.join(DEVICE_COLUMNS)} FROM devices")
                }

    additions: list[tuple[object, ...]] = []
    unchanged = 0
    for row in source_rows:
        current = existing.get(str(row[0]))
        if current is None:
            additions.append(row)
        elif current == row:
            unchanged += 1
        else:
            raise ValueError("a device identifier exists with different credential data")
    return additions, unchanged


def migrate(source_value: str, target_value: str, data_root: str, *, apply: bool) -> dict[str, object]:
    source = resolved_path(source_value, data_root, existing=True)
    target = resolved_path(target_value, data_root, existing=False)
    if source == target:
        raise ValueError("source and target databases must be different")
    additions, unchanged = migration_plan(source, target)
    result: dict[str, object] = {
        "status": "planned" if not apply else "migrated",
        "source": source.name,
        "target": target.name,
        "added": len(additions),
        "unchanged": unchanged,
        "backup": None,
    }
    if not apply:
        return result

    if not additions:
        result["status"] = "unchanged"
        return result

    backup = database_backup(target) if target.exists() else None
    request_id = f"migration-{source.stem}-to-{target.stem}"[:100]
    with closing(sqlite3.connect(target, timeout=10)) as target_db:
        with target_db:
            ensure_schema(target_db)
            target_db.executemany(
                f"INSERT INTO devices ({', '.join(DEVICE_COLUMNS)}) VALUES (?, ?, ?, ?, ?, ?, ?)",
                additions,
            )
            target_db.executemany(
                "INSERT INTO device_audit (device_id, action, occurred_at, request_id) VALUES (?, 'restored', ?, ?)",
                [(str(row[0]), int(time.time()), request_id) for row in additions],
            )
    os.chmod(target, 0o600)
    result["backup"] = backup.name if backup else None
    return result


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--data-root", default="/data")
    subcommands = result.add_subparsers(dest="command", required=True)
    inspect_parser = subcommands.add_parser("inspect")
    inspect_parser.add_argument("--target", required=True)
    migrate_parser = subcommands.add_parser("migrate")
    migrate_parser.add_argument("--source", required=True)
    migrate_parser.add_argument("--target", required=True)
    migrate_parser.add_argument("--apply", action="store_true")
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "inspect":
            result = inspect_databases(args.target, args.data_root)
            print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
            return 3 if result["status"] == "migration_required" else 0
        print(json.dumps(migrate(args.source, args.target, args.data_root, apply=args.apply), ensure_ascii=False, separators=(",", ":")))
        return 0
    except (OSError, sqlite3.Error, ValueError) as error:
        print(json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False, separators=(",", ":")), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
