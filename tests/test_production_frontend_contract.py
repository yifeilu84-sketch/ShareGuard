import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "shareguard" / "platform" / "static"


class ProductionFrontendContractTests(unittest.TestCase):
    def test_api_client_exposes_complete_persistent_workflow(self):
        html = (STATIC / "index.html").read_text(encoding="utf-8")
        client = (STATIC / "api-client.js").read_text(encoding="utf-8")

        self.assertIn('src="api-client.js"', html)
        self.assertLess(html.index('src="api-client.js"'), html.index('src="dossier.js"'))
        for method in [
            "analyze", "listCases", "getCase", "deleteCase", "recordDecision",
            "replaceAnnotations", "declareProvenance", "recordFeedback", "sealCase",
            "getMetrics", "getTrustRoot", "health", "ready",
        ]:
            self.assertIn(f"{method}(", client)
        self.assertIn("X-ShareGuard-Case-Id", client)
        self.assertIn("X-ShareGuard-Version-Role", client)
        self.assertIn("X-ShareGuard-Case-Title-B64", client)
        self.assertIn("function utf8Base64Url", client)
        self.assertNotIn('headers["X-ShareGuard-Case-Title"] = String(options.title)', client)
        self.assertNotIn("localStorage", client)

    def test_workbench_exposes_real_case_review_controls(self):
        html = (STATIC / "index.html").read_text(encoding="utf-8")
        script = (STATIC / "dossier.js").read_text(encoding="utf-8")

        for control_id in [
            "caseRefreshButton", "caseDeleteButton", "versionInput", "versionImportButton",
            "provenanceForm", "provenanceChannel", "provenanceUrl", "provenanceCapturedAt",
            "annotationEditButton", "annotationNote", "annotationSaveButton",
            "decisionForm", "humanDecisionAction", "humanDecisionReason", "humanDecisionNote",
            "feedbackForm", "feedbackOutcome", "feedbackBasis", "metricsSummary",
        ]:
            self.assertIn(f'id="{control_id}"', html)
        for behavior in [
            "loadCaseList", "openPersistedCase", "analyzeObservedVersion",
            "submitDeclaredProvenance", "saveReviewerAnnotations",
            "submitHumanDecision", "submitOutcomeFeedback", "loadOperationalMetrics",
        ]:
            self.assertIn(f"function {behavior}", script)
        for api_call in [
            ".listCases(", ".getCase(", ".deleteCase(", ".replaceAnnotations(",
            ".declareProvenance(", ".recordDecision(", ".recordFeedback(", ".getMetrics(",
        ]:
            self.assertIn(api_call, script)
        self.assertNotIn("localStorage", script)

    def test_reopened_human_annotations_and_decisions_remain_legible(self):
        script = (STATIC / "dossier.js").read_text(encoding="utf-8")

        self.assertIn('origin: "human_reviewer"', script)
        self.assertIn("map(normalizePersistedAnnotation)", script)
        self.assertIn("function normalizePersistedAnnotation", script)
        self.assertIn("dom.forceReleaseButton.textContent", script)
        self.assertIn("dom.feedbackButton.textContent", script)

    def test_exports_share_one_canonical_persisted_case_projection(self):
        script = (STATIC / "dossier.js").read_text(encoding="utf-8")

        self.assertIn("function canonicalCaseExport", script)
        self.assertIn("case_id", script)
        self.assertIn("media_sha256", script)
        self.assertIn("engine_release", script)
        self.assertIn("human_decision", script)
        self.assertIn("chain_head", script)
        self.assertGreaterEqual(script.count("canonicalCaseExport()"), 3)

    def test_production_html_contains_no_fixed_case_findings(self):
        html = (STATIC / "index.html").read_text(encoding="utf-8")

        for fixed_demo_marker in [
            "ANONYMOUS TELEGRAM RELAY",
            "TELEGRAM / 12:05",
            "X RELAY / 12:30",
            "TYPOGRAPHICAL HALLUCINATION",
            "CONTRADICTORY RAY PATH",
            ">A1<",
            ">A2<",
            "SUSPEND<br>",
            ">87%</dd>",
            ">81%</dd>",
        ]:
            self.assertNotIn(fixed_demo_marker, html)

        self.assertIn('id="annotationLayer"', html)
        self.assertIn('id="provenanceBody"', html)

    def test_production_script_never_falls_back_to_demo_findings(self):
        script = (STATIC / "dossier.js").read_text(encoding="utf-8")
        translations = (STATIC / "i18n.js").read_text(encoding="utf-8")

        for forbidden_fallback in [
            "loadSampleCase(DEFAULT_CASE_ID)",
            "state.activeCase.probability",
            "state.activeCase.confidence",
            "payload.propagation_views = await makeStaticPropagationViews",
            "setAnalysisPayload(await buildStaticDemoPayload())",
            "assets/flagship-event.jpg",
            "loadFlagshipImageDataUrl",
        ]:
            self.assertNotIn(forbidden_fallback, script)

        self.assertIn("renderAnalysisUnavailable", script)
        self.assertIn("view.image_data_url || view.data_url", script)
        for fixed_demo_finding in [
            "case.geopolitical",
            "case.newsroom",
            "case.brand",
            "case.platform",
            "疑似文字幻觉在压缩版本中持续存在",
            "Stable generative traces remain",
            "Propagation path from Telegram",
        ]:
            self.assertNotIn(fixed_demo_finding, translations)

    def test_production_metrics_are_not_presented_as_calibrated_probability(self):
        html = (STATIC / "index.html").read_text(encoding="utf-8")
        script = (STATIC / "dossier.js").read_text(encoding="utf-8")

        self.assertIn("AI生成模型分数", html)
        self.assertIn("决策余量", html)
        self.assertNotIn("AI生成风险</dt>", html)
        self.assertNotIn("系统置信度</dt>", html)
        self.assertIn("formatModelScore", script)

    def test_production_ui_surfaces_spatial_inconsistency_as_review(self):
        script = (STATIC / "dossier.js").read_text(encoding="utf-8")
        translations = (STATIC / "i18n.js").read_text(encoding="utf-8")

        self.assertIn("payload.reliability", script)
        self.assertIn("spatial_score_inconsistency", script)
        self.assertIn("reliability.spatialInconsistent", translations)

    def test_production_ui_uses_neutral_protected_engine_identity(self):
        html = (STATIC / "index.html").read_text(encoding="utf-8")
        script = (STATIC / "dossier.js").read_text(encoding="utf-8")
        translations = (STATIC / "i18n.js").read_text(encoding="utf-8")

        self.assertIn("payload.detector_engine", script)
        self.assertIn("payload.decision_layer", script)
        self.assertNotIn("SPAI", translations)
        self.assertNotIn("spai-public-v1", script.lower())
        self.assertNotIn("shareguard-private-v1", script.lower())
        self.assertIn("ShareGuard 受保护筛查引擎", translations)
        self.assertIn("ShareGuard decision layer", translations)
        for outdated_claim in [
            "系统将调用私有模型",
            "正在调用私有模型",
            "私有模型服务已连接，仅返回产品级结论",
        ]:
            self.assertNotIn(outdated_claim, html)
            self.assertNotIn(outdated_claim, script)
            self.assertNotIn(outdated_claim, translations)

    def test_offline_verifier_trusts_only_pinned_v3_issuer_keys(self):
        verifier = (STATIC / "verifier.js").read_text(encoding="utf-8")
        runtime = (STATIC / "runtime-config.js").read_text(encoding="utf-8")

        self.assertIn("shareguard.sgd.v3", verifier)
        self.assertIn("ShareGuardRuntime.trustRoots", verifier)
        self.assertIn("verifyEventChain", verifier)
        self.assertIn("payload_sha256", verifier)
        self.assertIn("valid_trusted", verifier)
        self.assertNotIn("evidencePackage.public_key", verifier)
        self.assertNotIn("ShareGuard-Evidence-Package-1", verifier)
        self.assertIn("trustRoots", runtime)
        self.assertIn("public_jwk", runtime)

    def test_production_workbench_requests_server_signed_evidence(self):
        script = (STATIC / "dossier.js").read_text(encoding="utf-8")
        api_client = (STATIC / "api-client.js").read_text(encoding="utf-8")
        worker = (STATIC / "crypto-worker.js").read_text(encoding="utf-8")

        self.assertIn('sealCase(caseId)', api_client)
        self.assertIn('this.postCaseCommand(caseId, "seal", {})', api_client)
        self.assertIn('apiClient.sealCase(caseId)', script)
        self.assertIn('shareguard.sgd.v3', script)
        container = (STATIC / "sgd-container.js").read_text(encoding="utf-8")
        self.assertIn('CompressionStream("gzip")', container)
        self.assertIn('AES-GCM', container)
        self.assertIn('PBKDF2', container)
        self.assertNotIn('ShareGuard-Evidence-Package-1', script)
        self.assertNotIn('crypto.subtle.generateKey', script)
        self.assertNotIn('crypto.subtle.sign', script)
        self.assertNotIn('public_key', script)
        self.assertNotIn('request.type === "seal"', worker)
        self.assertNotIn('crypto.subtle.generateKey', worker)
        self.assertNotIn('crypto.subtle.sign', worker)


if __name__ == "__main__":
    unittest.main()
