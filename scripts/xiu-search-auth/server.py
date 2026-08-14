#!/usr/bin/env python3
"""Minimal Xiu Search device credential and short-lived token service."""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import sqlite3
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import ProxyHandler, Request, build_opener


def env_required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


ISSUER = os.environ.get("XIU_AUTH_ISSUER", "https://search.jingran.vip/xiu-auth").rstrip("/")
AUDIENCE = "xiu-search"
JWT_SECRET = env_required("XIU_AUTH_JWT_SECRET")
ENROLLMENT_CODE = os.environ.get("XIU_AUTH_ENROLLMENT_CODE", "").strip()
ADMIN_TOKEN = env_required("XIU_AUTH_ADMIN_TOKEN")
LEGACY_TOKEN_HASH = os.environ.get("XIU_AUTH_LEGACY_TOKEN_SHA256", "").strip().lower()
TOKEN_TTL_SECONDS = max(300, min(int(os.environ.get("XIU_AUTH_TOKEN_TTL_SECONDS", "900")), 3600))
REQUESTS_PER_MINUTE = max(1, min(int(os.environ.get("XIU_AUTH_REQUESTS_PER_MINUTE", "20")), 600))
REQUESTS_PER_IP_PER_MINUTE = max(1, min(int(os.environ.get("XIU_AUTH_REQUESTS_PER_IP_PER_MINUTE", "60")), 1200))
PUBLIC_REGISTRATION = os.environ.get("XIU_AUTH_PUBLIC_REGISTRATION", "false").strip().lower() in {"1", "true", "yes"}
REGISTRATIONS_PER_IP_PER_DAY = max(1, min(int(os.environ.get("XIU_AUTH_REGISTRATIONS_PER_IP_PER_DAY", "5")), 100))
DATABASE_PATH = os.environ.get("XIU_AUTH_DATABASE", "/data/xiu-search-auth.sqlite3")
LISTEN_HOST = os.environ.get("XIU_AUTH_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("XIU_AUTH_PORT", "8787"))
UPSTREAM_URL = os.environ.get("XIU_AUTH_UPSTREAM_URL", "http://127.0.0.1:8080").rstrip("/")
UPSTREAM_TIMEOUT_SECONDS = max(5, min(int(os.environ.get("XIU_AUTH_UPSTREAM_TIMEOUT_SECONDS", "60")), 120))
TRUSTED_REGISTER_NETWORKS = tuple(
    ipaddress.ip_network(item.strip(), strict=False)
    for item in os.environ.get("XIU_AUTH_TRUSTED_REGISTER_CIDRS", "").replace(";", ",").split(",")
    if item.strip()
)

DB_LOCK = threading.Lock()
RATE_LOCK = threading.Lock()
RATE_BUCKETS: dict[tuple[str, int], int] = {}


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def issue_token(device_id: str) -> tuple[str, int]:
    now = int(time.time())
    expires_at = now + TOKEN_TTL_SECONDS
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps({
        "iss": ISSUER,
        "sub": device_id,
        "aud": AUDIENCE,
        "scope": "search:read",
        "iat": now,
        "exp": expires_at,
        "jti": uuid.uuid4().hex,
    }, separators=(",", ":")).encode())
    signing_input = f"{header}.{payload}"
    signature = b64url(hmac.new(JWT_SECRET.encode(), signing_input.encode(), hashlib.sha256).digest())
    return f"{signing_input}.{signature}", expires_at


