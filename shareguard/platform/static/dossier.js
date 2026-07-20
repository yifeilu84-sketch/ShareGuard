"use strict";

const DEFAULT_CASE_ID = "geopolitical";
const EMBED_MEDIA_LIMIT_BYTES = 8 * 1024 * 1024;
const i18n = window.ShareGuardI18n;

const sampleCases = [
  {
    id: "geopolitical",
    code: "SG-202607-44B",
    title: "突发地缘政治医疗事件",
    workflow: "媒体发布前核验",
    source: "ANONYMOUS TELEGRAM RELAY",
    handler: "DESK-EDITOR / HKG-04",
    timestamp: "2026-07-11 14:28:20 UTC",
    briefing: "匿名频道发布的突发现场影像正在跨平台传播，编辑部面临即时发布压力，原始 EXIF 与可信来源尚未取得。",
    probability: 0.87,
    confidence: 0.81,
    uncertainty: "中等",
    decision: "hold",
    verdictEn: "SUSPEND",
    verdictZh: "暂缓发布",
    action: "取得原始素材并转交人工复核",
    narrative: "系统在多次传播退化后仍检测到稳定的生成性痕迹。画面中的文字结构和环境光向存在相互独立的异常信号。",
    evidence: [
      "疑似文字幻觉在压缩版本中持续存在。",
      "主体边缘与背景景深过渡不一致。",
      "缺失可核验的原始 EXIF 数据。"
    ],
    deadlineSeconds: 346
  },
  {
    id: "newsroom",
    code: "SG-202607-51C",
    title: "突发现场图来源核验",
    workflow: "媒体发布前核验",
    source: "WIRE DESK / USER SUBMISSION",
    handler: "NEWS-DESK / HKG-02",
    timestamp: "2026-07-11 14:31:04 UTC",
    briefing: "用户提交的突发现场截图缺少原始文件，多个传播版本中的局部纹理出现不一致，需要编辑复核。",
    probability: 0.48,
    confidence: 0.56,
    uncertainty: "高",
    decision: "review",
    verdictEn: "REVIEW",
    verdictZh: "人工复核",
    action: "联系投稿者取得原始文件",
    narrative: "当前证据处于灰色区间。传播压缩削弱了局部信号，系统无法独立形成可靠放行结论。",
    evidence: [
      "截图传播造成高频细节缺失。",
      "局部边缘信号在不同版本间不稳定。",
      "来源身份与首次发布时间未核验。"
    ],
    deadlineSeconds: 614
  },
  {
    id: "brand",
    code: "SG-202607-58A",
    title: "品牌活动图舆情核验",
    workflow: "品牌谣言澄清",
    source: "SOCIAL LISTENING / WEIBO",
    handler: "BRAND-RISK / HKG-11",
    timestamp: "2026-07-11 14:34:42 UTC",
    briefing: "疑似伪造品牌活动图正在社交平台扩散，公关团队需要在回应前形成可转交法务的证据摘要。",
    probability: 0.73,
    confidence: 0.74,
    uncertainty: "中等",
    decision: "hold",
    verdictEn: "SUSPEND",
    verdictZh: "暂缓发布",
    action: "暂停转发并启动品牌法务复核",
    narrative: "跨传播版本保留了稳定的生成性结构异常，建议在取得活动方原始素材前停止外部使用。",
    evidence: [
      "品牌标识边缘存在非自然重采样。",
      "人物与背景的噪声分布不一致。",
      "当前素材无法关联到可信原始发布者。"
    ],
    deadlineSeconds: 228
  },
  {
    id: "platform",
    code: "SG-202607-63D",
    title: "内容平台边界样本复核",
    workflow: "平台人工复核",
    source: "TRUST & SAFETY QUEUE",
    handler: "PLATFORM-TNS / HKG-08",
    timestamp: "2026-07-11 14:36:19 UTC",
    briefing: "自动审核结果接近策略边界，平台需要人工确认是否允许继续分发，并记录覆盖理由。",
    probability: 0.42,
    confidence: 0.59,
    uncertainty: "高",
    decision: "review",
    verdictEn: "REVIEW",
    verdictZh: "人工复核",
    action: "保持限流并等待资深审核员确认",
    narrative: "现有传播版本不足以形成单一结论，系统将决策权移交人工审核并保留完整操作日志。",
    evidence: [
      "多个子证据方向不一致。",
      "压缩程度超过常规平台转码范围。",
      "建议补充相邻帧或原始上传版本。"
    ],
    deadlineSeconds: 772
  }
];

const interceptSeed = [
  ["14:27:58", "NEWSROOM-API", "IMG_4418.WEBP", "ALLOW", "AUTO"],
  ["14:28:02", "SOCIAL-LISTEN", "POST-98A1.JPG", "ALLOW", "AUTO"],
  ["14:28:07", "WIRE-DESK", "BREAKING-20.PNG", "HOLD", "DOSSIER"],
  ["14:28:09", "BRAND-WATCH", "CAMPAIGN-13.JPG", "ALLOW", "AUTO"],
  ["14:28:12", "PLATFORM-TNS", "QUEUE-882.WEBP", "REVIEW", "HUMAN"],
  ["14:28:15", "NEWSROOM-API", "FIELD-440.JPG", "ALLOW", "AUTO"],
  ["14:28:18", "LEGAL-INTAKE", "EXHIBIT-7.PNG", "HOLD", "DOSSIER"],
  ["14:28:20", "TELEGRAM-RELAY", "SG-44B.JPG", "HOLD", "DOSSIER"],
  ["14:28:23", "SOCIAL-LISTEN", "POST-98A2.JPG", "ALLOW", "AUTO"],
  ["14:28:26", "PLATFORM-TNS", "QUEUE-883.WEBP", "ALLOW", "AUTO"]
];

const state = {
  activeCase: sampleCases[0],
  activePayload: null,
  activeViewIndex: 0,
  currentFile: null,
  currentDataUrl: "assets/flagship-event.jpg",
  currentObjectUrl: null,
  propagationViews: [],
  waterfallRows: interceptSeed.map((row, index) => ({
    time: row[0],
    ingress: row[1],
    asset: row[2],
    decision: row[3],
    route: row[4],
    id: `seed-${index}`
  })),
  custodyEvents: [
    { time: "12:05:00", actor: "INGEST", event: "Initial appearance recorded from anonymous Telegram relay", integrity: "RECORDED" },
    { time: "12:30:14", actor: "SYSTEM", event: "Platform shift detected; lossy recompression fingerprint added", integrity: "VERIFIED" },
    { time: "14:22:08", actor: "DESK-EDITOR", event: "Current asset uploaded through editorial intake", integrity: "VERIFIED" },
    { time: "14:28:20", actor: "ANALYSIS", event: "Risk decision generated and routed to human authority", integrity: "APPENDED" },
    { time: "14:40:11", actor: "LEGAL", event: "Suspension recommendation acknowledged for compliance review", integrity: "APPENDED" }
  ],
  reviewerNotes: [
    {
      time: "14:35",
      actor: "Editorial",
      key: "review.sample1",
      text: "医院标识周围的像素过渡不自然。在取得原始 EXIF 前不建议发布。"
    },
    {
      time: "14:40",
      actor: "Legal Dept.",
      key: "review.sample2",
      text: "同意暂缓发布。该素材具有明显名誉与市场风险，建议保留证据包。"
    }
  ],
  evidencePackageBlob: null,
  evidencePackageName: ""
};

