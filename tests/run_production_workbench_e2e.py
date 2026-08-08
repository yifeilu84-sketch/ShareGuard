"""Browser-level acceptance check for the persistent ShareGuard workbench."""

from __future__ import annotations

import base64
import hashlib
import json
import threading
from copy import deepcopy
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import Route, expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "shareguard" / "platform" / "static"
FIXTURE = STATIC / "assets" / "flagship-event.jpg"
ARTIFACTS = ROOT / ".playwright-cli"
CASE_ID = f"sg_case_{'a' * 32}"
ISSUER = "https://shareguard.systems"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        return


class ApiFixture:
    def __init__(self):
        self.digest = hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
        self.data_url = (
            "data:image/jpeg;base64,"
            + base64.b64encode(FIXTURE.read_bytes()).decode("ascii")
        )
        self.version_count = 0
        self.case = None

    def route(self, route: Route):
        request = route.request
        path = urlparse(request.url).path
        method = request.method

        if path == "/v1/ready" and method == "GET":
            return self.fulfill(route, {"status": "ready"})
        if path == "/v1/health" and method == "GET":
            return self.fulfill(route, {"status": "ok"})
        if path == "/v1/analyze" and method == "POST":
            return self.fulfill(route, self.analyze(request.headers))
        if path == "/v1/cases" and method == "GET":
            cases = [] if self.case is None else [self.summary()]
            return self.fulfill(route, {"cases": cases})
        if path == "/v1/metrics" and method == "GET":
            return self.fulfill(route, {"metrics": self.metrics()})
        if path == "/v1/trust-root" and method == "GET":
            return self.fulfill(route, {
                "schema": "shareguard.trust-root.v1",
                "issuer": ISSUER,
                "key_id": "sg-signing-e2e",
            })

        prefix = f"/v1/cases/{CASE_ID}"
        if path == prefix and method == "GET":
            return self.fulfill(route, {"case": deepcopy(self.case)})
        if path == prefix and method == "DELETE":
            self.case = None
            return self.fulfill(route, {"deleted": True})
        if path.startswith(prefix + "/") and method == "POST":
            return self.command(route, path.rsplit("/", 1)[-1], request)

        return self.fulfill(route, {
            "error": {"code": "not_found", "message": path},
        }, status=404)

    def analyze(self, headers):
        self.version_count += 1
        version_id = f"sg_ver_{self.version_count:032x}"
        role = headers.get("x-shareguard-version-role", "original")
        timestamp = utc_now()
        version = {
            "version_id": version_id,
            "request_id": f"sg_req_{self.version_count:032x}",
            "role": role,
            "file_name": "flagship-event.jpg",
            "received_at": timestamp,
            "media_sha256": self.digest,
            "engine_release": "shareguard-screening-2026.08",
            "detector_engine": "shareguard-protected-screening-engine",
            "decision_layer": "shareguard-editorial-policy-v2",
            "machine_recommendation": "review",
            "model_score": 0.734,
            "score_kind": "uncalibrated_ai_generation_score",
            "decision_margin": 0.468,
            "risk_level": "medium",
            "latency_ms": 612,
            "image": {"width": 1280, "height": 720, "format": "JPEG"},
            "reliability": {"performed": True, "status": "consistent"},
            "calibration": {"status": "unavailable"},
            "policy": {"human_authority_required": True},
            "report": {
                "summary": "筛查引擎返回图像级风险信号，须结合来源与人工核查作出正式决定。",
                "recommended_action": "进入人工复核并核对原始来源。",
                "notes": [
                    "该分数未经概率校准，不代表事实概率。",
                    "当前引擎未返回像素级定位。",
                ],
                "uncertainty": "medium",
            },
        }
        if self.case is None:
            self.case = {
                "case_id": CASE_ID,
                "title": headers.get("x-shareguard-case-title", "用户导入影像核验"),
                "status": "open",
                "created_at": timestamp,
                "updated_at": timestamp,
                "sealed_at": "",
                "chain_head": "1" * 64,
                "versions": [],
                "annotations": {},
                "declared_provenance": None,
                "human_decision": None,
                "feedback": None,
                "events": [],
            }
        self.case["versions"].append(version)
        self.event("version_analyzed")
        return {
            "backend": "protected",
            "case_id": CASE_ID,
            "version_id": version_id,
            "case_status": self.case["status"],
            "chain_head": self.case["chain_head"],
            "case": deepcopy(self.case),
            "request_id": version["request_id"],
            "model_version": version["engine_release"],
            "engine_release": version["engine_release"],
            "detector_engine": version["detector_engine"],
            "decision_layer": version["decision_layer"],
            "file_name": version["file_name"],
            "media_sha256": version["media_sha256"],
            "model_score": version["model_score"],
            "score_kind": version["score_kind"],
            "decision_margin": version["decision_margin"],
            "risk_level": version["risk_level"],
            "decision": version["machine_recommendation"],
            "uncertainty": "medium",
            "reliability": version["reliability"],
            "calibration": version["calibration"],
            "policy": version["policy"],
            "localization": {
                "available": False,
                "reason": "image_level_model",
                "annotations": [],
            },
            "provenance": {
                "available": False,
                "reason": "source_data_not_provided",
                "hops": [],
            },
            "report": version["report"],
            "propagation_views": [{
                "id": "stress-jpeg",
                "label": "JPEG 压力视图",
                "origin": "generated_from_upload",
                "data_url": self.data_url,
                "size": "1280 x 720",
            }],
        }

    def command(self, route, command, request):
        payload = request.post_data_json or {}
        if command == "annotations":
            self.case["annotations"][payload["version_id"]] = payload["annotations"]
            self.event("annotations_replaced")
            return self.fulfill(route, {"case": deepcopy(self.case)})
        if command == "provenance":
            self.case["declared_provenance"] = {
                **payload,
                "status": "declared_unverified",
                "recorded_at": utc_now(),
            }
            self.event("provenance_declared")
            return self.fulfill(route, {"case": deepcopy(self.case)})
        if command == "decision":
            self.case["human_decision"] = {**payload, "recorded_at": utc_now()}
            self.event("human_decision_recorded")
            return self.fulfill(route, {"case": deepcopy(self.case)})
        if command == "feedback":
            self.case["feedback"] = {**payload, "recorded_at": utc_now()}
            self.event("feedback_recorded")
            return self.fulfill(route, {"case": deepcopy(self.case)})
        if command == "seal":
            self.case["status"] = "sealed"
            self.case["sealed_at"] = utc_now()
            self.event("case_sealed")
            return self.fulfill(route, {
                "schema": "shareguard.sgd.v2",
                "issuer": ISSUER,
                "key_id": "sg-signing-e2e",
                "algorithm": "ECDSA_P256_SHA256",
                "payload_sha256": "f" * 64,
                "signature": "e2e-signature-placeholder",
                "case": deepcopy(self.case),
            })
        return self.fulfill(route, {
            "error": {"code": "not_found", "message": command},
        }, status=404)

    def event(self, event_type):
        timestamp = utc_now()
        self.case["updated_at"] = timestamp
        event_number = len(self.case["events"]) + 1
        self.case["events"].append({
            "event_id": f"sg_evt_{event_number:032x}",
            "event_type": event_type,
            "actor_id": f"sg_actor_{'b' * 32}",
            "created_at": timestamp,
            "previous_hash": self.case["chain_head"],
            "event_hash": f"{event_number:x}".rjust(64, "0"),
        })
        self.case["chain_head"] = self.case["events"][-1]["event_hash"]

    def summary(self):
        latest = self.case["versions"][-1]
        return {
            "case_id": CASE_ID,
            "title": self.case["title"],
            "status": self.case["status"],
            "created_at": self.case["created_at"],
            "updated_at": self.case["updated_at"],
            "version_count": len(self.case["versions"]),
            "latest_machine_recommendation": latest["machine_recommendation"],
            "human_decision": deepcopy(self.case["human_decision"]),
        }

    def metrics(self):
        count = 0 if self.case is None else 1
        versions = 0 if self.case is None else len(self.case["versions"])
        human = {} if self.case is None or not self.case["human_decision"] else {
            self.case["human_decision"]["action"]: 1,
        }
        return {
            "case_count": count,
            "version_count": versions,
            "human_decisions": human,
            "override_count": 1 if human else 0,
            "feedback": {},
            "latency": {"sample_count": versions, "p50_ms": 612 if versions else None},
            "distribution_shift": {
                "status": "insufficient_data",
                "sample_count": versions,
                "minimum_sample_count": 30,
                "interpretation": "score_distribution_signal_not_accuracy_drift",
            },
        }

    @staticmethod
    def fulfill(route, payload, status=200):
        route.fulfill(
            status=status,
            content_type="application/json; charset=utf-8",
            headers={"Cache-Control": "no-store"},
            body=json.dumps(payload, ensure_ascii=False),
        )


