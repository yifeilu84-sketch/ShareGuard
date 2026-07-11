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