const dom = {};
let toastTimer = null;
let assetDataUrlPromise = null;
let narrativeAnimationToken = 0;
let touchLensLocked = false;
let touchPointerStart = null;

function t(key, fallback) {
  const resolvedFallback = fallback ?? key;
  return i18n?.t(key, resolvedFallback) ?? resolvedFallback;
}

function caseText(item, field) {
  const fallback = field === "summary" ? item.narrative : item[field];
  return t(`case.${item.id}.${field}`, fallback);
}

function workflowText(item) {
  const workflowKeys = {
    geopolitical: "workflow.media",
    newsroom: "workflow.media",
    brand: "workflow.brand",
    platform: "workflow.platform",
    upload: "workflow.media"
  };
  return t(workflowKeys[item.id], item.workflow);
}

function cacheDom() {
  [
    "imageInput", "engineLabel", "systemClock", "intakeRate", "queueCount",
    "throughputCanvas", "radarView", "dossierView", "custodyView", "reviewerView",
    "waterfallFeed", "quarantineZone", "quarantineCount", "casePicker",
    "stageCaseCode", "dossierTitle", "caseTimestamp", "caseSource", "caseHandler",
    "caseContext", "evidenceViewport", "processedImage", "previewImage", "originalLayer",
    "forensicCanvas", "forensicLens", "compareRange", "stageViewLabel",
    "stageStatusLabel", "viewGrid", "fileMeta", "decisionPanel", "decisionTimestamp",
    "decisionTitle", "riskProbability", "confidenceValue", "uncertaintyValue",
    "recommendedAction", "machineNarrative", "evidenceList", "forceReleaseButton",
    "sealButton", "saveHtmlReportButton", "printReportButton", "downloadJsonButton",
    "copyReportButton", "custodyLog", "custodyCaseCode", "custodyFile",
    "custodyDecision", "custodyEvents", "custodySeal", "footerCase",
    "openReviewerButton", "reviewerImage", "reviewerTitle", "reviewerVerdict",
    "reviewerNarrative", "reviewForm", "reviewerComment", "reviewThread",
    "sealDialog", "sealTitle", "sealLog", "sealResult", "downloadSgdButton",
    "releaseDialog", "confirmReleaseButton", "dropOverlay", "toast"
  ].forEach((id) => {
    dom[id] = document.getElementById(id);
  });
}

function init() {
  cacheDom();
  bindViewControls();
  bindUploadControls();
  bindDossierControls();
  bindReportControls();
  bindReviewerControls();
  bindDialogControls();
  renderCasePicker();
  renderWaterfall();
  renderCustodyLog();
  renderReviewerNotes();
  startSystemClock();
  startRadarFeed();
  startQuarantineCountdowns();
  startThroughputWave();
  setupForensicCanvas();
  loadStoredReviewerNotes();
  i18n?.subscribe(() => {
    refreshLocalizedView().catch(() => showToast("Locale refresh failed."));
  });

  const reviewOnly = new URLSearchParams(window.location.search).get("review") === "1";
  if (reviewOnly) {
    switchView("reviewer", { updateHistory: false });
  } else {
    switchView("dossier", { updateHistory: false });
  }

  loadSampleCase(DEFAULT_CASE_ID);
}

function bindViewControls() {
  document.querySelectorAll("[data-view]").forEach((control) => {
    control.addEventListener("click", () => switchView(control.dataset.view));
  });
}

function switchView(viewName, options = {}) {
  const viewMap = {
    radar: dom.radarView,
    dossier: dom.dossierView,
    custody: dom.custodyView,
    reviewer: dom.reviewerView
  };
  const target = viewMap[viewName] || dom.dossierView;

  Object.values(viewMap).forEach((view) => {
    view.hidden = view !== target;
  });
  document.querySelectorAll(".view-switcher [data-view]").forEach((control) => {
    control.setAttribute("aria-selected", String(control.dataset.view === viewName));
  });
  document.body.classList.toggle("reviewer-mode", viewName === "reviewer");

  if (options.updateHistory !== false && window.history && window.history.replaceState) {
    const url = new URL(window.location.href);
    if (viewName === "reviewer") {
      url.searchParams.set("review", "1");
    } else {
      url.searchParams.delete("review");
    }
    window.history.replaceState({}, "", url);
  }

  if (viewName === "dossier") {
    window.setTimeout(resizeForensicCanvas, 0);
  }
}

function renderCasePicker() {
  dom.casePicker.innerHTML = sampleCases.map((item) => `
    <article class="quarantine-card ${item.id === state.activeCase.id ? "active" : ""}" data-case-card="${escapeHtml(item.id)}">
      <header>
        <span>[ ${escapeHtml(workflowText(item))} ]</span>
        <time data-countdown="${item.deadlineSeconds}">${formatCountdown(item.deadlineSeconds)}</time>
      </header>
      <h3>${escapeHtml(caseText(item, "title"))}</h3>
      <p>${escapeHtml(caseText(item, "briefing"))}</p>
      <footer>
        <small>${escapeHtml(item.code)} / ${(item.probability * 100).toFixed(0)}% RISK</small>
        <button type="button" data-case="${escapeHtml(item.id)}">${escapeHtml(t("case.open", "提取案宗"))}</button>
      </footer>
    </article>
  `).join("");

  dom.casePicker.querySelectorAll("[data-case]").forEach((button) => {
    button.addEventListener("click", () => loadSampleCase(button.dataset.case));
  });
  dom.quarantineCount.textContent = String(sampleCases.length).padStart(2, "0");
}

async function loadSampleCase(caseId) {
  const item = sampleCases.find((candidate) => candidate.id === caseId) || sampleCases[0];
  state.activeCase = item;
  state.currentFile = null;
  releaseCurrentObjectUrl();
  state.currentDataUrl = await loadFlagshipImageDataUrl();
  renderCasePicker();
  renderCaseContext(item);
  setAnalysisPayload(await buildStaticDemoPayload({ caseItem: item }));
  addCustodyEvent("DESK-EDITOR", `Dossier ${item.code} opened for human review`, "APPENDED");
  switchView("dossier");
}

function renderCaseContext(item) {
  dom.stageCaseCode.textContent = `CASE #${item.code}`;
  dom.dossierTitle.textContent = caseText(item, "title");
  dom.caseTimestamp.textContent = item.timestamp;
  dom.caseSource.textContent = item.source;
  dom.caseHandler.textContent = item.handler;
  dom.caseContext.innerHTML = `
    <span>EVENT BRIEFING</span>
    <p>${escapeHtml(caseText(item, "briefing"))}</p>
  `;
  dom.footerCase.textContent = `CASE #${item.code}`;
  dom.custodyCaseCode.textContent = item.code;
  dom.reviewerTitle.textContent = `CASE #${item.code}`;
}

function bindUploadControls() {
  dom.imageInput.addEventListener("change", () => {
    const [file] = dom.imageInput.files || [];
    if (file) handleFile(file);
  });

  let dragDepth = 0;
  window.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    dom.dropOverlay.hidden = false;
    dom.dropOverlay.setAttribute("aria-hidden", "false");
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("dragleave", (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideDropOverlay();
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    hideDropOverlay();
    const [file] = event.dataTransfer?.files || [];
    if (file) handleFile(file);
  });
}

function hideDropOverlay() {
  dom.dropOverlay.hidden = true;
  dom.dropOverlay.setAttribute("aria-hidden", "true");
}