def verify_token(token: str) -> dict[str, object] | None:
    if LEGACY_TOKEN_HASH and hmac.compare_digest(digest(token), LEGACY_TOKEN_HASH):
        return {"sub": "legacy", "scope": "search:read", "legacy": True}
    try:
        header, payload, signature = token.split(".")
        signing_input = f"{header}.{payload}"
        expected = b64url(hmac.new(JWT_SECRET.encode(), signing_input.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            return None
        claims = json.loads(b64url_decode(payload))
        if claims.get("iss") != ISSUER or claims.get("aud") != AUDIENCE:
            return None
        if claims.get("scope") != "search:read" or int(claims.get("exp", 0)) <= int(time.time()):
            return None
        return claims
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


def db_connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


@contextmanager
def database():
    connection = db_connect()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_database() -> None:
    os.makedirs(os.path.dirname(DATABASE_PATH) or ".", exist_ok=True)
    with DB_LOCK, database() as db:
        # DELETE mode works on bind mounts and older CentOS/overlay filesystems
        # where WAL shared-memory files can fail with SQLITE_IOERR.
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute("PRAGMA synchronous=NORMAL")
        db.execute("""
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
        db.execute("""
            CREATE TABLE IF NOT EXISTS device_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                action TEXT NOT NULL,
                occurred_at INTEGER NOT NULL,
                request_id TEXT NOT NULL
            )
        """)


def register_device(name: str, client_ip: str) -> tuple[str, str]:
    device_id = f"device_{uuid.uuid4().hex}"
    device_secret = secrets.token_urlsafe(48)
    now = int(time.time())
    with DB_LOCK, database() as db:
        db.execute(
            "INSERT INTO devices (id, name, secret_hash, created_at, last_seen_at, last_ip) VALUES (?, ?, ?, ?, ?, ?)",
            (device_id, name[:100], digest(device_secret), now, now, client_ip),
        )
    return device_id, device_secret


def record_device_audit(device_id: str, action: str, request_id: str) -> None:
    with DB_LOCK, database() as db:
        db.execute(
            "INSERT INTO device_audit (device_id, action, occurred_at, request_id) VALUES (?, ?, ?, ?)",
            (device_id, action, int(time.time()), request_id),
        )


def iso_time(value: int | None) -> str | None:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(value)) if value is not None else None


def authenticate_device(device_id: str, device_secret: str, client_ip: str) -> bool:
    with DB_LOCK, database() as db:
        row = db.execute("SELECT secret_hash, revoked_at FROM devices WHERE id = ?", (device_id,)).fetchone()
        if not row or row["revoked_at"] is not None:
            return False
        if not hmac.compare_digest(row["secret_hash"], digest(device_secret)):
            return False
        db.execute(
            "UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?",
            (int(time.time()), client_ip, device_id),
        )
        return True


def active_device(device_id: str) -> bool:
    if device_id == "legacy":
        return True
    with DB_LOCK, database() as db:
        row = db.execute("SELECT revoked_at FROM devices WHERE id = ?", (device_id,)).fetchone()
        return bool(row and row["revoked_at"] is None)


def rate_allowed(device_id: str, limit: int = REQUESTS_PER_MINUTE) -> bool:
    minute = int(time.time()) // 60
    key = (device_id, minute)
    with RATE_LOCK:
        stale = [candidate for candidate in RATE_BUCKETS if candidate[1] < minute - 1]
        for candidate in stale:
            RATE_BUCKETS.pop(candidate, None)
        count = RATE_BUCKETS.get(key, 0) + 1
        RATE_BUCKETS[key] = count
        return count <= limit


def registration_allowed(client_ip: str, enrollment_code: str) -> bool:
    if PUBLIC_REGISTRATION:
        return True
    if ENROLLMENT_CODE and hmac.compare_digest(enrollment_code, ENROLLMENT_CODE):
        return True
    try:
        address = ipaddress.ip_address(client_ip)
        return any(address in network for network in TRUSTED_REGISTER_NETWORKS)
    except ValueError:
        return False


def registration_quota_allowed(client_ip: str) -> bool:
    since = int(time.time()) - 86_400
    with DB_LOCK, database() as db:
        count = db.execute(
            "SELECT COUNT(*) FROM devices WHERE last_ip = ? AND created_at >= ?",
            (client_ip, since),
        ).fetchone()[0]
    return int(count) < REGISTRATIONS_PER_IP_PER_DAY


class Handler(BaseHTTPRequestHandler):
    server_version = "XiuSearchAuth/1.0"

    def log_message(self, message: str, *args: object) -> None:
        print(json.dumps({"time": int(time.time()), "ip": self.client_ip(), "message": message % args}, ensure_ascii=False), flush=True)

    def client_ip(self) -> str:
        # The container port is bound to 127.0.0.1 and only the local Nginx proxy can set this header.
        forwarded = self.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
        return forwarded or self.client_address[0]

    def send_json(self, status: int, payload: dict[str, object], request_id: str | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("X-Request-Id", request_id or self.request_id())
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def request_id(self) -> str:
        return uuid.uuid4().hex

    def read_json(self) -> dict[str, object] | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 2 or length > 16_384:
                return None
            value = json.loads(self.rfile.read(length))
            return value if isinstance(value, dict) else None
        except (ValueError, json.JSONDecodeError):
            return None

    def bearer(self) -> str:
        value = self.headers.get("Authorization", "")
        return value[7:].strip() if value.startswith("Bearer ") else ""

    def admin_allowed(self) -> bool:
        return bool(self.bearer() and hmac.compare_digest(self.bearer(), ADMIN_TOKEN))

    def search_claims(self) -> tuple[dict[str, object] | None, str]:
        claims = verify_token(self.bearer())
        device_id = str(claims.get("sub", "")) if claims else ""
        if not claims or not active_device(device_id):
            return None, device_id
        return claims, device_id

    def proxy_search(self) -> None:
        claims, device_id = self.search_claims()
        if not claims:
            self.send_json(401, {"error": "invalid_token"})
            return
        if not rate_allowed(device_id) or not rate_allowed(f"search-ip:{self.client_ip()}", REQUESTS_PER_IP_PER_MINUTE):
            self.send_json(429, {"error": "rate_limited"})
            return

        parsed = urlparse(self.path)
        target = f"{UPSTREAM_URL}{parsed.path or '/'}"
        if parsed.query:
            target += f"?{parsed.query}"

        body = None
        if self.command in {"POST", "PUT", "PATCH"}:
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = -1
            if length < 0 or length > 1_048_576:
                self.send_json(413, {"error": "request_too_large"})
                return
            body = self.rfile.read(length) if length else None

        forwarded_headers = {
            "Accept": self.headers.get("Accept", "*/*"),
            "Accept-Language": self.headers.get("Accept-Language", ""),
            "Content-Type": self.headers.get("Content-Type", ""),
            "User-Agent": self.headers.get("User-Agent", "XiuSearchGateway/1.0"),
            "X-Forwarded-For": self.client_ip(),
            "X-Forwarded-Proto": "https",
        }
        forwarded_headers = {key: value for key, value in forwarded_headers.items() if value}
        request = Request(target, data=body, headers=forwarded_headers, method=self.command)
        opener = build_opener(ProxyHandler({}))

        try:
            response = opener.open(request, timeout=UPSTREAM_TIMEOUT_SECONDS)
        except HTTPError as error:
            response = error
        except (URLError, TimeoutError, OSError):
            self.send_json(502, {"error": "search_upstream_unavailable"})
            return

        try:
            content = b"" if self.command == "HEAD" else response.read(8_388_609)
            if len(content) > 8_388_608:
                self.send_json(502, {"error": "search_response_too_large"})
                return
            self.send_response(response.status)
            for name in ("Content-Type", "Content-Encoding", "Cache-Control", "ETag", "Last-Modified", "Location"):
                value = response.headers.get(name)
                if value:
                    self.send_header(name, value)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if content:
                self.wfile.write(content)
        finally:
            response.close()

    def do_GET(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path == "/healthz":
            self.send_json(200, {
                "status": "ok",
                "publicRegistration": PUBLIC_REGISTRATION,
                "registrationLimitPerIpPerDay": REGISTRATIONS_PER_IP_PER_DAY,
            })
            return
        if path == "/v1/tokens/verify":
            claims = verify_token(self.bearer())
            device_id = str(claims.get("sub", "")) if claims else ""
            if not claims or not active_device(device_id):
                self.send_json(401, {"error": "invalid_token"})
                return
            if not rate_allowed(device_id) or not rate_allowed(f"search-ip:{self.client_ip()}", REQUESTS_PER_IP_PER_MINUTE):
                # Nginx auth_request treats only 2xx, 401, and 403 as valid auth responses.
                self.send_json(403, {"error": "rate_limited"})
                return
            self.send_response(204)
            self.send_header("X-Xiu-Device", device_id)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        if path == "/v1/devices":
            claims, device_id = self.search_claims()
            if not claims:
                self.send_json(401, {"error": "invalid_token"})
                return
            if not rate_allowed(f"devices:{device_id}") or not rate_allowed(f"devices-ip:{self.client_ip()}", REQUESTS_PER_IP_PER_MINUTE):
                self.send_json(429, {"error": "rate_limited"})
                return
            request_id = self.request_id()
            with DB_LOCK, database() as db:
                row = db.execute(
                    "SELECT id, created_at, last_seen_at, revoked_at FROM devices WHERE id = ?",
                    (device_id,),
                ).fetchone()
                events = db.execute(
                    "SELECT action, occurred_at, device_id, request_id FROM device_audit WHERE device_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 100",
                    (device_id,),
                ).fetchall()
            if not row:
                self.send_json(401, {"error": "invalid_token"})
                return
            self.send_json(200, {
                "currentDeviceId": row["id"],
                "requestId": request_id,
                "devices": [{
                    "id": row["id"],
                    "status": "revoked" if row["revoked_at"] is not None else "active",
                    "createdAt": iso_time(row["created_at"]),
                    "lastSeenAt": iso_time(row["last_seen_at"]),
                    **({"revokedAt": iso_time(row["revoked_at"])} if row["revoked_at"] is not None else {}),
                }],
                "audit": [
                    {"action": event["action"], "deviceId": event["device_id"], "occurredAt": iso_time(event["occurred_at"]), "requestId": event["request_id"]}
                    for event in events
                ],
            })
            return
        if path == "/v1/admin/devices":
            if not self.admin_allowed():
                self.send_json(401, {"error": "unauthorized"})
                return
            with DB_LOCK, database() as db:
                rows = db.execute(
                    "SELECT id, name, created_at, last_seen_at, last_ip, revoked_at FROM devices ORDER BY created_at DESC LIMIT 500"
                ).fetchall()
            self.send_json(200, {"devices": [dict(row) for row in rows]})
            return
        self.proxy_search()

    def do_HEAD(self) -> None:
        self.proxy_search()

    def do_POST(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path == "/v1/devices/register":
            payload = self.read_json()
            if not payload:
                self.send_json(400, {"error": "invalid_request"})
                return
            code = self.headers.get("X-Xiu-Enrollment", "")
            if not registration_allowed(self.client_ip(), code):
                self.send_json(403, {"error": "registration_not_allowed"})
                return
            if not rate_allowed(f"register:{self.client_ip()}"):
                self.send_json(429, {"error": "rate_limited"})
                return
            if not registration_quota_allowed(self.client_ip()):
                self.send_json(429, {"error": "registration_quota_exceeded"})
                return
            name = str(payload.get("name", "")).strip()
            if not name:
                self.send_json(400, {"error": "device_name_required"})
                return
            device_id, device_secret = register_device(name, self.client_ip())
            request_id = self.request_id()
            record_device_audit(device_id, "registered", request_id)
            self.send_json(201, {"deviceId": device_id, "deviceSecret": device_secret}, request_id=request_id)
            return
        if path == "/v1/tokens":
            payload = self.read_json()
            if not payload:
                self.send_json(400, {"error": "invalid_request"})
                return
            device_id = str(payload.get("deviceId", ""))
            device_secret = str(payload.get("deviceSecret", ""))
            if not authenticate_device(device_id, device_secret, self.client_ip()):
                self.send_json(401, {"error": "invalid_device_credential"})
                return
            if not rate_allowed(f"token:{device_id}"):
                self.send_json(429, {"error": "rate_limited"})
                return
            token, expires_at = issue_token(device_id)
            self.send_json(200, {"accessToken": token, "tokenType": "Bearer", "expiresAt": expires_at})
            return
        if path.startswith("/v1/admin/devices/") and path.endswith("/revoke"):
            if not self.admin_allowed():
                self.send_json(401, {"error": "unauthorized"})
                return
            device_id = path.removeprefix("/v1/admin/devices/").removesuffix("/revoke").strip("/")
            with DB_LOCK, database() as db:
                result = db.execute("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", (int(time.time()), device_id))
            if result.rowcount != 1:
                self.send_json(404, {"error": "active_device_not_found"})
                return
            request_id = self.request_id()
            record_device_audit(device_id, "revoked", request_id)
            self.send_json(200, {"revoked": True, "deviceId": device_id}, request_id=request_id)
            return
        self.proxy_search()


def self_test() -> None:
    token, expires_at = issue_token("device_test")
    claims = verify_token(token)
    assert claims and claims["sub"] == "device_test" and expires_at > int(time.time())
    assert verify_token(token + "x") is None
    assert registration_allowed("203.0.113.10", ENROLLMENT_CODE) is bool(PUBLIC_REGISTRATION or ENROLLMENT_CODE)
    print("xiu-search-auth self-test passed")


def integration_self_test() -> None:
    global UPSTREAM_URL

    class MockSearchHandler(BaseHTTPRequestHandler):
        def log_message(self, _message: str, *_args: object) -> None:
            return

        def do_GET(self) -> None:
            body = json.dumps({"query": urlparse(self.path).query, "ok": True}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    upstream = ThreadingHTTPServer(("127.0.0.1", 0), MockSearchHandler)
    upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
    upstream_thread.start()
    previous_upstream = UPSTREAM_URL
    UPSTREAM_URL = f"http://127.0.0.1:{upstream.server_port}"

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    opener = build_opener(ProxyHandler({}))

    def request(method: str, path: str, payload: dict[str, object] | None = None, headers: dict[str, str] | None = None):
        body = json.dumps(payload).encode() if payload is not None else None
        request_headers = {"Content-Type": "application/json", **(headers or {})}
        with opener.open(Request(base_url + path, data=body, headers=request_headers, method=method), timeout=3) as response:
            content = response.read()
            return response.status, json.loads(content) if content else None

    try:
        status, health = request("GET", "/healthz")
        assert status == 200 and health["status"] == "ok"
        status, registered = request("POST", "/v1/devices/register", {"name": "integration test"}, {"X-Xiu-Enrollment": ENROLLMENT_CODE})
        assert status == 201 and registered
        status, issued = request("POST", "/v1/tokens", {
            "deviceId": registered["deviceId"],
            "deviceSecret": registered["deviceSecret"],
        })
        assert status == 200 and issued
        access_header = {"Authorization": f"Bearer {issued['accessToken']}"}
        status, _ = request("GET", "/v1/tokens/verify", headers=access_header)
        assert status == 204
        try:
            request("GET", "/search?q=blocked")
            raise AssertionError("search without a token was accepted")
        except HTTPError as error:
            assert error.code == 401
        status, search_result = request("GET", "/search?q=xiu", headers=access_header)
        assert status == 200 and search_result == {"query": "q=xiu", "ok": True}
        status, observed = request("GET", "/v1/devices", headers=access_header)
        assert status == 200 and observed["currentDeviceId"] == registered["deviceId"]
        assert observed["devices"][0]["status"] == "active"
        assert observed["audit"][0]["action"] == "registered"
        admin_header = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
        status, devices = request("GET", "/v1/admin/devices", headers=admin_header)
        assert status == 200 and len(devices["devices"]) == 1
        status, revoked = request("POST", f"/v1/admin/devices/{registered['deviceId']}/revoke", headers=admin_header)
        assert status == 200 and revoked["revoked"] is True
        try:
            request("GET", "/v1/tokens/verify", headers=access_header)
            raise AssertionError("revoked token was accepted")
        except HTTPError as error:
            assert error.code == 401
        print("xiu-search-auth HTTP integration self-test passed")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
        upstream.shutdown()
        upstream.server_close()
        upstream_thread.join(timeout=3)
        UPSTREAM_URL = previous_upstream


if __name__ == "__main__":
    initialize_database()
    if "--integration-self-test" in sys.argv:
        integration_self_test()
        raise SystemExit(0)
    if "--self-test" in sys.argv:
        self_test()
        raise SystemExit(0)
    print(f"Xiu Search Auth listening on {LISTEN_HOST}:{LISTEN_PORT}", flush=True)
    ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler).serve_forever()
