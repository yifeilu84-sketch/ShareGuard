import base64
import hashlib
import hmac
import http.client
import io
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

from shareguard.platform.app import BoundedThreadingHTTPServer, make_handler
from shareguard.platform.backends import MockDetectorBackend
from shareguard.platform.config import PlatformConfig


def png_bytes(size=(16, 12)):
    buf = io.BytesIO()
    Image.new("RGB", size, color=(120, 80, 40)).save(buf, format="PNG")
    return buf.getvalue()


def edge_headers(
    secret="edge-secret",
    client_id="b" * 64,
    method="POST",
    path="/v1/analyze",
    timestamp=None,
):
    timestamp = int(time.time()) if timestamp is None else timestamp
    canonical = f"{timestamp}\n{method}\n{path}\n{client_id}"
    signature = hmac.new(
        secret.encode("utf-8"),
        canonical.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {
        "X-ShareGuard-Client-Id": client_id,
        "X-ShareGuard-Edge-Timestamp": str(timestamp),
        "X-ShareGuard-Edge-Signature": signature,
    }


class FailingBackend:
    name = "private-failing"

    def analyze(self, image, filename="image"):
        raise RuntimeError("C:/private/model/path and threshold=0.456")


class PlatformHttpTests(unittest.TestCase):
    def setUp(self):
        self.servers = []
        self.config = PlatformConfig(
            api_token="test-token",
            allowed_origins=("https://pilot.example",),
            max_upload_bytes=1024 * 1024,
        )
        self.server = self.start_server(MockDetectorBackend(), self.config)

    def tearDown(self):
        for server, thread in self.servers:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

    def start_server(self, backend, config):
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            make_handler(backend, config=config),
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.servers.append((server, thread))
        return server

    def request(self, method, path, body=None, headers=None, server=None):
        target = server or self.server
        connection = http.client.HTTPConnection(
            "127.0.0.1",
            target.server_address[1],
            timeout=5,
        )
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        response_headers = {key: value for key, value in response.getheaders()}
        connection.close()
        payload = json.loads(raw.decode("utf-8")) if raw else None
        return response.status, payload, response_headers

    def auth_headers(self, **extra):
        return {"Authorization": "Bearer test-token", **extra}

    def basic_headers(self, username, password, **extra):
        encoded = base64.b64encode(
            f"{username}:{password}".encode("utf-8")
        ).decode("ascii")
        return {"Authorization": f"Basic {encoded}", **extra}

    def test_v1_health_does_not_require_auth_or_expose_backend(self):
        status, payload, _ = self.request("GET", "/v1/health")

        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "ok")
        self.assertTrue(payload["request_id"].startswith("sg_req_"))
        self.assertNotIn("backend", payload)

    def test_v1_ready_uses_product_level_response(self):
        status, payload, _ = self.request("GET", "/v1/ready")

        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "ready")
        self.assertNotIn("backend", payload)

    def test_v1_analyze_requires_configured_bearer_token(self):
        status, payload, _ = self.request(
            "POST",
            "/v1/analyze",
            headers={"Content-Type": "image/png"},
        )

        self.assertEqual(status, 401)
        self.assertEqual(payload["error"]["code"], "unauthorized")
        self.assertTrue(payload["request_id"].startswith("sg_req_"))

    def test_http_basic_gate_protects_static_page_health_and_analysis(self):
        config = PlatformConfig(
            http_basic_username="shareguard-demo",
            http_basic_password="correct-horse-battery-staple",
            max_upload_bytes=1024 * 1024,
        )
        server = self.start_server(MockDetectorBackend(), config)

        page_status, page_payload, page_headers = self.request(
            "GET",
            "/",
            server=server,
        )
        malformed_status, _, _ = self.request(
            "GET",
            "/v1/health",
            headers={"Authorization": "Basic not-base64!"},
            server=server,
        )
        health_status, _, _ = self.request(
            "GET",
            "/v1/health",
            headers=self.basic_headers(
                "shareguard-demo",
                "correct-horse-battery-staple",
            ),
            server=server,
        )
        analyze_status, _, _ = self.request(
            "POST",
            "/v1/analyze",
            body=png_bytes(),
            headers=self.basic_headers(
                "shareguard-demo",
                "correct-horse-battery-staple",
                **{"Content-Type": "image/png"},
            ),
            server=server,
        )

        self.assertEqual(page_status, 401)
        self.assertEqual(
            page_payload["error"]["code"],
            "authentication_required",
        )
        self.assertIn("Basic", page_headers["WWW-Authenticate"])
        self.assertEqual(malformed_status, 401)
        self.assertEqual(health_status, 200)
        self.assertEqual(analyze_status, 200)

    def test_access_identity_can_be_required(self):
        config = PlatformConfig(
            require_access_identity=True,
            max_upload_bytes=1024 * 1024,
        )
        server = self.start_server(MockDetectorBackend(), config)

        missing_status, missing_payload, _ = self.request(
            "POST",
            "/v1/analyze",
            body=png_bytes(),
            headers={"Content-Type": "image/png"},
            server=server,
        )
        allowed_status, _, _ = self.request(
            "POST",
            "/v1/analyze",
            body=png_bytes(),
            headers={
                "Content-Type": "image/png",
                "Cf-Access-Authenticated-User-Email": "judge@example.com",
            },
            server=server,
        )

        self.assertEqual(missing_status, 401)
        self.assertEqual(
            missing_payload["error"]["code"],
            "access_identity_required",
        )
        self.assertEqual(allowed_status, 200)

    def test_per_identity_rate_limit_returns_retry_after(self):
        config = PlatformConfig(
            require_access_identity=True,
            rate_limit_per_minute=1,
            max_upload_bytes=1024 * 1024,
        )
        server = self.start_server(MockDetectorBackend(), config)
        headers = {
            "Content-Type": "image/png",
            "Cf-Access-Authenticated-User-Email": "judge@example.com",
        }

        first_status, _, _ = self.request(
            "POST",
            "/v1/analyze",
            body=png_bytes(),
            headers=headers,
            server=server,
        )
        second_status, payload, response_headers = self.request(
            "POST",
            "/v1/analyze",
            body=png_bytes(),
            headers=headers,
            server=server,
        )

        self.assertEqual(first_status, 200)
        self.assertEqual(second_status, 429)
        self.assertEqual(payload["error"]["code"], "rate_limited")
        self.assertGreaterEqual(int(response_headers["Retry-After"]), 1)

    def test_edge_identity_requires_shared_secret_and_opaque_client_id(self):
        config = PlatformConfig(
            edge_shared_secret="edge-secret",
            max_upload_bytes=1024 * 1024,
        )
        server = self.start_server(MockDetectorBackend(), config)
        base_headers = {"Content-Type": "image/png"}

        missing_status, missing_payload, _ = self.request(
            "POST",
            "/v1/analyze",
            body=png_bytes(),
            headers=base_headers,
            server=server,
        )
        spoofed_status, spoofed_payload, _ = self.request(
            "POST",
            "/v1/analyze",
            body=png_bytes(),
            headers={
                **base_headers,
                **edge_headers(secret="wrong-secret"),
            },
            server=server,
        )
        invalid_status, invalid_payload, _ = self.request(
            "POST",
            "/v1/analyze",
            body=png_bytes(),
            headers={
                **base_headers,
                **edge_headers(client_id="not-a-digest"),
            },
            server=server,
        )
        allowed_status, _, _ = self.request(
            "POST",
            "/v1/analyze",
            body=png_bytes(),
            headers={
                **base_headers,
                **edge_headers(),
            },
            server=server,
        )

        self.assertEqual(missing_status, 401)
        self.assertEqual(missing_payload["error"]["code"], "edge_identity_required")
        self.assertEqual(spoofed_status, 401)
        self.assertEqual(spoofed_payload["error"]["code"], "invalid_edge_identity")
        self.assertEqual(invalid_status, 401)
        self.assertEqual(invalid_payload["error"]["code"], "invalid_edge_identity")
        self.assertEqual(allowed_status, 200)

    def test_edge_identity_protects_readiness_endpoint(self):
        config = PlatformConfig(
            edge_shared_secret="edge-secret",
            max_upload_bytes=1024 * 1024,
        )
        server = self.start_server(MockDetectorBackend(), config)

        missing_status, missing_payload, _ = self.request(
            "GET",
            "/v1/ready",
            server=server,
        )
        allowed_status, allowed_payload, _ = self.request(
            "GET",
            "/v1/ready",
            headers=edge_headers(
                client_id="c" * 64,
                method="GET",
                path="/v1/ready",
            ),
            server=server,
        )

        self.assertEqual(missing_status, 401)
        self.assertEqual(
            missing_payload["error"]["code"],
            "edge_identity_required",
        )
        self.assertEqual(allowed_status, 200)
        self.assertEqual(allowed_payload["status"], "ready")

    def test_edge_identity_rejects_stale_or_path_mismatched_signatures(self):
        config = PlatformConfig(
            edge_shared_secret="edge-secret",
            max_upload_bytes=1024 * 1024,
        )
        server = self.start_server(MockDetectorBackend(), config)

        stale_status, stale_payload, _ = self.request(
            "GET",
            "/v1/ready",
            headers=edge_headers(
                method="GET",
                path="/v1/ready",
                timestamp=int(time.time()) - 600,
            ),
            server=server,
        )
        mismatched_status, mismatched_payload, _ = self.request(
            "GET",
            "/v1/ready",
            headers=edge_headers(method="GET", path="/v1/health"),
            server=server,
        )

        self.assertEqual(stale_status, 401)
        self.assertEqual(stale_payload["error"]["code"], "invalid_edge_identity")
        self.assertEqual(mismatched_status, 401)
        self.assertEqual(
            mismatched_payload["error"]["code"],
            "invalid_edge_identity",
        )

    def test_v1_analyze_returns_sanitized_product_contract(self):
        status, payload, _ = self.request(
            "POST",
            "/v1/analyze",
            body=png_bytes(),
            headers=self.auth_headers(
                **{"Content-Type": "image/png", "X-File-Name": "case.png"}
            ),
        )

        self.assertEqual(status, 200)
        self.assertIn(payload["decision"], {"allow", "review", "hold"})
        self.assertIn("ai_probability", payload)
        self.assertIn("report", payload)
        self.assertNotIn("raw", payload)
        self.assertNotIn("backend", payload)

    def test_legacy_analyze_uses_same_service_and_marks_deprecation(self):
        status, payload, headers = self.request(
            "POST",
            "/api/analyze",
            body=png_bytes(),
            headers=self.auth_headers(
                **{"Content-Type": "image/png", "X-File-Name": "case.png"}
            ),
        )

        self.assertEqual(status, 200)
        self.assertIn("probability_ai_generated", payload)
        self.assertEqual(payload["backend"], "private-model-api")
        self.assertEqual(headers.get("Deprecation"), "true")
        self.assertEqual(headers.get("X-ShareGuard-Demo"), "true")

    def test_oversized_content_length_is_rejected_before_analysis(self):
        config = PlatformConfig(api_token="test-token", max_upload_bytes=8)
        server = self.start_server(MockDetectorBackend(), config)

        status, payload, _ = self.request(
            "POST",
            "/v1/analyze",
            headers=self.auth_headers(**{
                "Content-Type": "image/png",
                "Content-Length": "9",
            }),
            server=server,
        )

        self.assertEqual(status, 413)
        self.assertEqual(payload["error"]["code"], "payload_too_large")

    def test_cors_header_is_only_returned_for_exact_allowlist_origin(self):
        allowed_status, _, allowed_headers = self.request(
            "GET",
            "/v1/health",
            headers={"Origin": "https://pilot.example"},
        )
        blocked_status, _, blocked_headers = self.request(
            "GET",
            "/v1/health",
            headers={"Origin": "https://pilot.example.evil"},
        )

        self.assertEqual(allowed_status, 200)
        self.assertEqual(
            allowed_headers.get("Access-Control-Allow-Origin"),
            "https://pilot.example",
        )
        self.assertEqual(blocked_status, 200)
        self.assertNotIn("Access-Control-Allow-Origin", blocked_headers)

    def test_disallowed_cors_preflight_is_rejected(self):
        status, payload, _ = self.request(
            "OPTIONS",
            "/v1/analyze",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
            },
        )

        self.assertEqual(status, 403)
        self.assertEqual(payload["error"]["code"], "origin_not_allowed")

    def test_allowed_cors_preflight_does_not_require_basic_auth(self):
        config = PlatformConfig(
            allowed_origins=("https://yifeilu84-sketch.github.io",),
            http_basic_username="shareguard-demo",
            http_basic_password="correct-horse-battery-staple",
        )
        server = self.start_server(MockDetectorBackend(), config)

        status, payload, headers = self.request(
            "OPTIONS",
            "/v1/analyze",
            headers={
                "Origin": "https://yifeilu84-sketch.github.io",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": (
                    "authorization, content-type, accept-language"
                ),
            },
            server=server,
        )

        self.assertEqual(status, 204)
        self.assertIsNone(payload)
        self.assertNotIn("WWW-Authenticate", headers)
        self.assertEqual(
            headers.get("Access-Control-Allow-Origin"),
            "https://yifeilu84-sketch.github.io",
        )
        self.assertIn(
            "Authorization",
            headers.get("Access-Control-Allow-Headers", ""),
        )
        self.assertIn(
            "Accept-Language",
            headers.get("Access-Control-Allow-Headers", ""),
        )

    def test_preflight_rejects_unapproved_headers_and_routes(self):
        header_status, header_payload, _ = self.request(
            "OPTIONS",
            "/v1/analyze",
            headers={
                "Origin": "https://pilot.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "x-private-debug",
            },
        )
        route_status, route_payload, _ = self.request(
            "OPTIONS",
            "/admin",
            headers={
                "Origin": "https://pilot.example",
                "Access-Control-Request-Method": "GET",
            },
        )

        self.assertEqual(header_status, 403)
        self.assertEqual(
            header_payload["error"]["code"],
            "preflight_headers_not_allowed",
        )
        self.assertEqual(route_status, 405)
        self.assertEqual(
            route_payload["error"]["code"],
            "preflight_not_allowed",
        )

    def test_security_headers_are_present(self):
        _, _, headers = self.request("GET", "/v1/health")

        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(headers.get("Referrer-Policy"), "no-referrer")
        self.assertIn("default-src 'self'", headers.get("Content-Security-Policy", ""))
        self.assertIn("worker-src 'self'", headers.get("Content-Security-Policy", ""))

    def test_flagship_visual_asset_is_served_locally(self):
        connection = http.client.HTTPConnection(
            "127.0.0.1",
            self.server.server_address[1],
            timeout=5,
        )
        connection.request("GET", "/assets/flagship-event.jpg")
        response = connection.getresponse()
        raw = response.read()
        content_type = response.getheader("Content-Type")
        connection.close()

        self.assertEqual(response.status, 200)
        self.assertEqual(content_type, "image/jpeg")
        self.assertGreater(len(raw), 10_000)

    def test_dossier_static_assets_and_verifier_are_served_locally(self):
        expected = {
            "/dossier.css": "text/css; charset=utf-8",
            "/dossier.js": "application/javascript; charset=utf-8",
            "/i18n.js": "application/javascript; charset=utf-8",
            "/runtime-config.js": "application/javascript; charset=utf-8",
            "/crypto-worker.js": "application/javascript; charset=utf-8",
            "/verifier.html": "text/html; charset=utf-8",
            "/verifier.js": "application/javascript; charset=utf-8",
        }

        for path, expected_type in expected.items():
            connection = http.client.HTTPConnection(
                "127.0.0.1",
                self.server.server_address[1],
                timeout=5,
            )
            connection.request("GET", path)
            response = connection.getresponse()
            raw = response.read()
            content_type = response.getheader("Content-Type")
            connection.close()

            self.assertEqual(response.status, 200, path)
            self.assertEqual(content_type, expected_type, path)
            self.assertGreater(len(raw), 100, path)

    def test_internal_error_does_not_expose_exception_or_backend(self):
        server = self.start_server(FailingBackend(), self.config)

        status, payload, _ = self.request(
            "POST",
            "/v1/analyze",
            body=png_bytes(),
            headers=self.auth_headers(**{"Content-Type": "image/png"}),
            server=server,
        )
        serialized = json.dumps(payload)

        self.assertEqual(status, 500)
        self.assertEqual(payload["error"]["code"], "internal_error")
        self.assertNotIn("C:/private", serialized)
        self.assertNotIn("threshold", serialized)
        self.assertNotIn("private-failing", serialized)

    def test_bounded_http_server_limits_active_request_threads(self):
        lock = threading.Lock()
        entered = threading.Event()
        release = threading.Event()
        state = {"active": 0, "max_active": 0}

        class BlockingHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                with lock:
                    state["active"] += 1
                    state["max_active"] = max(
                        state["max_active"],
                        state["active"],
                    )
                entered.set()
                try:
                    release.wait(timeout=5)
                    body = b"ok"
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                finally:
                    with lock:
                        state["active"] -= 1

            def log_message(self, fmt, *args):
                return

        server = BoundedThreadingHTTPServer(
            ("127.0.0.1", 0),
            BlockingHandler,
            max_workers=1,
        )
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        statuses = []
        errors = []

        def request_once():
            try:
                connection = http.client.HTTPConnection(
                    "127.0.0.1",
                    server.server_address[1],
                    timeout=5,
                )
                connection.request("GET", "/")
                response = connection.getresponse()
                response.read()
                statuses.append(response.status)
                connection.close()
            except Exception as exc:
                errors.append(exc)

        first = threading.Thread(target=request_once, daemon=True)
        second = threading.Thread(target=request_once, daemon=True)
        try:
            first.start()
            self.assertTrue(entered.wait(timeout=2))
            second.start()
            time.sleep(0.1)
            with lock:
                self.assertEqual(state["active"], 1)
                self.assertEqual(state["max_active"], 1)
            release.set()
            first.join(timeout=3)
            second.join(timeout=3)
            self.assertEqual(errors, [])
            self.assertEqual(sorted(statuses), [200, 200])
            self.assertEqual(state["max_active"], 1)
        finally:
            release.set()
            server.shutdown()
            server_thread.join(timeout=5)
            server.server_close()


if __name__ == "__main__":
    unittest.main()