async function handleFile(file) {
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
    showToast(t("toast.invalidType", "仅接受 JPEG、PNG 或 WebP 影像。"));
    return;
  }
  state.currentFile = file;
  releaseCurrentObjectUrl();
  state.currentObjectUrl = URL.createObjectURL(file);
  state.currentDataUrl = state.currentObjectUrl;
  const dimensions = await readImageDimensions(state.currentDataUrl);
  const stamp = new Date();
  const code = `SG-UPLOAD-${String(stamp.getTime()).slice(-6)}`;
  state.activeCase = {
    ...sampleCases[0],
    id: "upload",
    code,
    title: t("case.upload.title", "用户导入影像核验"),
    source: "EDITORIAL DROPZONE",
    timestamp: `${stamp.toISOString().slice(0, 19).replace("T", " ")} UTC`,
    briefing: t("case.upload.briefing", "该影像由当前工作台导入，系统正在生成传播版本、风险结论和可归档处置记录。")
  };
  renderCaseContext(state.activeCase);
  dom.fileMeta.textContent = `${file.name.toUpperCase()} / ${dimensions.width} × ${dimensions.height} / ${formatBytes(file.size)}`;
  dom.previewImage.src = state.currentDataUrl;
  dom.processedImage.src = state.currentDataUrl;
  dom.reviewerImage.src = state.currentDataUrl;
  addCustodyEvent("DESK-EDITOR", `Asset ${sanitizeFilename(file.name)} received through dropzone`, "VERIFIED");
  switchView("dossier");
  await analyzeCurrentFile();
}

async function analyzeCurrentFile() {
  document.body.classList.add("is-analyzing");
  dom.stageStatusLabel.textContent = t("evidence.building", "正在形成证据链");
  try {
    if (shouldUseStaticDemo()) {
      setAnalysisPayload(await buildStaticDemoPayload());
      dom.engineLabel.textContent = t("engine.demo", "产品演示模式，当前结果仅展示工作流");
      return;
    }

    const body = new FormData();
    if (state.currentFile) {
      body.append("image", state.currentFile, state.currentFile.name);
    } else {
      const blob = await dataUrlToBlob(state.currentDataUrl);
      body.append("image", blob, "flagship-event.jpg");
    }
    const response = await fetch("/api/analyze", {
      method: "POST",
      body,
      headers: { "Accept-Language": i18n?.getLocale() || "zh-CN" }
    });
    if (!response.ok) {
      throw new Error(`分析服务返回 ${response.status}`);
    }
    const isDemoResponse = response.headers.get("X-ShareGuard-Demo") === "true";
    const payload = await response.json();
    if (!Array.isArray(payload.propagation_views) || !payload.propagation_views.length) {
      payload.propagation_views = await makeStaticPropagationViews(state.currentDataUrl);
    }
    if (isDemoResponse || payload.backend === "mock") {
      // 后端为mock时切换到公开演示结果，避免把占位随机数呈现为产品结论。
      setAnalysisPayload(await buildStaticDemoPayload());
      dom.engineLabel.textContent = t("engine.demo", "产品演示模式，当前结果仅展示工作流");
      showToast(t("toast.demo", "当前服务处于产品演示模式，结论用于展示工作流，不代表对上传文件的真实鉴定。"));
    } else {
      setAnalysisPayload(payload);
      dom.engineLabel.textContent = t("engine.private", "私有模型服务已连接，仅返回产品级结论");
    }
  } catch (error) {
    setAnalysisPayload(await buildStaticDemoPayload());
    dom.engineLabel.textContent = t("engine.demo", "产品演示模式，当前结果仅展示工作流");
    showToast(`${t("toast.serviceFallback", "私有分析服务暂不可用，已切换至产品演示结果。")}${error?.message ? ` ${error.message}` : ""}`);
  } finally {
    document.body.classList.remove("is-analyzing");
    dom.stageStatusLabel.textContent = t("evidence.chainReady", "传播链路已识别");
  }
}

function shouldUseStaticDemo() {
  return window.location.protocol === "file:" || /\.github\.io$/i.test(window.location.hostname);
}

async function buildStaticDemoPayload(options = {}) {
  const item = options.caseItem || state.activeCase || sampleCases[0];
  const source = state.currentDataUrl || await loadFlagshipImageDataUrl();
  const views = await makeStaticPropagationViews(source);
  const report = buildStaticReport(item);
  return {
    backend: "static-demo",
    file_name: state.currentFile?.name || "flagship-event.jpg",
    probability_ai_generated: item.probability,
    confidence: item.confidence,
    risk_level: item.decision === "hold" ? "high" : item.decision === "review" ? "medium" : "low",
    label: item.decision === "allow" ? "real" : "ai_generated",
    decision: item.decision,
    uncertainty: localizeUncertainty(item.uncertainty),
    report,
    propagation_views: views,
    image: { width: 800, height: 1200, mode: "RGB" }
  };
}

async function makeStaticPropagationViews(dataUrl) {
  return [
    { id: "current", label: t("view.current", "当前版本"), data_url: dataUrl, size: "800 × 1200", filter: "grayscale(1) contrast(1.28) brightness(.82)" },
    { id: "jpeg", label: t("view.jpeg", "JPEG 重压缩"), data_url: dataUrl, size: "640 × 960", filter: "grayscale(1) contrast(1.42) brightness(.74)" },
    { id: "resize", label: t("view.resize", "跨平台缩放"), data_url: dataUrl, size: "480 × 720", filter: "grayscale(1) contrast(1.18) blur(.35px)" },
    { id: "screen", label: t("view.screen", "截图传播"), data_url: dataUrl, size: "720 × 1080", filter: "grayscale(.78) contrast(1.3) brightness(.88)" },
    { id: "share", label: t("view.share", "多次转发"), data_url: dataUrl, size: "360 × 540", filter: "grayscale(1) contrast(1.5) blur(.65px)" }
  ];
}

function buildStaticReport(item = state.activeCase || sampleCases[0]) {
  const narrative = caseText(item, "summary") || item.narrative;
  const action = caseText(item, "action") || item.action;
  const notes = [1, 2, 3]
    .map((index) => t(`case.${item.id}.note${index}`, item.evidence?.[index - 1]))
    .filter(Boolean);
  return {
    case_id: item.code,
    conclusion: decisionLabel(item.decision),
    decision: item.decision,
    summary: narrative,
    recommended_action: action,
    uncertainty: localizeUncertainty(item.uncertainty),
    sections: [
      { title: t("report.conclusion", "检测结论"), body: narrative },
      { title: t("report.propagation", "传播链路证据"), body: t("report.propagationBody", "系统对当前版本、重压缩、缩放、截图和多次转发版本进行了并列复核。") },
      { title: t("report.action", "处置建议"), body: action }
    ],
    notes,
    disclaimer: t("report.disclaimer", "该结果为技术辅助风险信号，不替代司法鉴定或来源调查。")
  };
}

function setAnalysisPayload(payload) {
  const normalized = normalizePayload(payload);
  state.activePayload = normalized;
  state.propagationViews = normalized.propagation_views;
  renderDecision(normalized);
  renderViews(normalized);
  renderReviewer(normalized);
  updateCustodySummary(normalized);
  resizeForensicCanvas();
}

