"""Browser-level acceptance check for the persistent ShareGuard workbench."""

from __future__ import annotations

import hashlib
import json
import re
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
        self.media_bytes = FIXTURE.read_bytes()
        self.digest = hashlib.sha256(self.media_bytes).hexdigest()
        self.version_count = 0
        self.case = None
        self.review_token = "review-header.review-signature"

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
            return self.fulfill(route, {"cases": cases, "next_cursor": None, "total": len(cases)})
        if path == "/v1/metrics" and method == "GET":
            return self.fulfill(route, {"metrics": self.metrics()})
        if path == "/v1/trust-root" and method == "GET":
            return self.fulfill(route, {
                "schema": "shareguard.trust-root.v1",
                "issuer": ISSUER,
                "key_id": "sg-signing-e2e",
            })

        prefix = f"/v1/cases/{CASE_ID}"
        if path.startswith(prefix + "/versions/") and path.endswith("/media") and method == "GET":
            version_id = path.split("/")[-2]
            if not any(item["version_id"] == version_id for item in self.case["versions"]):
                return self.fulfill(route, {"error": {"code": "version_not_found", "message": "not found"}}, status=404)
            return self.fulfill_media(route)
        if path == prefix + "/review-grants" and method == "POST":
            return self.issue_review_grant(route, request)
        if "/review-grants/" in path and path.endswith("/revoke") and method == "POST":
            return self.revoke_review_grant(route, path)
        if path == prefix and method == "GET":
            return self.fulfill(route, {"case": deepcopy(self.case)})
        if path == prefix and method == "DELETE":
            self.case = None
            return self.fulfill(route, {"deleted": True})
        if path.startswith(prefix + "/") and method == "POST":
            return self.command(route, path.rsplit("/", 1)[-1], request)

        if path == "/v1/review/case" and method == "GET":
            return self.fulfill(route, {"case": self.review_case()})
        if path.startswith("/v1/review/media/") and method == "GET":
            return self.fulfill_media(route)
        if path == "/v1/review/comments" and method == "POST":
            payload = request.post_data_json or {}
            self.case["comments"].append({
                "comment_id": f"sg_comment_{len(self.case['comments']) + 1:032x}",
                "body": payload["body"],
                "actor_id": f"sg_actor_{'c' * 32}",
                "recorded_at": utc_now(),
            })
            self.event("comment_added")
            return self.fulfill(route, {"case": self.review_case()})
        if path == "/v1/review/annotations" and method == "POST":
            payload = request.post_data_json or {}
            self.case["annotations"][payload["version_id"]] = payload["annotations"]
            self.event("annotations_replaced")
            return self.fulfill(route, {"case": self.review_case()})

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
            "media_custody": {
                "status": "encrypted_private",
                "plaintext_sha256": self.digest,
                "byte_size": len(self.media_bytes),
                "content_type": "image/jpeg",
                "file_name": "flagship-event.jpg",
                "retention_until": utc_now(),
                "encryption": {"algorithm": "AES-256-GCM", "key_version": "e2e"},
            },
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
                "schema": "shareguard.case.v3",
                "status": "awaiting_review",
                "created_at": timestamp,
                "updated_at": timestamp,
                "sealed_at": "",
                "chain_head": "1" * 64,
                "versions": [],
                "annotations": {},
                "declared_provenance": None,
                "provenance_graph": {"nodes": [], "edges": []},
                "workflow": {
                    "priority": "normal",
                    "assignee": "",
                    "sla_due_at": "2099-01-01T00:00:00Z",
                    "tasks": [],
                },
                "comments": [],
                "review_grants": [],
                "human_decision": None,
                "feedback": None,
                "events": [],
            }
        self.case["versions"].append(version)
        self.case["provenance_graph"]["nodes"].append({
            "node_id": f"media:{version_id}",
            "kind": "media_version",
            "version_id": version_id,
            "role": role,
            "file_name": version["file_name"],
            "media_sha256": self.digest,
            "received_at": timestamp,
        })
        self.case["workflow"]["tasks"].append({
            "task_id": f"sg_task_{self.version_count:032x}",
            "type": "review_media",
            "title": "Review uploaded media",
            "status": "open",
            "due_at": self.case["workflow"]["sla_due_at"],
            "created_at": timestamp,
            "created_by": f"sg_actor_{'b' * 32}",
            "completed_at": None,
            "completed_by": None,
        })
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
            "propagation_views": [],
        }

    def command(self, route, command, request):
        payload = request.post_data_json or {}
        if command == "annotations":
            self.case["annotations"][payload["version_id"]] = payload["annotations"]
            self.event("annotations_replaced")
            return self.fulfill(route, {"case": deepcopy(self.case)})
        if command == "provenance":
            source_id = f"sg_src_{len(self.case['provenance_graph']['edges']) + 1:032x}"
            edge_id = f"sg_edge_{len(self.case['provenance_graph']['edges']) + 1:032x}"
            status = "digest_verified" if payload.get("source_media_sha256") == self.digest else "declared_unverified"
            source_node = {
                "node_id": source_id,
                "kind": "declared_source",
                "channel": payload["channel"],
                "source_url": payload.get("source_url", ""),
                "captured_at": payload.get("captured_at", ""),
                "note": payload.get("note", ""),
                "source_media_sha256": payload.get("source_media_sha256", ""),
                "actor_id": f"sg_actor_{'b' * 32}",
                "recorded_at": utc_now(),
            }
            edge = {
                "edge_id": edge_id,
                "source_node_id": source_id,
                "target_node_id": f"media:{payload['version_id']}",
                "target_version_id": payload["version_id"],
                "relationship": payload.get("relationship", "received_from"),
                "verification_status": status,
                "evidence_basis": "exact_sha256_match" if status == "digest_verified" else "reviewer_declaration",
                "actor_id": f"sg_actor_{'b' * 32}",
                "recorded_at": utc_now(),
            }
            self.case["provenance_graph"]["nodes"].append(source_node)
            self.case["provenance_graph"]["edges"].append(edge)
            self.case["declared_provenance"] = {
                **payload,
                **source_node,
                "status": status,
                "recorded_at": utc_now(),
            }
            self.event("provenance_declared")
            return self.fulfill(route, {"case": deepcopy(self.case)})
        if command == "decision":
            self.case["human_decision"] = {**payload, "recorded_at": utc_now()}
            for task in self.case["workflow"]["tasks"]:
                if task["status"] == "open":
                    task["status"] = "completed"
                    task["completed_at"] = utc_now()
            transition = {
                "allow": "closed_allowed",
                "request_original": "awaiting_source",
                "escalate": "escalated",
                "hold": "held",
            }
            self.case["status"] = transition[payload["action"]]
            if payload["action"] != "allow":
                task_type = {
                    "request_original": "source_acquisition",
                    "escalate": "senior_review",
                    "hold": "hold_resolution",
                }[payload["action"]]
                self.case["workflow"]["tasks"].append({
                    "task_id": f"sg_task_{len(self.case['workflow']['tasks']) + 1:032x}",
                    "type": task_type,
                    "title": task_type.replace("_", " ").title(),
                    "status": "open",
                    "due_at": self.case["workflow"]["sla_due_at"],
                    "created_at": utc_now(),
                    "created_by": f"sg_actor_{'b' * 32}",
                    "completed_at": None,
                    "completed_by": None,
                })
            self.event("human_decision_recorded")
            return self.fulfill(route, {"case": deepcopy(self.case)})
        if command == "workflow":
            self.case["workflow"]["priority"] = payload["priority"]
            self.case["workflow"]["assignee"] = payload.get("assignee", "")
            self.event("workflow_updated")
            return self.fulfill(route, {"case": deepcopy(self.case)})
        if command == "comments":
            self.case["comments"].append({
                "comment_id": f"sg_comment_{len(self.case['comments']) + 1:032x}",
                "body": payload["body"],
                "actor_id": f"sg_actor_{'b' * 32}",
                "recorded_at": utc_now(),
            })
            self.event("comment_added")
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
                "schema": "shareguard.sgd.v3",
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

    def issue_review_grant(self, route, request):
        payload = request.post_data_json or {}
        grant = {
            "grant_id": f"sg_grant_{'d' * 32}",
            "reviewer_actor_id": f"sg_actor_{'c' * 32}",
            "reviewer_name": payload["reviewer_name"],
            "role": "reviewer",
            "issued_at": utc_now(),
            "expires_at": "2099-01-01T00:00:00Z",
            "issued_by": f"sg_actor_{'b' * 32}",
            "revoked_at": None,
            "revoked_by": None,
        }
        self.case["review_grants"] = [grant]
        self.event("review_grant_issued")
        return self.fulfill(route, {
            "grant": grant,
            "token": self.review_token,
            "review_url": f"http://127.0.0.1/#review_token={self.review_token}",
            "case": deepcopy(self.case),
        }, status=201)

    def revoke_review_grant(self, route, path):
        grant_id = path.split("/")[-2]
        for grant in self.case["review_grants"]:
            if grant["grant_id"] == grant_id:
                grant["revoked_at"] = utc_now()
                grant["revoked_by"] = f"sg_actor_{'b' * 32}"
        self.event("review_grant_revoked")
        return self.fulfill(route, {"case": deepcopy(self.case)})

    def review_case(self):
        record = deepcopy(self.case)
        record.pop("review_grants", None)
        record["reviewer_context"] = {
            "role": "reviewer",
            "reviewer_name": "外部审查人",
            "grant_id": f"sg_grant_{'d' * 32}",
            "expires_at": "2099-01-01T00:00:00Z",
        }
        return record

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
        open_tasks = [task for task in self.case["workflow"]["tasks"] if task["status"] == "open"]
        return {
            "case_id": CASE_ID,
            "title": self.case["title"],
            "status": self.case["status"],
            "created_at": self.case["created_at"],
            "updated_at": self.case["updated_at"],
            "version_count": len(self.case["versions"]),
            "latest_machine_recommendation": latest["machine_recommendation"],
            "human_decision": deepcopy(self.case["human_decision"]),
            "workflow": {
                "priority": self.case["workflow"]["priority"],
                "assignee": self.case["workflow"]["assignee"],
                "sla_due_at": self.case["workflow"]["sla_due_at"],
                "open_task_count": len(open_tasks),
                "next_task": open_tasks[0]["type"] if open_tasks else None,
            },
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

    def fulfill_media(self, route):
        route.fulfill(
            status=200,
            content_type="image/jpeg",
            headers={
                "Cache-Control": "private, no-store",
                "X-ShareGuard-Media-SHA256": self.digest,
            },
            body=self.media_bytes,
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
            assert page.locator("#viewGrid [data-view-index]").count() == 0

            page.set_input_files("#versionInput", str(FIXTURE))
            expect(page.locator("#viewGrid [data-version-id]")).to_have_count(2)
            expect(page.locator("#comparisonControl")).to_be_visible()

            page.select_option("#workflowPriority", "urgent")
            page.fill("#workflowAssignee", "新闻核查组")
            page.click("#workflowSaveButton")
            expect(page.locator("#workflowState")).to_contain_text("紧急")

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
            page.fill("#provenanceDigest", fixture.digest)
            page.fill("#provenanceNote", "待编辑部电话回核")
            page.click("#provenanceForm button[type='submit']")
            expect(page.locator("#provenanceStatus")).to_contain_text("DIGEST VERIFIED")

            page.click("#openReviewerButton")
            page.fill("#reviewerName", "外部法律顾问")
            page.click("#reviewGrantForm button[type='submit']")
            expect(page.locator("#reviewGrantLink")).to_have_value(re.compile(r"#review_token="))
            page.fill("#reviewerComment", "请确认来源授权范围。")
            page.click("#submitReviewButton")
            expect(page.locator("#reviewThread")).to_contain_text("请确认来源授权范围")
            page.click('#reviewerView [data-view="dossier"]')

            review_page = context.new_page()
            review_page.on("pageerror", lambda error: failures.append(f"review pageerror: {error}"))
            review_page.route("**/v1/**", fixture.route)
            review_page.goto(
                f"http://127.0.0.1:{server.server_port}/index.html"
                f"#review_token={fixture.review_token}"
            )
            expect(review_page.locator("#reviewerTitle")).to_contain_text("SG-")
            assert "review_token" not in review_page.url
            assert review_page.locator("#reviewGrantPanel").is_hidden()
            review_page.fill("#reviewerComment", "受限审查链接评论")
            review_page.click("#submitReviewButton")
            expect(review_page.locator("#reviewThread")).to_contain_text("受限审查链接评论")
            review_page.click('#reviewerView [data-view="dossier"]')
            expect(review_page.locator("#scopedReviewReturnButton")).to_be_visible()
            assert review_page.locator("#sealButton").is_hidden()
            review_page.locator("[data-annotation-index]").first.click()
            review_page.fill("#annotationNote", "受限审查人复核标注")
            review_page.click("#annotationSaveButton")
            review_page.click("#scopedReviewReturnButton")
            expect(review_page.locator("#reviewThread")).to_contain_text("受限审查人复核标注")
            review_page.screenshot(path=str(ARTIFACTS / "production-reviewer-desktop.png"), full_page=True)
            review_page.close()

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