def run():
    ARTIFACTS.mkdir(exist_ok=True)
    handler = partial(QuietHandler, directory=str(STATIC))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fixture = ApiFixture()
    failures = []
    requests = []

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1440, "height": 1000},
                accept_downloads=True,
            )
            page = context.new_page()
            page.on("pageerror", lambda error: failures.append(f"pageerror: {error}"))
            page.on("request", lambda request: requests.append(f"{request.method} {request.url}"))
            page.on(
                "console",
                lambda message: failures.append(f"console: {message.text}")
                if message.type == "error" else None,
            )
            page.route("**/v1/**", fixture.route)
            page.goto(f"http://127.0.0.1:{server.server_port}/index.html")

            page.set_input_files("#imageInput", str(FIXTURE))
            page.locator("#decisionTitle").wait_for(state="visible")
            try:
                expect(page.locator("#decisionTitle")).to_contain_text("REVIEW", timeout=1_000)
            except AssertionError as error:
                toast = page.locator("#toast").inner_text() if page.locator("#toast").is_visible() else ""
                raise AssertionError(
                    f"{error}\nToast: {toast}\nBrowser errors: {failures}"
                    f"\nFixture case: {fixture.case}\nRequests: {requests}"
                ) from error
            assert page.locator("#riskProbability").inner_text() == "0.734 / 1.000"
            assert page.locator("#viewGrid [data-version-id]").count() == 1
            assert page.locator("#viewGrid [data-view-index]").count() == 1

            page.set_input_files("#versionInput", str(FIXTURE))
            expect(page.locator("#viewGrid [data-version-id]")).to_have_count(2)

            page.fill("#annotationNote", "人工核对画面右侧边缘")
            page.click("#annotationEditButton")
            viewport = page.locator("#evidenceViewport").bounding_box()
            page.mouse.move(viewport["x"] + viewport["width"] * 0.25, viewport["y"] + viewport["height"] * 0.28)
            page.mouse.down()
            page.mouse.move(viewport["x"] + viewport["width"] * 0.48, viewport["y"] + viewport["height"] * 0.52)
            page.mouse.up()
            page.click("#annotationSaveButton")
            expect(page.locator("[data-annotation-index]")).to_have_count(1)

            page.fill("#provenanceChannel", "记者原始投稿")
            page.fill("#provenanceUrl", "https://example.org/source/asset")
            page.fill("#provenanceNote", "待编辑部电话回核")
            page.click("#provenanceForm button[type='submit']")
            expect(page.locator("#provenanceStatus")).to_contain_text("DECLARED")

            page.click("#forceReleaseButton")
            page.select_option("#humanDecisionAction", "request_original")
            page.select_option("#humanDecisionReason", "source_missing")
            page.fill("#humanDecisionNote", "须取得相机原始文件后再决定是否发布")
            page.click("#decisionForm button[type='submit']")
            expect(page.locator("#forceReleaseButton")).to_contain_text("索取原件")

            page.click("#feedbackButton")
            page.select_option("#feedbackOutcome", "unresolved")
            page.fill("#feedbackBasis", "仍等待供稿方提供原始文件")
            page.click("#feedbackForm button[type='submit']")
            expect(page.locator("#feedbackButton")).to_contain_text("仍未解决")

            page.click("#sealButton")
            expect(page.locator("#sealTitle")).to_contain_text("已签封")
            assert page.locator("#downloadSgdButton").is_visible()
            assert page.locator("#sealButton").is_disabled()

            with page.expect_download() as download_info:
                page.click("#downloadSgdButton")
            assert download_info.value.suggested_filename.endswith(".sgd")
            page.keyboard.press("Escape")

            with page.expect_download() as download_info:
                page.click("#downloadJsonButton")
            assert download_info.value.suggested_filename.endswith(".json")

            page.click('[data-view="radar"]')
            expect(page.locator("#metricCases")).to_have_text("1")
            expect(page.locator("#toast")).to_be_hidden(timeout=5_000)
            page.screenshot(path=str(ARTIFACTS / "production-workbench-desktop.png"), full_page=True)
            page.click(f'[data-case-id="{CASE_ID}"]')
            expect(page.locator("#emptyEvidenceState strong")).to_have_text("DETACHED MEDIA")
            page.set_input_files("#localMediaInput", str(FIXTURE))
            expect(page.locator("#fileMeta")).to_contain_text("SHA-256 VERIFIED")
            assert page.locator("[data-annotation-index]").count() == 1
            expect(page.locator("#toast")).to_be_hidden(timeout=5_000)

            page.set_viewport_size({"width": 390, "height": 844})
            page.wait_for_timeout(150)
            for selector in ["#forceReleaseButton", "#feedbackButton", "#sealButton"]:
                box = page.locator(selector).bounding_box()
                assert box and box["x"] >= 0 and box["x"] + box["width"] <= 391
            page.screenshot(path=str(ARTIFACTS / "production-workbench-mobile.png"), full_page=True)

            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    if failures:
        raise AssertionError("\n".join(failures))
    print("Production workbench E2E passed.")
    print(ARTIFACTS / "production-workbench-desktop.png")
    print(ARTIFACTS / "production-workbench-mobile.png")


if __name__ == "__main__":
    run()