function normalizePayload(payload) {
  const probability = clamp(Number(payload.ai_probability ?? payload.probability_ai_generated ?? state.activeCase.probability), 0, 1);
  const confidence = clamp(Number(payload.confidence ?? state.activeCase.confidence), 0, 1);
  const riskLevel = String(payload.risk_level || (probability >= 0.7 ? "high" : probability >= 0.4 ? "medium" : "low"));
  const decision = String(payload.decision || (riskLevel === "high" ? "hold" : riskLevel === "medium" ? "review" : "allow"));
  const report = payload.report || buildStaticReport(state.activeCase);
  return {
    backend: String(payload.backend || ""),
    file_name: sanitizeFilename(payload.file_name || state.currentFile?.name || "flagship-event.jpg"),
    probability_ai_generated: probability,
    confidence,
    risk_level: riskLevel,
    decision,
    uncertainty: localizeUncertainty(payload.uncertainty || report.uncertainty || state.activeCase.uncertainty || "中等"),
    report: {
      conclusion: String(report.conclusion || decisionLabel(decision)),
      summary: String(report.summary || caseText(state.activeCase, "summary")),
      recommended_action: String(report.recommended_action || caseText(state.activeCase, "action")),
      sections: Array.isArray(report.sections) ? report.sections : buildStaticReport(state.activeCase).sections,
      notes: Array.isArray(report.notes) ? report.notes : [...state.activeCase.evidence],
      disclaimer: String(report.disclaimer || "该结果为技术辅助风险信号，不替代司法鉴定或来源调查。")
    },
    propagation_views: Array.isArray(payload.propagation_views) && payload.propagation_views.length
      ? payload.propagation_views.map((view, index) => ({
          id: String(view.id || `view-${index}`),
          label: String(view.label || `传播版本 ${index + 1}`),
          data_url: String(view.data_url || state.currentDataUrl),
          size: view.width && view.height ? `${view.width} × ${view.height}` : String(view.size || "传播版本"),
          filter: String(view.filter || "grayscale(1) contrast(1.22)")
        }))
      : []
  };
}

function renderDecision(payload) {
  const verdicts = {
    hold: [t("decision.hold.en", "SUSPEND"), t("decision.hold.local", "暂缓发布")],
    review: [t("decision.review.en", "REVIEW"), t("decision.review.local", "人工复核")],
    allow: [t("decision.allow.en", "RELEASE"), t("decision.allow.local", "允许使用")]
  };
  const [english, chinese] = verdicts[payload.decision] || verdicts.review;
  dom.decisionPanel.dataset.decision = payload.decision;
  dom.decisionTitle.innerHTML = `${escapeHtml(english)}<br><em>${escapeHtml(chinese)}</em>`;
  restartCssAnimation(dom.decisionTitle, "stamp-enter");
  dom.riskProbability.textContent = formatPercent(payload.probability_ai_generated);
  dom.confidenceValue.textContent = formatPercent(payload.confidence);
  dom.uncertaintyValue.textContent = localizeUncertainty(payload.uncertainty);
  dom.recommendedAction.textContent = payload.report.recommended_action;
  typeWriterEffect(dom.machineNarrative, payload.report.summary);
  dom.evidenceList.innerHTML = payload.report.notes.slice(0, 4).map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  restartCssAnimation(dom.evidenceList, "evidence-list-decoding");
  const now = new Date();
  dom.decisionTimestamp.textContent = `${now.toISOString().slice(11, 19)} UTC`;
}

function restartCssAnimation(element, className) {
  element.classList.remove(className);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  window.requestAnimationFrame(() => element.classList.add(className));
}

function typeWriterEffect(element, text, speed = 14) {
  const value = String(text || "");
  narrativeAnimationToken += 1;
  const token = narrativeAnimationToken;
  if (!value || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    element.removeAttribute("aria-label");
    element.textContent = value;
    return;
  }

  element.setAttribute("aria-label", value);
  element.innerHTML = '<span class="typewriter-output" aria-hidden="true"></span><span class="typewriter-cursor" aria-hidden="true">&#9608;</span>';
  const output = element.querySelector(".typewriter-output");
  const cursor = element.querySelector(".typewriter-cursor");
  let startedAt = null;

  const draw = (timestamp) => {
    if (token !== narrativeAnimationToken) return;
    if (startedAt === null) startedAt = timestamp;
    const length = Math.min(value.length, Math.max(1, Math.floor((timestamp - startedAt) / speed)));
    output.textContent = value.slice(0, length);
    if (length < value.length) {
      window.requestAnimationFrame(draw);
    } else {
      cursor.remove();
    }
  };
  window.requestAnimationFrame(draw);
}

function renderViews(payload) {
  const views = payload.propagation_views.length
    ? payload.propagation_views
    : [{ id: "current", label: t("view.current", "当前版本"), data_url: state.currentDataUrl, size: "CURRENT", filter: "grayscale(1)" }];
  state.propagationViews = views;
  dom.viewGrid.innerHTML = views.slice(0, 5).map((view, index) => `
    <button class="evidence-version" type="button" data-view-index="${index}" aria-pressed="${index === 0}">
      <span>V${String(index + 1).padStart(2, "0")}</span>
      <span><strong>${escapeHtml(view.label)}</strong><small>${escapeHtml(view.size)}</small></span>
    </button>
  `).join("");
  dom.viewGrid.querySelectorAll("[data-view-index]").forEach((button) => {
    button.addEventListener("click", () => selectEvidenceView(Number(button.dataset.viewIndex)));
  });
  selectEvidenceView(0, { record: false });
}

function selectEvidenceView(index, options = {}) {
  const view = state.propagationViews[index];
  if (!view) return;
  state.activeViewIndex = index;
  dom.processedImage.src = view.data_url || state.currentDataUrl;
  dom.previewImage.src = view.data_url || state.currentDataUrl;
  dom.reviewerImage.src = state.currentDataUrl;
  dom.processedImage.style.filter = view.filter || "grayscale(1) contrast(1.22)";
  dom.stageViewLabel.textContent = view.label.toUpperCase();
  dom.stageStatusLabel.textContent = index === 0
    ? t("evidence.chainReady", "传播链路已识别")
    : t("evidence.parallelReview", "传播版本并列复核");
  dom.viewGrid.querySelectorAll("[data-view-index]").forEach((button) => {
    button.setAttribute("aria-pressed", String(Number(button.dataset.viewIndex) === index));
  });
  if (options.record !== false) {
    addCustodyEvent("DESK-EDITOR", `Propagation view ${view.label} inspected`, "APPENDED");
  }
  window.setTimeout(resizeForensicCanvas, 0);
}

function bindDossierControls() {
  const syncComparisonSplit = () => {
    dom.evidenceViewport.style.setProperty("--split", `${dom.compareRange.value}%`);
  };
  dom.compareRange.addEventListener("input", syncComparisonSplit);
  syncComparisonSplit();
  document.querySelectorAll("[data-annotation]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-annotation]").forEach((item) => item.classList.toggle("active", item === button));
      const target = button.dataset.annotation === "plate" ? { x: 0.34, y: 0.66 } : { x: 0.62, y: 0.28 };
      drawForensics(target);
      addCustodyEvent("DESK-EDITOR", `Anomaly ${button.dataset.annotation} opened as marginalia`, "APPENDED");
    });
  });
}

