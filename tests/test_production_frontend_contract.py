import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "shareguard" / "platform" / "static"


class ProductionFrontendContractTests(unittest.TestCase):
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

    def test_production_ui_discloses_spai_screening_and_shareguard_decision_layer(self):
        html = (STATIC / "index.html").read_text(encoding="utf-8")
        script = (STATIC / "dossier.js").read_text(encoding="utf-8")
        translations = (STATIC / "i18n.js").read_text(encoding="utf-8")

        self.assertIn("payload.detector_engine", script)
        self.assertIn("payload.decision_layer", script)
        self.assertIn("SPAI", translations)
        self.assertIn("ShareGuard decision layer", translations)
        for outdated_claim in [
            "系统将调用私有模型",
            "正在调用私有模型",
            "私有模型服务已连接，仅返回产品级结论",
        ]:
            self.assertNotIn(outdated_claim, html)
            self.assertNotIn(outdated_claim, script)
            self.assertNotIn(outdated_claim, translations)


if __name__ == "__main__":
    unittest.main()
