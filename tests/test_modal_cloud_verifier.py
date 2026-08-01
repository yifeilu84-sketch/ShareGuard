import contextlib
import io
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from scripts.modal.verify_cloud_endpoint import verify_endpoint


ROOT = Path(__file__).resolve().parents[1]


class VerificationHandler(BaseHTTPRequestHandler):
    expected_auth = "Basic dmVyaWZpZXI6Y29ycmVjdC1ob3JzZS1iYXR0ZXJ5LXN0YXBsZQ=="
    records = []
    expose_private_key = False

    def log_message(self, _format, *_args):
        return

    def record(self, body=b""):
        self.__class__.records.append({
            "path": self.path,
            "authorization": self.headers.get("Authorization"),
            "origin": self.headers.get("Origin"),
            "filename": self.headers.get("X-File-Name"),
            "body": body,
        })

    def send_json(self, status, payload):
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        self.record()
        if self.path != "/v1/ready":
            self.send_json(404, {"error": {"code": "not_found"}})
            return
        if self.headers.get("Authorization") != self.expected_auth:
            self.send_json(401, {"error": {"code": "authentication_required"}})
            return
        self.send_json(200, {
            "status": "ready",
            "model_version": "shareguard-private-v1",
        })

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        self.record(body)
        if self.path != "/v1/analyze":
            self.send_json(404, {"error": {"code": "not_found"}})
            return
        payload = {
            "model_version": "shareguard-private-v1",
            "decision": "suspend",
            "risk_level": "high",
        }
        if self.expose_private_key:
            payload["report"] = {"raw": {"checkpoint": "private/model.pt"}}
        self.send_json(200, payload)


class ModalCloudVerifierTests(unittest.TestCase):
    def setUp(self):
        VerificationHandler.records = []
        VerificationHandler.expose_private_key = False
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), VerificationHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"
        self.temp_dir = tempfile.TemporaryDirectory()
        self.image_path = Path(self.temp_dir.name) / "evidence.png"
        self.image_bytes = b"\x89PNG\r\n\x1a\nshareguard-verifier"
        self.image_path.write_bytes(self.image_bytes)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp_dir.cleanup()

    def test_verifies_auth_readiness_origin_upload_and_public_response(self):
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            result = verify_endpoint(
                self.base_url,
                "verifier",
                "correct-horse-battery-staple",
                self.image_path,
            )

        self.assertGreaterEqual(result.ready_latency_ms, 0)
        self.assertGreaterEqual(result.inference_latency_ms, 0)
        self.assertEqual(result.model_version, "shareguard-private-v1")
        self.assertEqual(result.decision, "suspend")
        self.assertNotIn("correct-horse", captured.getvalue())

        records = VerificationHandler.records
        self.assertEqual([record["path"] for record in records], [
            "/v1/ready",
            "/v1/ready",
            "/v1/analyze",
        ])
        self.assertIsNone(records[0]["authorization"])
        self.assertEqual(records[1]["authorization"], VerificationHandler.expected_auth)
        self.assertEqual(records[2]["authorization"], VerificationHandler.expected_auth)
        self.assertTrue(all(
            record["origin"] == "https://shareguard.systems"
            for record in records
        ))
        self.assertEqual(records[2]["filename"], "evidence.png")
        self.assertEqual(records[2]["body"], self.image_bytes)

    def test_rejects_nested_private_response_fields(self):
        VerificationHandler.expose_private_key = True

        with self.assertRaisesRegex(ValueError, "private response field"):
            verify_endpoint(
                self.base_url,
                "verifier",
                "correct-horse-battery-staple",
                self.image_path,
            )

    def test_runbook_covers_secure_cutover_warmup_and_rollback(self):
        text = (ROOT / "deploy" / "MODAL_SERVERLESS.md").read_text(
            encoding="utf-8"
        )

        required = [
            "modal token new --verify",
            "modal volume create shareguard-models",
            "modal volume create shareguard-backbone-cache",
            "modal secret create shareguard-production",
            "--from-dotenv deploy/modal/.env",
            "upload_private_bundle.py",
            "9f48b64d4a90a0ae815711f2769216e16fac990e45114d3ed5256e536aeb5d82",
            "modal deploy deploy/modal/shareguard_modal.py",
            "wrangler secret put MODAL_ORIGIN",
            "verify_cloud_endpoint.py",
            "api.shareguard.systems",
            "update_autoscaler(min_containers=1)",
            "update_autoscaler(min_containers=0)",
            "Named Tunnel",
        ]
        for marker in required:
            self.assertIn(marker, text)

        for path in [
            ROOT / "shareguard" / "platform" / "README.md",
            ROOT / "docs" / "platform_github_deployment.md",
        ]:
            self.assertIn(
                "deploy/MODAL_SERVERLESS.md",
                path.read_text(encoding="utf-8"),
            )


if __name__ == "__main__":
    unittest.main()
