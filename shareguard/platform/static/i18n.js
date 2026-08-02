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
      "engine.liveSpai": "在线筛查：SPAI PUBLIC V1 / ShareGuard 决策层",
      "engine.connected": "云端推理网关已连接，等待实际引擎返回",
      "engine.awaiting": "等待云端推理授权，凭证不会写入仓库",
      "engine.unavailable": "云端推理连接失败，未生成鉴真结论",
      "model.connect": "连接模型",
      "model.title": "连接 ShareGuard 云端推理",
      "model.description": "输入访问凭证后，影像会通过加密连接发送到受保护的云端筛查网关。模型权重与内部参数不会进入浏览器或公开仓库。",
      "model.endpoint": "私有网关",
      "model.username": "访问账号",
      "model.password": "访问密码",
      "model.memoryOnly": "凭证仅保存在当前页面内存中；刷新或关闭页面后自动清除。",
      "model.disconnect": "断开连接",
      "model.submit": "验证并连接",
      "model.closeAria": "关闭模型连接窗口",
      "model.credentialsRequired": "请输入访问账号和访问密码。",
      "model.connecting": "正在验证云端推理网关…",
      "model.invalid": "账号或密码无效，请重新输入。",
      "model.unavailable": "云端推理网关暂不可用。",
      "model.notReady": "云端推理服务仍在启动，请稍后重试。",
      "model.connected": "连接成功，真实模型推理已启用。",
      "model.networkError": "无法连接云端推理网关，请稍后重试。",
      "model.connectedShort": "模型已连接",
      "model.connectingShort": "正在连接",
      "model.retry": "重试连接",
      "model.disconnected": "云端推理连接已断开。",
      "model.waiting": "等待连接云端推理后开始真实分析。",
      "model.authorizationRequired": "请输入访问凭证以启动这张影像的真实模型分析。",
      "model.analysisUnavailable": "真实模型未返回结果，请检查本机服务或稍后重试。",
      "model.noFinding": "尚未生成真实模型结论",
      "model.noDecisionEn": "MODEL OFFLINE",
      "model.noDecision": "尚无鉴真结论",
      "model.noResult": "尚无模型结果",
      "model.connectAction": "连接云端推理后重新分析",
      "model.importAction": "导入影像以开始真实分析",
      "model.awaitingUpload": "导入影像后开始真实模型分析。",
      "model.awaitingUploadShort": "尚未导入影像",
      "model.noImage": "尚未选择待分析影像。",
      "model.demoRejected": "正式工作台拒绝演示模型响应。",
      "drop.title": "接收待核验影像",
      "threat.aria": "全局威胁态势",
      "throughput.aria": "实时处理吞吐量",
      "radar.title": "全局雷达收件箱",
      "radar.allow": "静默放行",
      "radar.hold": "高危拦截",
      "radar.quarantine": "隔离挂起区",
      "radar.tableAria": "实时影像分诊记录",
      "radar.notConnected": "未接入实时业务队列，不显示模拟数据。",
      "evidence.viewport": "影像证据透写台。触屏轻点锁定取证透镜，再次轻点释放。",
      "evidence.compare": "洗印显影对比",
      "evidence.compareAria": "对比有损传播版本与当前影像",
      "evidence.building": "正在调用云端筛查引擎",
      "evidence.lensLocked": "取证透镜已锁定，再次轻点释放",
      "evidence.analysisReady": "真实模型分析已完成",
      "evidence.imageLevel": "真实模型已返回图像级结论",
      "evidence.robustnessReview": "本图生成的鲁棒性视图 / 非真实传播证据",
      "evidence.noLocalization": "图像级判定 / 模型未提供局部定位",
      "evidence.awaitingLocalization": "等待模型结果 / 尚无定位数据",
      "evidence.noViews": "导入影像后显示本图衍生鲁棒性视图。",
      "provenance.unavailable": "未提供来源或传播链路数据，系统不会生成虚构拓扑。",
      "decision.score": "AI生成模型分数",
      "decision.margin": "决策余量",
      "decision.boundary": "边界状态",
      "decision.marginHelp": "决策余量表示模型输出与决策边界的相对距离，不是准确率或事实置信度。",
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
      "boundary.far": "远离阈值",
      "boundary.middle": "接近阈值",
      "boundary.near": "高度接近阈值",
      "boundary.unknown": "未提供",
      "reliability.spatialInconsistent": "局部复核不一致",
      "report.save": "保存 HTML",
      "report.print": "打印 / PDF",
      "report.download": "下载 JSON",
      "report.copy": "复制摘要",
      "report.actionsAria": "报告操作",
      "report.title": "ShareGuard影像鉴真报告",
      "report.none": "ShareGuard暂无可用案宗。",
      "report.decisionLabel": "处置结论",
      "report.scoreLabel": "AI生成模型分数",
      "report.marginLabel": "决策余量",
      "report.scoreNoticeLabel": "分数说明",
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
      "workflow.live": "真实模型核验",
      "case.upload.title": "用户导入影像核验",
      "case.upload.briefing": "导入影像后，系统将调用云端筛查引擎生成本次文件的图像级判定；不会以演示数据补全结果。"
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
      "engine.liveSpai": "Live screening: SPAI PUBLIC V1 / ShareGuard decision layer",
      "engine.connected": "Cloud inference connected; awaiting the live engine response",
      "engine.awaiting": "Cloud-inference authorization required. Credentials are never committed.",
      "engine.unavailable": "Cloud-inference connection failed. No finding was generated.",
      "model.connect": "Connect Model",
      "model.title": "Connect ShareGuard Cloud Inference",
      "model.description": "With access credentials, media is sent over an encrypted connection to the protected cloud screening gateway. Model weights and internal parameters never enter the browser or public repository.",
      "model.endpoint": "Private gateway",
      "model.username": "Access username",
      "model.password": "Access password",
      "model.memoryOnly": "Credentials live only in this page's memory and are erased on refresh or close.",
      "model.disconnect": "Disconnect",
      "model.submit": "Verify & Connect",
      "model.closeAria": "Close model connection window",
      "model.credentialsRequired": "Enter the access username and password.",
      "model.connecting": "Verifying the cloud inference gateway…",
      "model.invalid": "The username or password is invalid. Please try again.",
      "model.unavailable": "The cloud inference gateway is unavailable.",
      "model.notReady": "The cloud inference service is still starting. Please try again shortly.",
      "model.connected": "Connected. Real model inference is enabled.",
      "model.networkError": "The cloud inference gateway could not be reached. Please try again shortly.",
      "model.connectedShort": "Model Online",
      "model.connectingShort": "Connecting",
      "model.retry": "Retry",
      "model.disconnected": "The cloud inference connection has been closed.",
      "model.waiting": "Connect cloud inference to begin live analysis.",
      "model.authorizationRequired": "Enter access credentials to run this image through the real model.",
      "model.analysisUnavailable": "The real model returned no result. Check the local service or try again later.",
      "model.noFinding": "No real model finding has been generated",
      "model.noDecisionEn": "MODEL OFFLINE",
      "model.noDecision": "NO AUTHENTICITY FINDING",
      "model.noResult": "NO MODEL RESULT",
      "model.connectAction": "Connect cloud inference and analyze again",
      "model.importAction": "Import an image to start live analysis",
      "model.awaitingUpload": "Import an image to start live cloud screening.",
      "model.awaitingUploadShort": "No image imported",
      "model.noImage": "No image has been selected for analysis.",
      "model.demoRejected": "The production workbench rejected a demo-model response.",
      "drop.title": "Receive media for verification",
      "threat.aria": "Global threat posture",
      "throughput.aria": "Live processing throughput",
      "radar.title": "Global Radar Inbox",
      "radar.allow": "Silent release",
      "radar.hold": "High-risk intercept",
      "radar.quarantine": "Quarantine Queue",
      "radar.tableAria": "Live media triage records",
      "radar.notConnected": "No live business queue is connected; simulated records are not shown.",
      "evidence.viewport": "Evidence light table. Tap to lock the forensic lens; tap again to release.",
      "evidence.compare": "Latent-image comparison",
      "evidence.compareAria": "Compare the lossy propagation copy with the reconstructed image",
      "evidence.building": "Calling cloud screening engine",
      "evidence.lensLocked": "Forensic lens locked. Tap again to release.",
      "evidence.analysisReady": "Live model analysis complete",
      "evidence.imageLevel": "Live model returned an image-level result",
      "evidence.robustnessReview": "Generated robustness view / not observed provenance",
      "evidence.noLocalization": "Image-level result / no model localization",
      "evidence.awaitingLocalization": "Awaiting model result / no localization data",
      "evidence.noViews": "Import an image to generate upload-derived robustness views.",
      "provenance.unavailable": "No source or propagation data was provided. ShareGuard will not invent a topology.",
      "decision.score": "AI-generation model score",
      "decision.margin": "Decision margin",
      "decision.boundary": "Boundary state",
      "decision.marginHelp": "Decision margin measures relative distance from the model boundary; it is not accuracy or factual confidence.",
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
      "boundary.far": "Far from threshold",
      "boundary.middle": "Near threshold",
      "boundary.near": "Very near threshold",
      "boundary.unknown": "Not provided",
      "reliability.spatialInconsistent": "Spatial recheck inconsistent",
      "report.save": "Save HTML",
      "report.print": "Print / PDF",
      "report.download": "Download JSON",
      "report.copy": "Copy Summary",
      "report.actionsAria": "Report actions",
      "report.title": "ShareGuard Image Authenticity Report",
      "report.none": "No active ShareGuard dossier is available.",
      "report.decisionLabel": "Disposition",
      "report.scoreLabel": "AI-generation model score",
      "report.marginLabel": "Decision margin",
      "report.scoreNoticeLabel": "Score notice",
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
      "workflow.live": "Live cloud-model verification",
      "case.upload.title": "Imported Media Verification",
      "case.upload.briefing": "After import, the cloud screening engine returns an image-level result for this file. Demo data is never used to fill missing output."
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