function setupForensicCanvas() {
  if (!dom.evidenceViewport || !dom.forensicCanvas) return;
  const resizeObserver = "ResizeObserver" in window ? new ResizeObserver(resizeForensicCanvas) : null;
  resizeObserver?.observe(dom.evidenceViewport);
  window.addEventListener("resize", resizeForensicCanvas);
  dom.processedImage.addEventListener("load", resizeForensicCanvas);

  dom.evidenceViewport.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse" || touchLensLocked) return;
    showForensicLens();
  });
  dom.evidenceViewport.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse" || touchLensLocked) return;
    positionForensicLens(event.clientX, event.clientY);
  });
  dom.evidenceViewport.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "mouse" || touchLensLocked) return;
    hideForensicLens();
  });
  dom.evidenceViewport.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse") return;
    touchPointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  dom.evidenceViewport.addEventListener("pointerup", (event) => {
    if (event.pointerType === "mouse" || !touchPointerStart || touchPointerStart.id !== event.pointerId) return;
    const travel = Math.hypot(event.clientX - touchPointerStart.x, event.clientY - touchPointerStart.y);
    touchPointerStart = null;
    if (travel > 12) return;
    if (touchLensLocked) {
      setForensicLensLocked(false);
    } else {
      setForensicLensLocked(true);
      positionForensicLens(event.clientX, event.clientY, { touch: true });
    }
  });
  dom.evidenceViewport.addEventListener("pointercancel", () => { touchPointerStart = null; });
  dom.evidenceViewport.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && touchLensLocked) {
      setForensicLensLocked(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      document.querySelector("[data-annotation=\"plate\"]")?.click();
    }
  });
}

function showForensicLens() {
  const wasHidden = dom.forensicLens.hidden;
  dom.forensicLens.hidden = false;
  if (wasHidden) restartCssAnimation(dom.forensicLens, "lens-enter");
}

function hideForensicLens() {
  dom.forensicLens.hidden = true;
  dom.forensicLens.classList.remove("lens-enter");
  drawForensics();
}

function setForensicLensLocked(locked) {
  touchLensLocked = Boolean(locked);
  dom.evidenceViewport.setAttribute("data-lens-locked", String(touchLensLocked));
  if (touchLensLocked) {
    showForensicLens();
    dom.stageStatusLabel.textContent = t("evidence.lensLocked", "取证透镜已锁定，再次轻点释放");
  } else {
    hideForensicLens();
    dom.stageStatusLabel.textContent = t("evidence.chainReady", "传播链路已识别");
  }
}

function positionForensicLens(clientX, clientY, options = {}) {
  const rect = dom.evidenceViewport.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const pointer = {
    x: clamp((clientX - rect.left) / rect.width, 0, 1),
    y: clamp((clientY - rect.top) / rect.height, 0, 1)
  };
  const visualOffset = options.touch ? 72 : 0;
  const visual = {
    x: clamp(pointer.x, 0.08, 0.92),
    y: clamp((clientY - rect.top - visualOffset) / rect.height, 0.1, 0.9)
  };
  showForensicLens();
  dom.forensicLens.style.left = `${visual.x * 100}%`;
  dom.forensicLens.style.top = `${visual.y * 100}%`;
  drawForensics(pointer);
}

function resizeForensicCanvas() {
  if (!dom.forensicCanvas || dom.evidenceViewport.hidden) return;
  const rect = dom.evidenceViewport.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  dom.forensicCanvas.width = Math.round(rect.width * ratio);
  dom.forensicCanvas.height = Math.round(rect.height * ratio);
  dom.forensicCanvas.style.width = `${rect.width}px`;
  dom.forensicCanvas.style.height = `${rect.height}px`;
  drawForensics();
}

function drawForensics(pointer) {
  const canvas = dom.forensicCanvas;
  const rect = dom.evidenceViewport.getBoundingClientRect();
  if (!canvas.width || !canvas.height || !rect.width || !rect.height) return;
  const ratio = canvas.width / rect.width;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.strokeStyle = "rgba(211, 47, 47, .92)";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(rect.width * 0.26, rect.height * 0.52, rect.width * 0.17, rect.height * 0.19);
  ctx.strokeRect(rect.width * 0.55, rect.height * 0.15, rect.width * 0.18, rect.height * 0.24);
  ctx.setLineDash([]);

  if (pointer) {
    const x = pointer.x * rect.width;
    const y = pointer.y * rect.height;
    const radius = Math.min(86, rect.width * 0.1);
    const heat = ctx.createRadialGradient(x, y, 0, x, y, radius);
    heat.addColorStop(0, "rgba(211,47,47,.38)");
    heat.addColorStop(0.55, "rgba(217,119,6,.18)");
    heat.addColorStop(1, "rgba(211,47,47,0)");
    ctx.fillStyle = heat;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    ctx.strokeStyle = "rgba(255,255,255,.86)";
    ctx.strokeRect(x - 78, y - 78, 156, 156);
  }
}

function renderWaterfall() {
  dom.waterfallFeed.innerHTML = state.waterfallRows.map((row) => {
    const high = row.decision === "HOLD";
    const decisionClass = high ? "risk" : row.decision === "REVIEW" ? "caution" : "credible";
    return `
      <div class="intercept-row ${high ? "high" : ""} ${row.fresh ? "new" : ""}" role="row">
        <span role="cell">${escapeHtml(row.time)}</span>
        <span role="cell">${escapeHtml(row.ingress)}</span>
        <span role="cell">${escapeHtml(row.asset)}</span>
        <span role="cell" class="${decisionClass}"><i class="state-block ${decisionClass}"></i> ${escapeHtml(row.decision)}</span>
        ${high
          ? `<button type="button" data-intercept-case="geopolitical">${escapeHtml(t("case.open", "提取案宗"))}</button>`
          : `<span role="cell">${escapeHtml(row.route)}</span>`}
      </div>
    `;
  }).join("");
  dom.waterfallFeed.querySelectorAll("[data-intercept-case]").forEach((button) => {
    button.addEventListener("click", () => loadSampleCase(button.dataset.interceptCase));
  });
}

function startRadarFeed() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  window.setInterval(() => {
    state.waterfallRows.forEach((row) => { row.fresh = false; });
    const high = Math.random() > 0.82;
    const review = !high && Math.random() > 0.72;
    const now = new Date();
    state.waterfallRows.unshift({
      id: `live-${now.getTime()}`,
      time: now.toISOString().slice(11, 19),
      ingress: ["NEWSROOM-API", "PLATFORM-TNS", "BRAND-WATCH", "WIRE-DESK"][Math.floor(Math.random() * 4)],
      asset: `ASSET-${Math.floor(1000 + Math.random() * 8999)}.JPG`,
      decision: high ? "HOLD" : review ? "REVIEW" : "ALLOW",
      route: high ? "DOSSIER" : review ? "HUMAN" : "AUTO",
      fresh: high
    });
    state.waterfallRows = state.waterfallRows.slice(0, 18);
    dom.intakeRate.textContent = `${Math.floor(172 + Math.random() * 28)}/min`;
    dom.queueCount.textContent = String(sampleCases.length).padStart(2, "0");
    renderWaterfall();
  }, 5200);
}

function startQuarantineCountdowns() {
  window.setInterval(() => {
    dom.casePicker.querySelectorAll("[data-countdown]").forEach((node) => {
      const next = Math.max(0, Number(node.dataset.countdown) - 1);
      node.dataset.countdown = String(next);
      node.textContent = formatCountdown(next);
    });
  }, 1000);
}

function startSystemClock() {
  const render = () => {
    const now = new Date();
    dom.systemClock.textContent = `${now.toISOString().slice(11, 19)} UTC`;
    dom.systemClock.dateTime = now.toISOString();
  };
  render();
  window.setInterval(render, 1000);
}

