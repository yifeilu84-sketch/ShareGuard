"use strict";

(function installShareGuardI18n() {
  const STORAGE_KEY = "shareguard-locale";
  const DEFAULT_LOCALE = "zh-CN";
  const messages = {
    "zh-CN": {
      "app.title": "ShareGuard影像信任工作台",
      "app.brandAria": "ShareGuard影像信任工作台",
      "app.skip": "跳至当前案宗",
      "nav.views": "工作视图",
      "nav.radar": "全局雷达",
      "nav.dossier": "当前案宗",
      "nav.custody": "保全日志",
      "nav.import": "导入影像",
      "nav.locale": "Switch to English",
      "engine.demo": "产品演示模式，当前结果仅展示工作流",
      "engine.private": "私有模型服务已连接，仅返回产品级结论",
      "drop.title": "接收待核验影像",
      "threat.aria": "全局威胁态势",
      "throughput.aria": "实时处理吞吐量",
      "radar.title": "全局雷达收件箱",
      "radar.allow": "静默放行",
      "radar.hold": "高危拦截",
      "radar.quarantine": "隔离挂起区",
      "radar.tableAria": "实时影像分诊记录",
      "dossier.title": "突发影像发布前核验",
      "dossier.briefing": "匿名频道发布的突发现场影像正在跨平台传播，编辑部面临即时发布压力，原始 EXIF 与可信来源尚未取得。",
      "evidence.viewport": "影像证据透写台。触屏轻点锁定取证透镜，再次轻点释放。",
      "evidence.processedAlt": "经社交平台有损压缩的待核验影像",
      "evidence.annotationText": "查看文字结构异常",
      "evidence.annotationTextDetail": "字符结构不符合自然语言分布",
      "evidence.annotationLight": "查看光影方向异常",
      "evidence.annotationLightDetail": "主体阴影与场景光源方向冲突",
      "evidence.compare": "洗印显影对比",
      "evidence.compareAria": "对比有损传播版本与当前影像",
      "evidence.versionsAria": "传播版本切换",
      "evidence.chainReady": "传播链路已识别",
      "evidence.building": "正在形成证据链",
      "evidence.parallelReview": "传播版本并列复核",
      "evidence.lensLocked": "取证透镜已锁定，再次轻点释放",
      "decision.risk": "AI生成风险",
      "decision.confidence": "系统置信度",
      "decision.uncertainty": "不确定性",
      "decision.action": "建议动作",
      "decision.testimony": "机器证词",
      "decision.provenance": "溯源拓扑",
      "decision.force": "强制放行",
      "decision.seal": "签封并导出",
      "decision.hold.en": "SUSPEND",
      "decision.hold.local": "暂缓发布",
      "decision.review.en": "REVIEW",
      "decision.review.local": "人工复核",
      "decision.allow.en": "RELEASE",
      "decision.allow.local": "允许使用",
      "uncertainty.low": "低",
      "uncertainty.medium": "中等",
      "uncertainty.high": "高",
      "report.save": "保存 HTML",
      "report.print": "打印 / PDF",
      "report.download": "下载 JSON",
      "report.copy": "复制摘要",
      "report.actionsAria": "报告操作",
      "report.title": "ShareGuard影像鉴真报告",
      "report.none": "ShareGuard暂无可用案宗。",
      "report.decisionLabel": "处置结论",
      "report.riskLabel": "AI生成风险",
      "report.confidenceLabel": "系统置信度",
      "report.actionLabel": "建议动作",
      "report.testimonyLabel": "机器证词",
      "report.statementLabel": "声明",
      "decision.disclaimer": "技术辅助结论，不替代司法鉴定。强制放行与签封行为将写入保全日志。",
      "custody.title": "证据保全日志",
      "custody.tableAria": "案宗操作日志",
      "custody.verifier": "打开独立 .sgd 验证器",
      "review.back": "返回案宗",
      "review.figure": "争议影像 / 受控副本 / 不含模型内部参数",
      "review.note": "法律或编辑旁注",
      "review.submit": "写入保全日志",
      "review.open": "生成受控审查视图",
      "review.imageAlt": "争议影像受控审查版本",
      "review.sample1": "医院标识周围的像素过渡不自然。在取得原始 EXIF 前不建议发布。",
      "review.sample2": "同意暂缓发布。该素材具有明显名誉与市场风险，建议保留证据包。",
      "seal.close": "关闭",
      "seal.closeAria": "关闭签封窗口",
      "seal.working": "正在生成证据包",
      "seal.complete": "证据包已签封",
      "seal.failed": "签封失败",
      "seal.notice": "浏览器演示签名已完成。生产签封由私有根证书服务完成。",
      "seal.download": "下载 .sgd 证据包",
      "seal.verifier": "打开独立验证器",
      "release.title": "确认强制放行？",
      "release.body": "该动作不会修改模型结论，并将以人工覆盖事件写入保全日志。",
      "release.cancel": "取消",
      "release.confirm": "确认并记录",
      "release.overrideAction": "人工覆盖：允许使用，保留原始系统结论",
      "toast.invalidType": "仅接受 JPEG、PNG 或 WebP 影像。",
      "toast.demo": "当前服务处于产品演示模式，结论用于展示工作流，不代表对上传文件的真实鉴定。",
      "toast.serviceFallback": "私有分析服务暂不可用，已切换至产品演示结果。",
      "toast.override": "人工覆盖已记录，模型结论未被修改。",
      "toast.reviewSaved": "旁注已写入保全日志。",
      "toast.reportCopied": "案宗摘要已复制。",
      "toast.clipboardFailed": "当前浏览器无法写入剪贴板。",
      "verifier.back": "返回工作台",
      "verifier.pageTitle": "ShareGuard 独立证据验证器",
      "verifier.title": "物证开箱校验器",
      "verifier.body": "选择 ShareGuard `.sgd` 证据包。所有摘要重算与签名验证均在当前浏览器完成。",
      "verifier.choose": "选择 .sgd 证据包",
      "verifier.local": "文件不会上传",
      "verifier.disclaimer": "浏览器演示包使用随包公钥验证完整性；生产包还需核验 ShareGuard 私有根证书链。",
      "verifier.imageAlt": "证据包内封存的影像",
      "verifier.detachedTitle": "选择签封时对应的原始媒体",
      "verifier.detachedBody": "大型媒体未内嵌在证据包中。文件只会在本机计算 SHA-256。",
      "case.open": "提取案宗",
      "workflow.media": "媒体发布前核验",
      "workflow.brand": "品牌谣言澄清",
      "workflow.platform": "平台人工复核",
      "view.current": "当前版本",
      "view.jpeg": "JPEG 重压缩",
      "view.resize": "跨平台缩放",
      "view.screen": "截图传播",
      "view.share": "多次转发",
      "report.conclusion": "检测结论",
      "report.propagation": "传播链路证据",
      "report.propagationBody": "系统对当前版本、重压缩、缩放、截图和多次转发版本进行了并列复核。",
      "report.action": "处置建议",
      "report.disclaimer": "该结果为技术辅助风险信号，不替代司法鉴定或来源调查。",
      "case.geopolitical.title": "突发地缘政治医疗事件",
      "case.geopolitical.briefing": "匿名频道发布的突发现场影像正在跨平台传播，编辑部面临即时发布压力，原始 EXIF 与可信来源尚未取得。",
      "case.geopolitical.action": "取得原始素材并转交人工复核",
      "case.geopolitical.summary": "系统在多次传播退化后仍检测到稳定的生成性痕迹。画面中的文字结构和环境光向存在相互独立的异常信号。",
      "case.geopolitical.note1": "疑似文字幻觉在压缩版本中持续存在。",
      "case.geopolitical.note2": "主体边缘与背景景深过渡不一致。",
      "case.geopolitical.note3": "缺失可核验的原始 EXIF 数据。",
      "case.newsroom.title": "突发现场图来源核验",
      "case.newsroom.briefing": "用户提交的突发现场截图缺少原始文件，多个传播版本中的局部纹理出现不一致，需要编辑复核。",
      "case.newsroom.action": "联系投稿者取得原始文件",
      "case.newsroom.summary": "当前证据处于灰色区间。传播压缩削弱了局部信号，系统无法独立形成可靠放行结论。",
      "case.newsroom.note1": "截图传播造成高频细节缺失。",
      "case.newsroom.note2": "局部边缘信号在不同版本间不稳定。",
      "case.newsroom.note3": "来源身份与首次发布时间未核验。",
      "case.brand.title": "品牌谣言澄清",
      "case.brand.briefing": "一张疑似产品召回通知正在社交平台扩散，品牌团队需要在回应前确认素材可信度。",
      "case.brand.action": "转交品牌法务并索取原始发布文件",
      "case.brand.summary": "文件版式和文字边缘呈现相互矛盾的压缩轨迹，需要人工确认来源链。",
      "case.brand.note1": "公告字体与品牌模板不一致。",
      "case.brand.note2": "局部噪声与整图压缩等级不一致。",
      "case.brand.note3": "未发现可信首发来源。",
      "case.platform.title": "平台人工复核",
      "case.platform.briefing": "内容平台将边界样本升级至人工队列，需要在服务时限内给出处置理由。",
      "case.platform.action": "保留内容并升级至高级复核员",
      "case.platform.summary": "自动信号未形成一致结论，当前证据更适合进入人工复核而非自动下架。",
      "case.platform.note1": "生成风险位于人工复核区间。",
      "case.platform.note2": "传播退化降低了系统置信度。",
      "case.platform.note3": "建议结合账号行为和来源记录判断。",
      "case.upload.title": "用户导入影像核验",
      "case.upload.briefing": "该影像由当前工作台导入，系统正在生成传播版本、风险结论和可归档处置记录。",
      "case.upload.action": "取得原始素材并转交人工复核",
      "case.upload.summary": "系统在多次传播退化后仍检测到稳定的生成性痕迹。画面中的文字结构和环境光向存在相互独立的异常信号。",
      "case.upload.note1": "疑似文字幻觉在压缩版本中持续存在。",
      "case.upload.note2": "主体边缘与背景景深过渡不一致。",
      "case.upload.note3": "缺失可核验的原始 EXIF 数据。",
      "provenance.aria": "Telegram、社交平台与当前待审版本的传播路径"
    },
    "en": {
      "app.title": "ShareGuard Image Trust Workbench",
      "app.brandAria": "ShareGuard Image Trust Workbench",
      "app.skip": "Skip to active dossier",
      "nav.views": "Workspace views",
      "nav.radar": "Global Radar",
      "nav.dossier": "Active Dossier",
      "nav.custody": "Custody Log",
      "nav.import": "Import Media",
      "nav.locale": "切换至中文",
      "engine.demo": "Product demo mode. Results illustrate workflow only.",
      "engine.private": "Private model connected. Product-level findings only.",
      "drop.title": "Receive media for verification",
      "threat.aria": "Global threat posture",
      "throughput.aria": "Live processing throughput",
      "radar.title": "Global Radar Inbox",
      "radar.allow": "Silent release",
      "radar.hold": "High-risk intercept",
      "radar.quarantine": "Quarantine Queue",
      "radar.tableAria": "Live media triage records",
      "dossier.title": "Breaking-image pre-publication review",
      "dossier.briefing": "A breaking-scene image from an anonymous channel is spreading across platforms. The desk faces immediate publication pressure without original EXIF or a trusted source.",
      "evidence.viewport": "Evidence light table. Tap to lock the forensic lens; tap again to release.",
      "evidence.processedAlt": "Lossy social-media copy awaiting verification",
      "evidence.annotationText": "Inspect text-structure anomaly",
      "evidence.annotationTextDetail": "Character structure diverges from natural-language distribution",
      "evidence.annotationLight": "Inspect lighting-direction anomaly",
      "evidence.annotationLightDetail": "Subject shadow conflicts with the scene light source",
      "evidence.compare": "Latent-image comparison",
      "evidence.compareAria": "Compare the lossy propagation copy with the reconstructed image",
      "evidence.versionsAria": "Switch propagation version",
      "evidence.chainReady": "Propagation chain identified",
      "evidence.building": "Building evidence chain",
      "evidence.parallelReview": "Propagation copies under parallel review",
      "evidence.lensLocked": "Forensic lens locked. Tap again to release.",
      "decision.risk": "AI-generation risk",
      "decision.confidence": "System confidence",
      "decision.uncertainty": "Uncertainty",
      "decision.action": "Recommended action",
      "decision.testimony": "Machine testimony",
      "decision.provenance": "Provenance topology",
      "decision.force": "Force Release",
      "decision.seal": "Seal & Export",
      "decision.hold.en": "SUSPEND",
      "decision.hold.local": "HOLD PUBLICATION",
      "decision.review.en": "REVIEW",
      "decision.review.local": "HUMAN REVIEW",
      "decision.allow.en": "RELEASE",
      "decision.allow.local": "APPROVED FOR USE",
      "uncertainty.low": "Low",
      "uncertainty.medium": "Medium",
      "uncertainty.high": "High",
      "report.save": "Save HTML",
      "report.print": "Print / PDF",
      "report.download": "Download JSON",
      "report.copy": "Copy Summary",
      "report.actionsAria": "Report actions",
      "report.title": "ShareGuard Image Authenticity Report",
      "report.none": "No active ShareGuard dossier is available.",
      "report.decisionLabel": "Disposition",
      "report.riskLabel": "AI-generation risk",
      "report.confidenceLabel": "System confidence",
      "report.actionLabel": "Recommended action",
      "report.testimonyLabel": "Machine testimony",
      "report.statementLabel": "Statement",
      "decision.disclaimer": "Technical decision support, not a forensic ruling. Overrides and sealing events are written to the custody log.",
      "custody.title": "Evidence Custody Log",
      "custody.tableAria": "Dossier operation log",
      "custody.verifier": "Open independent .sgd verifier",
      "review.back": "Return to Dossier",
      "review.figure": "Disputed image / controlled copy / no internal model parameters",
      "review.note": "Legal or editorial marginalia",
      "review.submit": "Append to Custody Log",
      "review.open": "Generate Controlled Review View",
      "review.imageAlt": "Controlled review copy of the disputed image",
      "review.sample1": "Pixel transitions around the hospital mark are unnatural. Do not publish before obtaining original EXIF.",
      "review.sample2": "Publication should remain suspended. Preserve the evidence package due to reputational and market risk.",
      "seal.close": "Close",
      "seal.closeAria": "Close sealing window",
      "seal.working": "Building evidence package",
      "seal.complete": "Evidence package sealed",
      "seal.failed": "Sealing failed",
      "seal.notice": "Browser demonstrator signature complete. Production seals are issued by the private root-certificate service.",
      "seal.download": "Download .sgd Package",
      "seal.verifier": "Open Independent Verifier",
      "release.title": "Confirm forced release?",
      "release.body": "This action does not alter the model finding and will be appended as a human override in the custody log.",
      "release.cancel": "Cancel",
      "release.confirm": "Confirm & Record",
      "release.overrideAction": "Human override: approved for use while preserving the original system finding",
      "toast.invalidType": "Only JPEG, PNG, or WebP images are accepted.",
      "toast.demo": "This service is in product-demo mode. The result illustrates workflow and is not an authentic finding for the uploaded file.",
      "toast.serviceFallback": "The private analysis service is unavailable. A product-demo result is shown instead.",
      "toast.override": "Human override recorded. The model finding remains unchanged.",
      "toast.reviewSaved": "Marginalia appended to the custody log.",
      "toast.reportCopied": "Dossier summary copied.",
      "toast.clipboardFailed": "This browser cannot write to the clipboard.",
      "verifier.back": "Return to Workbench",
      "verifier.pageTitle": "ShareGuard Independent Evidence Verifier",
      "verifier.title": "Physical Evidence Package Verifier",
      "verifier.body": "Select a ShareGuard `.sgd` package. Digest recomputation and signature verification happen entirely in this browser.",
      "verifier.choose": "Select .sgd Package",
      "verifier.local": "Files never leave this device",
      "verifier.disclaimer": "Browser demonstrator packages use their enclosed public key; production packages also require validation against the private ShareGuard root-certificate chain.",
      "verifier.imageAlt": "Image sealed inside the evidence package",
      "verifier.detachedTitle": "Select the original media used at sealing",
      "verifier.detachedBody": "Large media is not embedded in the package. Only a local SHA-256 digest is computed.",
      "case.open": "Open Dossier",
      "workflow.media": "Pre-publication Media Review",
      "workflow.brand": "Brand Rumor Response",
      "workflow.platform": "Platform Human Review",
      "view.current": "Current Copy",
      "view.jpeg": "JPEG Recompression",
      "view.resize": "Cross-platform Resize",
      "view.screen": "Screenshot Relay",
      "view.share": "Repeated Forwarding",
      "report.conclusion": "Detection Finding",
      "report.propagation": "Propagation Evidence",
      "report.propagationBody": "The current, recompressed, resized, screenshot, and repeatedly forwarded copies were reviewed in parallel.",
      "report.action": "Disposition Recommendation",
      "report.disclaimer": "This is a technical risk signal, not a forensic ruling or source investigation.",
      "case.geopolitical.title": "Breaking Geopolitical Medical Event",
      "case.geopolitical.briefing": "An image from an anonymous channel is spreading across platforms. The desk faces immediate publication pressure without original EXIF or a trusted source.",
      "case.geopolitical.action": "Obtain the original asset and route it to human review",
      "case.geopolitical.summary": "Stable generative traces remain after repeated propagation loss. Text structure and environmental lighting show independent anomalies.",
      "case.geopolitical.note1": "Suspected text hallucination persists across compressed copies.",
      "case.geopolitical.note2": "Subject edges conflict with the background depth transition.",
      "case.geopolitical.note3": "No verifiable original EXIF is available.",
      "case.newsroom.title": "Breaking-scene Source Verification",
      "case.newsroom.briefing": "A user-submitted breaking-scene screenshot lacks the original file, and local textures diverge across propagated copies.",
      "case.newsroom.action": "Contact the contributor and obtain the original file",
      "case.newsroom.summary": "The evidence remains in a gray zone. Propagation compression weakens local signals, so the system cannot independently support release.",
      "case.newsroom.note1": "Screenshot relay removed high-frequency detail.",
      "case.newsroom.note2": "Local edge signals are unstable across copies.",
      "case.newsroom.note3": "Source identity and first-publication time remain unverified.",
      "case.brand.title": "Brand Rumor Response",
      "case.brand.briefing": "A suspected product-recall notice is spreading on social media. The brand team must establish asset credibility before responding.",
      "case.brand.action": "Route to brand counsel and request the original publication file",
      "case.brand.summary": "The document layout and text edges contain conflicting compression histories that require source-chain review.",
      "case.brand.note1": "Notice typography diverges from the approved brand template.",
      "case.brand.note2": "Local noise conflicts with the image-wide compression level.",
      "case.brand.note3": "No trusted first publisher has been identified.",
      "case.platform.title": "Platform Human Review",
      "case.platform.briefing": "A content platform escalated a boundary sample to its human queue and needs a reasoned decision within the service window.",
      "case.platform.action": "Retain the content and escalate to a senior reviewer",
      "case.platform.summary": "Automated signals do not converge. The evidence supports human review rather than automatic removal.",
      "case.platform.note1": "Generation risk falls inside the human-review interval.",
      "case.platform.note2": "Propagation loss reduces system confidence.",
      "case.platform.note3": "Combine account behavior and source records before deciding.",
      "case.upload.title": "Imported Media Verification",
      "case.upload.briefing": "This image was imported into the active workbench. The system is generating propagation copies, a risk decision, and an archivable disposition record.",
      "case.upload.action": "Obtain the original asset and route it to human review",
      "case.upload.summary": "Stable generative traces remain after repeated propagation loss. Text structure and environmental lighting show independent anomalies.",
      "case.upload.note1": "Suspected text hallucination persists across compressed copies.",
      "case.upload.note2": "Subject edges conflict with the background depth transition.",
      "case.upload.note3": "No verifiable original EXIF is available.",
      "provenance.aria": "Propagation path from Telegram through social relay to the desk asset"
    }
  };

  const listeners = new Set();
  let locale = readStoredLocale();

  function readStoredLocale() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return Object.prototype.hasOwnProperty.call(messages, stored) ? stored : DEFAULT_LOCALE;
    } catch (_error) {
      return DEFAULT_LOCALE;
    }
  }

  function t(key, fallback = key) {
    return messages[locale]?.[key] ?? messages[DEFAULT_LOCALE]?.[key] ?? fallback;
  }

  function apply(root = document) {
    document.documentElement.lang = locale;
    document.title = t(document.body?.dataset.i18nTitle || "app.title");
    root.querySelectorAll("[data-i18n]").forEach((element) => {
      element.textContent = t(element.dataset.i18n, element.textContent);
    });
    root.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
      element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel, element.getAttribute("aria-label") || ""));
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
      element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder, element.getAttribute("placeholder") || ""));
    });
    root.querySelectorAll("[data-i18n-alt]").forEach((element) => {
      element.setAttribute("alt", t(element.dataset.i18nAlt, element.getAttribute("alt") || ""));
    });
    const toggle = root.querySelector("#languageToggle");
    if (toggle) {
      toggle.textContent = locale === "zh-CN" ? "EN" : "中";
      toggle.setAttribute("aria-label", t("nav.locale"));
      toggle.setAttribute("title", t("nav.locale"));
    }
  }

  function setLocale(nextLocale) {
    if (!Object.prototype.hasOwnProperty.call(messages, nextLocale) || nextLocale === locale) return;
    locale = nextLocale;
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch (_error) {
      // The workbench remains usable when storage is unavailable.
    }
    apply();
    listeners.forEach((listener) => listener(locale));
    document.dispatchEvent(new CustomEvent("shareguard:localechange", { detail: { locale } }));
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  window.ShareGuardI18n = Object.freeze({
    apply,
    getLocale: () => locale,
    messages,
    setLocale,
    subscribe,
    t
  });

  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.getElementById("languageToggle")?.addEventListener("click", () => {
      setLocale(locale === "zh-CN" ? "en" : "zh-CN");
    });
  });
}());
