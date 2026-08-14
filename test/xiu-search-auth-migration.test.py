import importlib.util
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path


MODULE_PATH = Path(__file__).parent.parent / "scripts" / "xiu-search-auth" / "migrate_database.py"
SPEC = importlib.util.spec_from_file_location("migrate_database", MODULE_PATH)
assert SPEC and SPEC.loader
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


def create_database(path: Path, devices: list[tuple[object, ...]]) -> None:
    with closing(sqlite3.connect(path)) as connection:
        with connection:
            MIGRATION.ensure_schema(connection)
            connection.executemany(
                "INSERT INTO devices (id, name, secret_hash, created_at, last_seen_at, last_ip, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                devices,
            )


class MigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.device = ("device_one", "test", "hash-one", 1, 2, "127.0.0.1", None)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_inspect_fails_closed_when_populated_alternate_exists(self) -> None:
        target = self.root / "current.sqlite3"
        source = self.root / "old.sqlite3"
        create_database(target, [])
        create_database(source, [self.device])
        result = MIGRATION.inspect_databases(str(target), str(self.root))
        self.assertEqual(result["status"], "migration_required")
        self.assertEqual(result["candidates"], [{"file": "old.sqlite3", "devices": 1}])

    def test_dry_run_does_not_change_target(self) -> None:
        target = self.root / "current.sqlite3"
        source = self.root / "old.sqlite3"
        create_database(target, [])
        create_database(source, [self.device])
        result = MIGRATION.migrate(str(source), str(target), str(self.root), apply=False)
        self.assertEqual(result["status"], "planned")
        self.assertEqual(result["added"], 1)
        self.assertEqual(MIGRATION.device_count(target), 0)
        self.assertEqual(list(self.root.glob("*.backup.*")), [])

    def test_readonly_uri_handles_reserved_url_characters(self) -> None:
        source = self.root / "old#copy.sqlite3"
        create_database(source, [self.device])
        self.assertEqual(MIGRATION.device_count(source), 1)

    def test_apply_backs_up_and_is_idempotent(self) -> None:
        target = self.root / "current.sqlite3"
        source = self.root / "old.sqlite3"
        create_database(target, [])
        create_database(source, [self.device])
        result = MIGRATION.migrate(str(source), str(target), str(self.root), apply=True)
        self.assertEqual(result["status"], "migrated")
        self.assertEqual(result["added"], 1)
        self.assertIsNotNone(result["backup"])
        self.assertEqual(MIGRATION.device_count(target), 1)
        second = MIGRATION.migrate(str(source), str(target), str(self.root), apply=True)
        self.assertEqual(second["status"], "unchanged")
        self.assertEqual(second["added"], 0)
        self.assertEqual(second["unchanged"], 1)
        self.assertIsNone(second["backup"])
        with closing(sqlite3.connect(target)) as connection:
            self.assertEqual(connection.execute("SELECT action FROM device_audit").fetchall(), [("restored",)])

    def test_conflict_fails_before_backup_or_write(self) -> None:
        target = self.root / "current.sqlite3"
        source = self.root / "old.sqlite3"
        create_database(target, [self.device])
        conflicting = (*self.device[:2], "different-hash", *self.device[3:])
        create_database(source, [conflicting])
        with self.assertRaisesRegex(ValueError, "different credential data"):
            MIGRATION.migrate(str(source), str(target), str(self.root), apply=True)
        self.assertEqual(list(self.root.glob("*.backup.*")), [])
        with closing(sqlite3.connect(target)) as connection:
            self.assertEqual(connection.execute("SELECT secret_hash FROM devices").fetchone()[0], "hash-one")

    def test_paths_cannot_escape_data_root(self) -> None:
        outside = self.root.parent / "outside.sqlite3"
        with self.assertRaisesRegex(ValueError, "inside the data root"):
            MIGRATION.resolved_path(str(outside), str(self.root), existing=False)

    def test_inspect_rejects_an_incompatible_target(self) -> None:
        target = self.root / "current.sqlite3"
        with closing(sqlite3.connect(target)) as connection:
            connection.execute("CREATE TABLE devices (id TEXT PRIMARY KEY)")
            connection.commit()
        with self.assertRaisesRegex(ValueError, "incompatible devices schema"):
            MIGRATION.inspect_databases(str(target), str(self.root))

    def test_inspect_rejects_a_corrupt_historical_database(self) -> None:
        target = self.root / "current.sqlite3"
        create_database(target, [])
        (self.root / "corrupt.sqlite3").write_bytes(b"not a sqlite database")
        with self.assertRaisesRegex(ValueError, "corrupt.sqlite3 is unreadable"):
            MIGRATION.inspect_databases(str(target), str(self.root))

    def test_inspect_ignores_a_historical_database_without_device_schema(self) -> None:
        target = self.root / "current.sqlite3"
        legacy = self.root / "legacy.sqlite3"
        create_database(target, [])
        with closing(sqlite3.connect(legacy)) as connection:
            connection.execute("CREATE TABLE unrelated (id INTEGER)")
            connection.commit()
        self.assertEqual(MIGRATION.inspect_databases(str(target), str(self.root))["status"], "ok")


if __name__ == "__main__":
    unittest.main()