function startThroughputWave() {
  const canvas = dom.throughputCanvas;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let phase = 0;
  let previousTimestamp = 0;
  let frameId = 0;
  const metrics = { width: 0, height: 0, ratio: 0 };

  const resizeCanvas = () => {
    const width = Math.max(220, canvas.clientWidth || 320);
    const height = Math.max(24, canvas.clientHeight || 24);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (metrics.width === width && metrics.height === height && metrics.ratio === ratio) return;
    metrics.width = width;
    metrics.height = height;
    metrics.ratio = ratio;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  };

  const draw = (timestamp = 0) => {
    resizeCanvas();
    const { width, height, ratio } = metrics;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.beginPath();
    for (let x = 0; x <= width; x += 4) {
      const spike = x > width * 0.62 && x < width * 0.67 ? Math.sin((x - width * 0.62) * 0.9) * 7 : 0;
      const y = height / 2 + Math.sin(x * 0.08 + phase) * 2 + Math.sin(x * 0.023 + phase * 0.4) * 2 + spike;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "#1A1A1A";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#D32F2F";
    ctx.fillRect(width * 0.64, height / 2 - 1, 3, 3);
    const elapsed = previousTimestamp ? Math.min(40, timestamp - previousTimestamp) : 16.67;
    previousTimestamp = timestamp;
    phase += 0.15 * (elapsed / 16.67);
    if (!reduced && !document.hidden) frameId = window.requestAnimationFrame(draw);
  };

  const resizeObserver = "ResizeObserver" in window ? new ResizeObserver(resizeCanvas) : null;
  resizeObserver?.observe(canvas);
  window.addEventListener("resize", resizeCanvas, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      window.cancelAnimationFrame(frameId);
      frameId = 0;
      return;
    }
    if (!reduced && !frameId) {
      previousTimestamp = 0;
      frameId = window.requestAnimationFrame(draw);
    }
  });

  resizeCanvas();
  if (reduced) draw(0);
  else frameId = window.requestAnimationFrame(draw);
}

function bindReportControls() {
  dom.saveHtmlReportButton.addEventListener("click", saveHtmlReport);
  dom.printReportButton.addEventListener("click", printReport);
  dom.downloadJsonButton.addEventListener("click", downloadJsonReport);
  dom.copyReportButton.addEventListener("click", copyReport);
}

function reportText(payload = state.activePayload) {
  if (!payload) return t("report.none", "ShareGuard暂无可用案宗。");
  return [
    `${t("report.title", "ShareGuard影像鉴真报告")} / CASE #${state.activeCase.code}`,
    `${t("report.decisionLabel", "处置结论")}：${decisionLabel(payload.decision)}`,
    `${t("report.riskLabel", "AI生成风险")}：${formatPercent(payload.probability_ai_generated)}`,
    `${t("report.confidenceLabel", "系统置信度")}：${formatPercent(payload.confidence)}`,
    `${t("report.actionLabel", "建议动作")}：${payload.report.recommended_action}`,
    `${t("report.testimonyLabel", "机器证词")}：${payload.report.summary}`,
    `${t("report.statementLabel", "声明")}：${payload.report.disclaimer}`
  ].join("\n");
}

function buildReportHtml(payload = state.activePayload) {
  const report = payload || normalizePayload(awaitableStaticPayload());
  const sections = report.report.sections.map((section) => `
    <section><h2>${escapeHtml(section.title || "记录")}</h2><p>${escapeHtml(section.body || "-")}</p></section>
  `).join("");
  return `<!doctype html>
<html lang="${escapeHtml(i18n?.getLocale() || "zh-CN")}"><head><meta charset="utf-8"><title>${escapeHtml(t("report.title", "ShareGuard影像鉴真报告"))}</title>
<style>body{margin:40px;color:#1A1A1A;background:#F7F5F0;font-family:Arial,sans-serif;line-height:1.65}header,section{padding:18px 0;border-bottom:1px solid #1A1A1A}h1,h2{font-family:Georgia,serif}small{font-family:monospace}.risk{color:#D32F2F}</style></head>
<body><header><small>CASE #${escapeHtml(state.activeCase.code)}</small><h1>${escapeHtml(t("report.title", "ShareGuard影像鉴真报告"))}</h1></header>
<section><h2 class="risk">${escapeHtml(decisionLabel(report.decision))}</h2><p>${escapeHtml(report.report.summary)}</p><p><strong>${escapeHtml(t("report.actionLabel", "建议动作"))}：</strong>${escapeHtml(report.report.recommended_action)}</p></section>
${sections}<section><small>${escapeHtml(report.report.disclaimer)}</small></section></body></html>`;
}

function saveHtmlReport() {
  downloadBlob(buildReportHtml(), `${reportFileStem()}.html`, "text/html;charset=utf-8");
  addCustodyEvent("DESK-EDITOR", "HTML report exported", "APPENDED");
}

function printReport() {
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    showToast("浏览器阻止了打印窗口，请允许弹出窗口后重试。");
    return;
  }
  printWindow.opener = null;
  printWindow.document.open();
  printWindow.document.write(buildReportHtml());
  printWindow.document.close();
  printWindow.addEventListener("load", () => printWindow.print(), { once: true });
  addCustodyEvent("DESK-EDITOR", "Print/PDF report requested", "APPENDED");
}

function downloadJsonReport() {
  const payload = {
    case_id: state.activeCase.code,
    generated_at: new Date().toISOString(),
    decision: state.activePayload?.decision,
    ai_probability: state.activePayload?.probability_ai_generated,
    confidence: state.activePayload?.confidence,
    report: state.activePayload?.report
  };
  downloadBlob(JSON.stringify(payload, null, 2), `${reportFileStem()}.json`, "application/json");
  addCustodyEvent("DESK-EDITOR", "Sanitized JSON report exported", "APPENDED");
}

async function copyReport() {
  try {
    await navigator.clipboard.writeText(reportText());
    showToast(t("toast.reportCopied", "案宗摘要已复制。"));
    addCustodyEvent("DESK-EDITOR", "Decision brief copied", "APPENDED");
  } catch {
    showToast(t("toast.clipboardFailed", "当前浏览器无法写入剪贴板。"));
  }
}

function reportFileStem() {
  return `ShareGuard-${state.activeCase.code}-${new Date().toISOString().slice(0, 10)}`;
}

function downloadBlob(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bindReviewerControls() {
  dom.openReviewerButton.addEventListener("click", () => switchView("reviewer"));
  dom.reviewForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = dom.reviewerComment.value.trim();
    if (!text) return;
    const note = {
      time: new Date().toISOString().slice(11, 16),
      actor: "Reviewer",
      text
    };
    state.reviewerNotes.push(note);
    dom.reviewerComment.value = "";
    persistReviewerNotes();
    renderReviewerNotes();
    addCustodyEvent("REVIEWER", `Marginalia added: ${text.slice(0, 80)}`, "APPENDED");
    showToast(t("toast.reviewSaved", "旁注已写入保全日志。"));
  });
}

function renderReviewer(payload = state.activePayload) {
  if (!payload) return;
  dom.reviewerTitle.textContent = `CASE #${state.activeCase.code}`;
  dom.reviewerVerdict.textContent = payload.decision === "hold" ? "SUSPEND PUBLICATION" : payload.decision === "review" ? "HUMAN REVIEW REQUIRED" : "RELEASE APPROVED";
  dom.reviewerNarrative.textContent = payload.report.summary;
  dom.reviewerImage.src = state.currentDataUrl;
}

function renderReviewerNotes() {
  if (!dom.reviewThread) return;
  dom.reviewThread.innerHTML = state.reviewerNotes.map((note) => `
    <article class="review-note">
      <time>${escapeHtml(note.time)} / ${escapeHtml(note.actor)}</time>
      <p>${escapeHtml(note.key ? t(note.key, note.text) : note.text)}</p>
    </article>
  `).join("");
}

function persistReviewerNotes() {
  try {
    window.localStorage.setItem("shareguard-review-notes", JSON.stringify(state.reviewerNotes.slice(-20)));
  } catch {
    // Controlled review remains usable when storage is unavailable.
  }
}

function loadStoredReviewerNotes() {
  try {
    const stored = JSON.parse(window.localStorage.getItem("shareguard-review-notes") || "null");
    if (Array.isArray(stored) && stored.length) {
      state.reviewerNotes = stored.filter((note) => note && note.text && note.actor).slice(-20);
      renderReviewerNotes();
    }
  } catch {
    // Ignore malformed local review state.
  }
}

function bindDialogControls() {
  dom.forceReleaseButton.addEventListener("click", () => dom.releaseDialog.showModal());
  dom.releaseDialog.addEventListener("close", () => {
    if (dom.releaseDialog.returnValue !== "confirm") return;
    addCustodyEvent("DESK-EDITOR", "Human override recorded; model decision remains unchanged", "OVERRIDE");
    dom.recommendedAction.textContent = t("release.overrideAction", "人工覆盖：允许使用，保留原始系统结论");
    showToast(t("toast.override", "人工覆盖已记录，模型结论未被修改。"));
  });
  dom.sealButton.addEventListener("click", runSealingRitual);
  dom.downloadSgdButton.addEventListener("click", () => {
    if (!state.evidencePackageBlob) return;
    downloadBlob(state.evidencePackageBlob, state.evidencePackageName, "application/vnd.shareguard.dossier+json");
  });
}

async function runSealingRitual() {
  dom.sealDialog.showModal();
  dom.sealTitle.textContent = t("seal.working", "正在生成证据包");
  dom.sealLog.textContent = "";
  dom.sealResult.hidden = true;
  dom.sealButton.disabled = true;
  const steps = [
    "[01] FREEZE CURRENT DOSSIER STATE",
    "[02] NORMALIZE MEDIA METADATA",
    "[03] APPEND CHAIN-OF-CUSTODY EVENTS",
    "[04] COMPUTE SHA-256 FINGERPRINT",
    "[05] GENERATE ECDSA P-256 SIGNING KEY",
    "[06] SIGN CANONICAL EVIDENCE MANIFEST",
    "[07] ASSEMBLE SHAREGUARD .SGD PACKAGE"
  ];

  try {
    for (const step of steps.slice(0, 3)) await appendSealLog(step);
    const evidencePackage = await createEvidencePackage(state.activePayload);
    for (const step of steps.slice(3)) await appendSealLog(step);
    await appendSealLog(`[OK] CRYPTO PROVIDER ${evidencePackage.crypto_provider.toUpperCase()}`);
    if (!evidencePackage.manifest.media.embedded) {
      await appendSealLog("[OK] DETACHED MEDIA MODE / ORIGINAL FILE REQUIRED FOR VERIFICATION");
    }
    await appendSealLog(`[OK] DIGEST ${evidencePackage.digest.slice(0, 24).toUpperCase()}...`);
    await appendSealLog("[OK] BROWSER DEMONSTRATOR SIGNATURE VERIFIED LOCALLY");
    state.evidencePackageBlob = new Blob(
      [JSON.stringify(evidencePackage, null, 2)],
      { type: "application/vnd.shareguard.dossier+json" }
    );
    state.evidencePackageName = `${reportFileStem()}.sgd`;
    dom.sealTitle.textContent = t("seal.complete", "证据包已签封");
    dom.sealResult.hidden = false;
    dom.custodySeal.textContent = evidencePackage.digest.slice(0, 12).toUpperCase();
    addCustodyEvent("SEAL-SERVICE", `Evidence package signed: ${evidencePackage.digest.slice(0, 16)}`, "SEALED");
  } catch (error) {
    await appendSealLog(`[ERROR] ${String(error?.message || "SIGNING FAILED")}`);
    dom.sealTitle.textContent = t("seal.failed", "签封失败");
  } finally {
    dom.sealButton.disabled = false;
  }
}

async function appendSealLog(line) {
  dom.sealLog.textContent += `${line}\n`;
  dom.sealLog.scrollTop = dom.sealLog.scrollHeight;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  await wait(reduced ? 10 : 150);
}

async function createEvidencePackage(payload = state.activePayload) {
  if (!payload) throw new Error("NO ACTIVE DOSSIER");
  if (!window.crypto?.subtle) throw new Error("WEB CRYPTO API UNAVAILABLE");
  const mediaBlob = await mediaBlobForSeal();
  const mimeType = mediaBlob.type || state.currentFile?.type || "image/jpeg";
  const embedMedia = mediaBlob.size <= EMBED_MEDIA_LIMIT_BYTES;
  const manifest = {
    format: "ShareGuard-Dossier-1",
    case: {
      id: state.activeCase.code,
      title: caseText(state.activeCase, "title"),
      source: state.activeCase.source,
      handler: state.activeCase.handler,
      recorded_at: state.activeCase.timestamp
    },
    media: {
      file_name: payload.file_name,
      mime_type: mimeType,
      byte_size: mediaBlob.size
    },
    decision: {
      action: payload.decision,
      label: decisionLabel(payload.decision),
      ai_probability: payload.probability_ai_generated,
      confidence: payload.confidence,
      uncertainty: payload.uncertainty,
      narrative: payload.report.summary,
      recommended_action: payload.report.recommended_action
    },
    provenance: state.propagationViews.map((view, index) => ({
      order: index + 1,
      label: view.label,
      dimensions: view.size
    })),
    custody: state.custodyEvents.map((event) => ({ ...event })),
    sealed_at: new Date().toISOString(),
    signing_scope: "browser-demonstrator"
  };

  let cryptoResult;
  let cryptoProvider = "web-worker";
  try {
    cryptoResult = await runCryptoWorker({
      manifest,
      mediaBuffer: await mediaBlob.arrayBuffer(),
      mimeType,
      embedMedia
    });
  } catch (_workerError) {
    cryptoProvider = "main-thread-fallback";
    cryptoResult = await runMainThreadCrypto({
      manifest,
      mediaBuffer: await mediaBlob.arrayBuffer(),
      mimeType,
      embedMedia
    });
  }

  return {
    format: "ShareGuard-Evidence-Package-1",
    manifest: cryptoResult.manifest,
    digest_algorithm: "SHA-256",
    digest: cryptoResult.digest,
    signature_algorithm: "ECDSA-P256-SHA256",
    signature: cryptoResult.signature,
    public_key: cryptoResult.public_key,
    crypto_provider: cryptoProvider,
    trust_notice: "Browser demonstrator signature. Production packages require the private ShareGuard root certificate service."
  };
}

async function mediaBlobForSeal() {
  if (state.currentFile instanceof Blob) return state.currentFile;
  return dataUrlToBlob(state.currentDataUrl || await loadFlagshipImageDataUrl());
}

function runCryptoWorker({ manifest, mediaBuffer, mimeType, embedMedia }) {
  if (!("Worker" in window)) return Promise.reject(new Error("WEB WORKER UNAVAILABLE"));
  return new Promise((resolve, reject) => {
    const worker = new Worker("crypto-worker.js");
    const requestId = `seal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("CRYPTO WORKER TIMEOUT"));
    }, 30_000);

    const finish = (callback, value) => {
      window.clearTimeout(timeout);
      worker.terminate();
      callback(value);
    };
    worker.addEventListener("message", (event) => {
      if (event.data?.requestId !== requestId) return;
      if (event.data.success) finish(resolve, event.data);
      else finish(reject, new Error(event.data?.error || "WORKER CRYPTO FAILED"));
    });
    worker.addEventListener("error", () => finish(reject, new Error("WORKER INITIALIZATION FAILED")));
    worker.postMessage(
      { type: "seal", requestId, manifest, mediaBuffer, mimeType, embedMedia },
      [mediaBuffer]
    );
  });
}

async function runMainThreadCrypto({ manifest, mediaBuffer, mimeType, embedMedia }) {
  const mediaBytes = new Uint8Array(mediaBuffer);
  const mediaDigestBuffer = await crypto.subtle.digest("SHA-256", mediaBytes);
  const sealedManifest = JSON.parse(JSON.stringify(manifest));
  sealedManifest.media.sha256 = bufferToHex(mediaDigestBuffer);
  sealedManifest.media.embedded = Boolean(embedMedia);
  sealedManifest.media.data_url = embedMedia ? bytesToDataUrl(mediaBytes, mimeType) : null;

  const encoded = new TextEncoder().encode(stableStringify(sealedManifest));
  const digestBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const signatureBuffer = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    encoded
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.publicKey,
    signatureBuffer,
    encoded
  );
  if (!valid) throw new Error("LOCAL SIGNATURE SELF-CHECK FAILED");
  return {
    success: true,
    manifest: sealedManifest,
    digest: bufferToHex(digestBuffer),
    signature: arrayBufferToBase64(signatureBuffer),
    public_key: await crypto.subtle.exportKey("jwk", keyPair.publicKey)
  };
}

function renderCustodyLog() {
  if (!dom.custodyLog) return;
  dom.custodyLog.innerHTML = state.custodyEvents.map((event) => `
    <div class="custody-row" role="row">
      <span role="cell">${escapeHtml(event.time)}</span>
      <span role="cell">${escapeHtml(event.actor)}</span>
      <span role="cell">${escapeHtml(event.event)}</span>
      <span role="cell">${escapeHtml(event.integrity)}</span>
    </div>
  `).join("");
  dom.custodyEvents.textContent = String(state.custodyEvents.length).padStart(2, "0");
}

function addCustodyEvent(actor, event, integrity) {
  const now = new Date();
  state.custodyEvents.push({
    time: now.toISOString().slice(11, 19),
    actor,
    event,
    integrity
  });
  state.custodyEvents = state.custodyEvents.slice(-80);
  renderCustodyLog();
}

function updateCustodySummary(payload) {
  dom.custodyFile.textContent = payload.file_name;
  dom.custodyDecision.textContent = payload.decision.toUpperCase();
  dom.custodyCaseCode.textContent = state.activeCase.code;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function bytesToDataUrl(bytes, mimeType) {
  const chunkSize = 0x8000;
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    let binary = "";
    for (let index = 0; index < chunk.length; index += 1) binary += String.fromCharCode(chunk[index]);
    chunks.push(binary);
  }
  return `data:${mimeType};base64,${btoa(chunks.join(""))}`;
}

async function loadFlagshipImageDataUrl() {
  if (!assetDataUrlPromise) {
    assetDataUrlPromise = fetch("assets/flagship-event.jpg", { cache: "force-cache" })
      .then((response) => {
        if (!response.ok) throw new Error("flagship asset unavailable");
        return response.blob();
      })
      .then(blobToDataUrl)
      .catch(() => "assets/flagship-event.jpg");
  }
  return assetDataUrlPromise;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(new Error("影像读取失败")));
    reader.readAsDataURL(blob);
  });
}

function fileToDataUrl(file) {
  return blobToDataUrl(file);
}

function releaseCurrentObjectUrl() {
  if (!state.currentObjectUrl) return;
  URL.revokeObjectURL(state.currentObjectUrl);
  state.currentObjectUrl = null;
}

async function dataUrlToBlob(dataUrl) {
  if (String(dataUrl).startsWith("data:")) return decodeDataUrl(dataUrl);
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error("影像读取失败");
  return response.blob();
}

function decodeDataUrl(dataUrl) {
  const value = String(dataUrl);
  const commaIndex = value.indexOf(",");
  if (!value.startsWith("data:") || commaIndex < 0) throw new Error("INVALID DATA URL");
  const metadata = value.slice(5, commaIndex);
  const payload = value.slice(commaIndex + 1);
  const mimeType = metadata.split(";", 1)[0] || "application/octet-stream";
  if (!metadata.split(";").includes("base64")) {
    return new Blob([decodeURIComponent(payload)], { type: mimeType });
  }
  const binary = atob(payload.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

function readImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve({ width: image.naturalWidth, height: image.naturalHeight }));
    image.addEventListener("error", () => reject(new Error("无法读取影像尺寸")));
    image.src = dataUrl;
  });
}

function sanitizeFilename(name) {
  return String(name || "image").replace(/\\/g, "/").split("/").pop().replace(/[^\w.\-\u4e00-\u9fff]/g, "_").slice(0, 120) || "image";
}

function decisionLabel(decision) {
  return decision === "hold"
    ? t("decision.hold.local", "暂缓发布")
    : decision === "allow"
      ? t("decision.allow.local", "允许使用")
      : t("decision.review.local", "人工复核");
}

function localizeUncertainty(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["low", "低"].includes(normalized)) return t("uncertainty.low", "低");
  if (["high", "高"].includes(normalized)) return t("uncertainty.high", "高");
  return t("uncertainty.medium", "中等");
}

async function refreshLocalizedView() {
  renderCasePicker();
  renderCaseContext(state.activeCase);
  if (state.activePayload?.backend === "static-demo") {
    const activeViewIndex = state.activeViewIndex;
    setAnalysisPayload(await buildStaticDemoPayload({ caseItem: state.activeCase }));
    selectEvidenceView(Math.min(activeViewIndex, state.propagationViews.length - 1), { record: false });
  } else if (state.activePayload) {
    renderDecision(state.activePayload);
    renderReviewer(state.activePayload);
  }
  dom.engineLabel.textContent = state.activePayload?.backend && state.activePayload.backend !== "static-demo"
    ? t("engine.private", "私有模型服务已连接，仅返回产品级结论")
    : t("engine.demo", "产品演示模式，当前结果仅展示工作流");
}

function formatPercent(value) {
  return `${Math.round(clamp(Number(value), 0, 1) * 100)}%`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCountdown(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `T-${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  dom.toast.textContent = String(message);
  dom.toast.hidden = false;
  toastTimer = window.setTimeout(() => { dom.toast.hidden = true; }, 3600);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;"
  })[character]);
}

function awaitableStaticPayload() {
  return {
    probability_ai_generated: state.activeCase.probability,
    confidence: state.activeCase.confidence,
    decision: state.activeCase.decision,
    uncertainty: state.activeCase.uncertainty,
    report: buildStaticReport(state.activeCase),
    propagation_views: state.propagationViews,
    file_name: state.currentFile?.name || "flagship-event.jpg"
  };
}

document.addEventListener("DOMContentLoaded", init);
