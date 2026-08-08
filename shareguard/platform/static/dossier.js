"use strict";

const i18n = window.ShareGuardI18n;
const runtimeConfig = window.ShareGuardRuntime || {};
const EMPTY_CASE = Object.freeze({
  id: "upload",
  code: "PENDING",
  title: "用户导入影像核验",
  workflow: "真实模型核验",
  source: "USER UPLOAD",
  handler: "CURRENT SESSION",
  timestamp: "—",
  briefing: "导入影像后，系统将调用云端筛查引擎生成本次文件的图像级判定。",
  deadlineSeconds: 0
});
const modelConnection = {
  apiBaseUrl: normalizeApiBaseUrl(runtimeConfig.apiBaseUrl),
  username: "",
  password: "",
  connected: false,
  pendingAnalysis: false,
  status: "idle"
};

const state = {
  activeCase: { ...EMPTY_CASE },
  activeCaseRecord: null,
  activePayload: null,
  activeViewIndex: 0,
  currentFile: null,
  currentDataUrl: "",
  currentObjectUrl: null,
  propagationViews: [],
  annotations: [],
  provenance: { available: false, hops: [], reason: "source_data_not_provided" },
  waterfallRows: [],
  custodyEvents: [],
  reviewerNotes: [],
  evidencePackageBlob: null,
  evidencePackageName: ""
};

const dom = {};
let toastTimer = null;
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

function cacheDom() {
  [
    "imageInput", "engineLabel", "systemClock", "intakeRate", "queueCount",
    "throughputCanvas", "radarView", "dossierView", "custodyView", "reviewerView",
    "waterfallFeed", "quarantineZone", "quarantineCount", "casePicker",
    "stageCaseCode", "dossierTitle", "caseTimestamp", "caseSource", "caseHandler",
    "caseContext", "evidenceViewport", "processedImage", "previewImage", "originalLayer",
    "forensicCanvas", "forensicLens", "compareRange", "stageViewLabel", "emptyEvidenceState",
    "splitIndicator", "comparisonControl",
    "stageStatusLabel", "viewGrid", "fileMeta", "decisionPanel", "decisionTimestamp",
    "decisionTitle", "riskProbability", "confidenceValue", "uncertaintyValue",
    "recommendedAction", "machineNarrative", "evidenceList", "forceReleaseButton",
    "sealButton", "saveHtmlReportButton", "printReportButton", "downloadJsonButton",
    "copyReportButton", "custodyLog", "custodyCaseCode", "custodyFile",
    "custodyDecision", "custodyEvents", "custodySeal", "footerCase",
    "openReviewerButton", "reviewerImage", "reviewerTitle", "reviewerVerdict",
    "reviewerNarrative", "reviewForm", "reviewerComment", "reviewThread",
    "sealDialog", "sealTitle", "sealLog", "sealResult", "downloadSgdButton",
    "releaseDialog", "confirmReleaseButton", "dropOverlay", "toast",
    "modelConnectionButton", "modelConnectionLabel", "modelConnectionDialog",
    "modelConnectionForm", "modelEndpoint", "modelUsername", "modelPassword",
    "modelConnectionStatus", "modelDisconnectButton", "closeModelConnectionButton",
    "annotationLayer", "provenanceBody", "provenanceStatus"
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
  bindModelConnectionControls();
  renderModelConnectionState();
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

  initializeProductionWorkbench();
}

function initializeProductionWorkbench() {
  renderCaseContext(state.activeCase);
  renderAnalysisUnavailable(t("model.awaitingUpload", "导入影像后开始真实模型分析。"));
  dom.stageStatusLabel.textContent = t("model.awaitingUploadShort", "尚未导入影像");
  dom.fileMeta.textContent = t("model.awaitingUploadShort", "尚未导入影像");
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
  dom.casePicker.innerHTML = `<div class="capability-empty">${escapeHtml(t("radar.notConnected", "未接入实时业务队列，不显示模拟案件。"))}</div>`;
  dom.quarantineCount.textContent = "00";
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
    id: "upload",
    code,
    title: t("case.upload.title", "用户导入影像核验"),
    workflow: t("workflow.live", "真实模型核验"),
    source: "EDITORIAL DROPZONE",
    handler: "CURRENT SESSION",
    timestamp: `${stamp.toISOString().slice(0, 19).replace("T", " ")} UTC`,
    briefing: t("case.upload.briefing", "该影像由当前工作台导入，系统将调用云端筛查引擎生成图像级判定与本图衍生鲁棒性视图。")
  };
  state.activePayload = null;
  state.annotations = [];
  state.provenance = { available: false, hops: [], reason: "source_data_not_provided" };
  state.propagationViews = [];
  dom.emptyEvidenceState.hidden = true;
  dom.processedImage.hidden = false;
  dom.originalLayer.hidden = false;
  dom.reviewerImage.hidden = false;
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
  dom.stageStatusLabel.textContent = t("evidence.building", "正在调用云端筛查引擎");
  let analysisCompleted = false;
  try {
    if (usesRemoteModel() && !modelConnection.connected) {
      modelConnection.pendingAnalysis = true;
      renderAnalysisUnavailable(t("model.waiting", "等待连接云端推理后开始真实分析。"));
      openModelConnectionDialog({
        state: "idle",
        message: t("model.authorizationRequired", "请输入访问凭证以启动这张影像的真实模型分析。")
      });
      return;
    }

    const body = new FormData();
    if (!state.currentFile) throw new Error(t("model.noImage", "尚未选择待分析影像。"));
    body.append("image", state.currentFile, state.currentFile.name);
    const requestOptions = {
      method: "POST",
      body,
      headers: { "Accept-Language": i18n?.getLocale() || "zh-CN" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer"
    };
    if (usesRemoteModel()) {
      requestOptions.mode = "cors";
      requestOptions.headers.Authorization = basicAuthorization(
        modelConnection.username,
        modelConnection.password
      );
    }
    const response = await fetch(
      usesRemoteModel() ? privateApiUrl("/v1/analyze") : "/v1/analyze",
      requestOptions
    );
    if (response.status === 401 && usesRemoteModel()) {
      modelConnection.username = "";
      modelConnection.password = "";
      modelConnection.connected = false;
      modelConnection.pendingAnalysis = true;
      modelConnection.status = "error";
      renderModelConnectionState();
      renderAnalysisUnavailable(t("model.invalid", "账号或密码无效，请重新输入。"));
      openModelConnectionDialog({
        state: "error",
        message: t("model.invalid", "账号或密码无效，请重新输入。")
      });
      return;
    }
    if (!response.ok) {
      throw new Error(`分析服务返回 ${response.status}`);
    }
    const isDemoResponse = response.headers.get("X-ShareGuard-Demo") === "true";
    const payload = await response.json();
    if (isDemoResponse || payload.backend === "mock") {
      throw new Error(t("model.demoRejected", "正式工作台拒绝演示模型响应。"));
    } else {
      setAnalysisPayload(payload);
      analysisCompleted = true;
      if (usesRemoteModel()) {
        modelConnection.status = "connected";
        modelConnection.connected = true;
        renderModelConnectionState();
      }
    }
  } catch (error) {
    if (usesRemoteModel()) {
      modelConnection.username = "";
      modelConnection.password = "";
      modelConnection.connected = false;
      modelConnection.pendingAnalysis = true;
      modelConnection.status = "error";
      renderModelConnectionState();
      renderAnalysisUnavailable(t("model.analysisUnavailable", "真实模型未返回结果，请检查本机服务或稍后重试。"));
      showToast(`${t("model.analysisUnavailable", "真实模型未返回结果，请检查本机服务或稍后重试。")}${error?.message ? ` ${error.message}` : ""}`);
    } else {
      renderAnalysisUnavailable(t("model.analysisUnavailable", "真实模型未返回结果，请检查服务后重试。"));
      showToast(`${t("model.analysisUnavailable", "真实模型未返回结果，请检查服务后重试。")}${error?.message ? ` ${error.message}` : ""}`);
    }
  } finally {
    document.body.classList.remove("is-analyzing");
    dom.stageStatusLabel.textContent = analysisCompleted
      ? t("evidence.analysisReady", "真实模型分析已完成")
      : t("model.noFinding", "尚未生成真实模型结论");
  }
}

function isConfiguredRemotePage() {
  const allowedOrigin = normalizePageOrigin(runtimeConfig.allowedPageOrigin);
  return Boolean(allowedOrigin) && allowedOrigin === window.location.origin;
}

function usesRemoteModel() {
  return Boolean(modelConnection.apiBaseUrl) && isConfiguredRemotePage();
}

function normalizePageOrigin(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "https:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

function normalizeApiBaseUrl(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value));
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function privateApiUrl(path) {
  return new URL(path, `${modelConnection.apiBaseUrl}/`).toString();
}

function basicAuthorization(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `Basic ${window.btoa(binary)}`;
}

function renderAnalysisUnavailable(message) {
  narrativeAnimationToken += 1;
  state.activePayload = null;
  state.annotations = [];
  state.provenance = { available: false, hops: [], reason: "source_data_not_provided" };
  renderViews({ propagation_views: [] });
  renderAnnotations();
  renderProvenance();
  dom.decisionPanel.dataset.decision = "review";
  const waitingForUpload = !state.currentFile;
  const noResultEn = waitingForUpload ? "NO RESULT" : t("model.noDecisionEn", "MODEL OFFLINE");
  const noResultLocal = waitingForUpload ? t("model.noResult", "尚无模型结果") : t("model.noDecision", "尚无鉴真结论");
  dom.decisionTitle.innerHTML = `${escapeHtml(noResultEn)}<br><em>${escapeHtml(noResultLocal)}</em>`;
  dom.riskProbability.textContent = "—";
  dom.confidenceValue.textContent = "—";
  dom.uncertaintyValue.textContent = "—";
  dom.recommendedAction.textContent = waitingForUpload
    ? t("model.importAction", "导入影像以开始真实分析")
    : t("model.connectAction", "连接云端推理后重新分析");
  dom.machineNarrative.textContent = message;
  dom.evidenceList.innerHTML = "";
  dom.forceReleaseButton.disabled = true;
  dom.sealButton.disabled = true;
  [dom.saveHtmlReportButton, dom.printReportButton, dom.downloadJsonButton, dom.copyReportButton].forEach((button) => { button.disabled = true; });
  dom.reviewerVerdict.textContent = noResultEn;
  dom.reviewerNarrative.textContent = message;
}

function setAnalysisPayload(payload) {
  const normalized = normalizePayload(payload);
  state.activePayload = normalized;
  state.activeCaseRecord = normalized.case;
  if (normalized.case_id) {
    state.activeCase = {
      ...state.activeCase,
      id: normalized.case_id,
      code: normalized.case_id,
      timestamp: normalized.case?.created_at || state.activeCase.timestamp
    };
    renderCaseContext(state.activeCase);
  }
  state.propagationViews = normalized.propagation_views;
  state.annotations = normalized.localization.annotations;
  state.provenance = normalized.provenance;
  renderLiveEngineState(normalized);
  renderDecision(normalized);
  renderViews(normalized);
  renderAnnotations();
  renderProvenance();
  renderReviewer(normalized);
  updateCustodySummary(normalized);
  resizeForensicCanvas();
  dom.forceReleaseButton.disabled = false;
  dom.sealButton.disabled = !normalized.case?.human_decision;
  [dom.saveHtmlReportButton, dom.printReportButton, dom.downloadJsonButton, dom.copyReportButton].forEach((button) => { button.disabled = false; });
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("模型响应格式无效");
  const scoreValue = Number(payload.model_score ?? payload.ai_probability ?? payload.probability_ai_generated);
  const marginValue = Number(payload.decision_margin ?? payload.confidence);
  const decision = String(payload.decision || "");
  if (!Number.isFinite(scoreValue) || !Number.isFinite(marginValue) || !["hold", "review", "allow"].includes(decision)) {
    throw new Error("模型响应缺少必要的真实判定字段");
  }
  const modelScore = clamp(scoreValue, 0, 1);
  const decisionMargin = clamp(marginValue, 0, 1);
  const riskLevel = String(payload.risk_level || "uncertain");
  const report = payload.report && typeof payload.report === "object" ? payload.report : {};
  const scoreNotice = String(payload.score_notice || report.score_notice || "模型分数未经概率校准，不代表图像为AI生成的事实概率。");
  const rawViews = Array.isArray(payload.robustness_views)
    ? payload.robustness_views
    : Array.isArray(payload.propagation_views)
      ? payload.propagation_views
      : [];
  const generatedViews = rawViews.map((view, index) => ({
    id: String(view.id || `robustness-${index}`),
    label: String(view.label || `鲁棒性视图 ${index + 1}`),
    data_url: String(view.image_data_url || view.data_url || ""),
    size: view.width && view.height ? `${view.width} × ${view.height}` : String(view.size || "衍生视图"),
    filter: "none",
    origin: String(view.origin || "generated_from_upload"),
    observed: view.observed === true
  })).filter((view) => view.data_url);
  const currentView = state.currentDataUrl
    ? [{ id: "current", label: t("view.uploaded", "上传原图"), data_url: state.currentDataUrl, size: "SOURCE", filter: "none", origin: "uploaded", observed: true }]
    : [];
  const localization = payload.localization && payload.localization.available === true
    ? {
        available: true,
        annotations: Array.isArray(payload.localization.annotations)
          ? payload.localization.annotations.map(normalizeAnnotation).filter(Boolean)
          : [],
        reason: ""
      }
    : { available: false, annotations: [], reason: String(payload.localization?.reason || "image_level_model") };
  const provenance = payload.provenance && payload.provenance.available === true
    ? {
        available: true,
        hops: Array.isArray(payload.provenance.hops) ? payload.provenance.hops.map(normalizeProvenanceHop).filter(Boolean) : [],
        reason: ""
      }
    : { available: false, hops: [], reason: String(payload.provenance?.reason || "source_data_not_provided") };
  const reliability = normalizeReliability(payload.reliability);
  const detectorEngine = String(payload.detector_engine || payload.model_version || "unknown");
  const decisionLayer = String(payload.decision_layer || "shareguard-dossier-v1");
  const shadowEvaluation = normalizeShadowEvaluation(payload.shadow_evaluation);
  const summary = String(report.summary || payload.recommended_action || "模型已返回图像级判定。");
  const recommendedAction = String(report.recommended_action || payload.recommended_action || "请结合来源信息进行人工复核。");
  const notes = Array.isArray(report.notes)
    ? report.notes
    : Array.isArray(report.review_notes)
      ? report.review_notes
      : [scoreNotice, "当前模型未返回像素级定位。", "当前请求未提供可信传播链路数据。"];
  return {
    backend: String(payload.backend || ""),
    case_id: String(payload.case_id || ""),
    version_id: String(payload.version_id || ""),
    case_status: String(payload.case_status || ""),
    chain_head: String(payload.chain_head || ""),
    case: payload.case && typeof payload.case === "object" ? payload.case : null,
    request_id: String(payload.request_id || ""),
    model_version: String(payload.model_version || ""),
    detector_engine: detectorEngine,
    engine_role: String(payload.engine_role || "primary"),
    decision_layer: decisionLayer,
    shadow_evaluation: shadowEvaluation,
    file_name: sanitizeFilename(payload.file_name || state.currentFile?.name || "upload"),
    model_score: modelScore,
    score_kind: String(payload.score_kind || "uncalibrated_ai_generation_score"),
    decision_margin: decisionMargin,
    score_notice: scoreNotice,
    probability_ai_generated: modelScore,
    confidence: decisionMargin,
    risk_level: riskLevel,
    decision,
    uncertainty: String(payload.uncertainty || report.uncertainty || "unknown"),
    reliability,
    localization,
    provenance,
    report: {
      conclusion: String(report.conclusion || decisionLabel(decision)),
      summary,
      recommended_action: recommendedAction,
      sections: Array.isArray(report.sections) ? report.sections : [],
      notes: notes.map(String),
      disclaimer: String(report.disclaimer || "该结果为技术辅助风险信号，不替代司法鉴定或来源调查。")
    },
    propagation_views: [...currentView, ...generatedViews]
  };
}

function normalizeAnnotation(annotation, index) {
  if (!annotation || typeof annotation !== "object") return null;
  const x = Number(annotation.x);
  const y = Number(annotation.y);
  const width = Number(annotation.width ?? annotation.w ?? 0);
  const height = Number(annotation.height ?? annotation.h ?? 0);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    id: String(annotation.id || `annotation-${index + 1}`),
    label: String(annotation.label || `A${index + 1}`),
    title: String(annotation.title || "模型定位"),
    detail: String(annotation.detail || ""),
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    width: clamp(width, 0, 1),
    height: clamp(height, 0, 1)
  };
}

function normalizeProvenanceHop(hop, index) {
  if (!hop || typeof hop !== "object") return null;
  return {
    order: Number.isFinite(Number(hop.order)) ? Number(hop.order) : index + 1,
    source: String(hop.source || "UNKNOWN SOURCE"),
    timestamp: String(hop.timestamp || "—"),
    operation: String(hop.operation || "RECORDED")
  };
}

function normalizeReliability(value) {
  const performed = value?.performed === true;
  const reason = String(value?.reason || "secondary_check_not_required");
  const status = ["inconsistent", "consistent", "not_required"].includes(value?.status)
    ? value.status
    : performed
      ? "consistent"
      : "not_required";
  return { performed, status, reason };
}

function normalizeShadowEvaluation(value) {
  const status = ["agree", "disagree", "unavailable", "not_sampled", "disabled"].includes(value?.status)
    ? value.status
    : "disabled";
  return {
    performed: value?.performed === true,
    status,
    engine: String(value?.engine || "shareguard-protected-screening-engine"),
    affects_decision: false
  };
}

function renderLiveEngineState(payload) {
  if (!dom.engineLabel || !payload) return;
  const engineIndicator = dom.engineLabel.previousElementSibling;
  engineIndicator?.classList.remove("caution", "risk");
  engineIndicator?.classList.add("credible");
  dom.engineLabel.textContent = t(
    "engine.liveProtected",
    "在线筛查：ShareGuard 受保护筛查引擎 / ShareGuard 决策层"
  );
  dom.engineLabel.title = `${payload.model_version || "shareguard-screening"} / ${payload.decision_layer}`;
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
  dom.riskProbability.textContent = formatModelScore(payload.model_score);
  dom.riskProbability.title = payload.score_notice;
  dom.confidenceValue.textContent = formatModelScore(payload.decision_margin);
  dom.confidenceValue.title = t("decision.marginHelp", "决策余量表示模型输出与决策边界的相对距离，不是准确率或事实置信度。");
  dom.uncertaintyValue.textContent = localizeBoundaryState(payload.uncertainty, payload.reliability);
  dom.recommendedAction.textContent = payload.report.recommended_action;
  typeWriterEffect(dom.machineNarrative, payload.report.summary);
  dom.evidenceList.innerHTML = payload.report.notes.slice(0, 4).map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  restartCssAnimation(dom.evidenceList, "evidence-list-decoding");
  const now = new Date();
  dom.decisionTimestamp.textContent = `${now.toISOString().slice(11, 19)} UTC`;
}

function renderAnnotations() {
  if (!dom.annotationLayer) return;
  const annotations = Array.isArray(state.annotations) ? state.annotations : [];
  if (!annotations.length) {
    const label = state.activePayload
      ? t("evidence.noLocalization", "图像级判定 / 模型未提供局部定位")
      : t("evidence.awaitingLocalization", "等待模型结果 / 尚无定位数据");
    dom.annotationLayer.innerHTML = `<div class="localization-status">${escapeHtml(label)}</div>`;
    drawForensics();
    return;
  }
  dom.annotationLayer.innerHTML = annotations.map((annotation, index) => `
    <button class="annotation-point" type="button" data-annotation-index="${index}"
      style="left:${annotation.x * 100}%;top:${annotation.y * 100}%;width:${Math.max(annotation.width * 100, 3)}%;height:${Math.max(annotation.height * 100, 3)}%"
      aria-label="${escapeHtml(annotation.title)}">
      <span class="annotation-index">${escapeHtml(annotation.label)}</span>
      <span class="annotation-copy"><b>${escapeHtml(annotation.title)}</b><small>${escapeHtml(annotation.detail)}</small></span>
    </button>
  `).join("");
  dom.annotationLayer.querySelectorAll("[data-annotation-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.annotationIndex);
      const annotation = state.annotations[index];
      dom.annotationLayer.querySelectorAll("[data-annotation-index]").forEach((item) => item.classList.toggle("active", item === button));
      if (annotation) drawForensics({ x: annotation.x + annotation.width / 2, y: annotation.y + annotation.height / 2 });
      addCustodyEvent("DESK-EDITOR", `Model localization ${annotation?.label || index + 1} inspected`, "APPENDED");
    });
  });
  drawForensics();
}

function renderProvenance() {
  if (!dom.provenanceBody || !dom.provenanceStatus) return;
  const provenance = state.provenance || { available: false, hops: [] };
  if (!provenance.available || !provenance.hops.length) {
    dom.provenanceStatus.textContent = "NO SOURCE DATA";
    dom.provenanceBody.className = "capability-empty";
    dom.provenanceBody.textContent = t("provenance.unavailable", "未提供来源或传播链路数据，系统不会生成虚构拓扑。");
    return;
  }
  dom.provenanceStatus.textContent = `${provenance.hops.length} VERIFIED HOPS`;
  dom.provenanceBody.className = "provenance-hop-list";
  dom.provenanceBody.innerHTML = provenance.hops
    .sort((a, b) => a.order - b.order)
    .map((hop) => `<div><span>${escapeHtml(hop.source)}</span><b>${escapeHtml(hop.operation)}</b><time>${escapeHtml(hop.timestamp)}</time></div>`)
    .join("");
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
  const suppliedViews = Array.isArray(payload.propagation_views) ? payload.propagation_views : [];
  const views = suppliedViews.length
    ? suppliedViews
    : state.currentDataUrl
      ? [{ id: "current", label: t("view.uploaded", "上传原图"), data_url: state.currentDataUrl, size: "SOURCE", filter: "none", origin: "uploaded" }]
      : [];
  state.propagationViews = views;
  dom.compareRange.disabled = views.length < 2;
  if (!views.length) {
    dom.viewGrid.innerHTML = `<div class="capability-empty">${escapeHtml(t("evidence.noViews", "导入影像后显示本图衍生鲁棒性视图。"))}</div>`;
    dom.emptyEvidenceState.hidden = false;
    dom.processedImage.hidden = true;
    dom.originalLayer.hidden = true;
    dom.splitIndicator.hidden = true;
    dom.comparisonControl.hidden = true;
    dom.stageViewLabel.textContent = "NO ASSET";
    return;
  }
  dom.emptyEvidenceState.hidden = true;
  dom.processedImage.hidden = false;
  dom.originalLayer.hidden = false;
  dom.splitIndicator.hidden = false;
  dom.comparisonControl.hidden = false;
  dom.viewGrid.innerHTML = views.slice(0, 6).map((view, index) => `
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
  dom.previewImage.src = state.currentDataUrl;
  dom.reviewerImage.src = state.currentDataUrl;
  dom.processedImage.style.filter = view.filter || "none";
  dom.stageViewLabel.textContent = view.label.toUpperCase();
  dom.stageStatusLabel.textContent = index === 0
    ? t("evidence.imageLevel", "真实模型已返回图像级结论")
    : t("evidence.robustnessReview", "本图生成的鲁棒性视图 / 非真实传播证据");
  dom.viewGrid.querySelectorAll("[data-view-index]").forEach((button) => {
    button.setAttribute("aria-pressed", String(Number(button.dataset.viewIndex) === index));
  });
  if (options.record !== false) {
    addCustodyEvent("DESK-EDITOR", `Generated robustness view ${view.label} inspected`, "APPENDED");
  }
  window.setTimeout(resizeForensicCanvas, 0);
}

function bindDossierControls() {
  const syncComparisonSplit = () => {
    dom.evidenceViewport.style.setProperty("--split", `${dom.compareRange.value}%`);
  };
  dom.compareRange.addEventListener("input", syncComparisonSplit);
  syncComparisonSplit();
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
      setForensicLensLocked(!touchLensLocked);
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
    dom.stageStatusLabel.textContent = state.activePayload
      ? t("evidence.imageLevel", "真实模型已返回图像级结论")
      : t("model.noFinding", "尚未生成真实模型结论");
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
  const annotations = Array.isArray(state.annotations) ? state.annotations : [];
  if (annotations.length) {
    ctx.strokeStyle = "rgba(211, 47, 47, .92)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    annotations.forEach((annotation) => {
      ctx.strokeRect(
        rect.width * annotation.x,
        rect.height * annotation.y,
        rect.width * annotation.width,
        rect.height * annotation.height
      );
    });
    ctx.setLineDash([]);
  }

  if (pointer) {
    const x = pointer.x * rect.width;
    const y = pointer.y * rect.height;
    const radius = Math.min(78, rect.width * 0.1);
    ctx.strokeStyle = "rgba(255,255,255,.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x - radius, y - radius, radius * 2, radius * 2);
    ctx.beginPath();
    ctx.moveTo(x - 12, y);
    ctx.lineTo(x + 12, y);
    ctx.moveTo(x, y - 12);
    ctx.lineTo(x, y + 12);
    ctx.stroke();
  }
}

function renderWaterfall() {
  if (!state.waterfallRows.length) {
    dom.waterfallFeed.innerHTML = `<div class="capability-empty" role="row"><span role="cell">${escapeHtml(t("radar.notConnected", "未接入实时业务队列，不显示模拟流量。"))}</span></div>`;
    return;
  }
  dom.waterfallFeed.innerHTML = state.waterfallRows.map((row) => {
    const high = row.decision === "HOLD";
    const decisionClass = high ? "risk" : row.decision === "REVIEW" ? "caution" : "credible";
    return `
      <div class="intercept-row ${high ? "high" : ""} ${row.fresh ? "new" : ""}" role="row">
        <span role="cell">${escapeHtml(row.time)}</span>
        <span role="cell">${escapeHtml(row.ingress)}</span>
        <span role="cell">${escapeHtml(row.asset)}</span>
        <span role="cell" class="${decisionClass}"><i class="state-block ${decisionClass}"></i> ${escapeHtml(row.decision)}</span>
        <span role="cell">${escapeHtml(row.route)}</span>
      </div>
    `;
  }).join("");
}

function startRadarFeed() {
  dom.intakeRate.textContent = "—";
  dom.queueCount.textContent = "00";
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
    `${t("report.scoreLabel", "AI生成模型分数")}：${formatModelScore(payload.model_score)}`,
    `${t("report.marginLabel", "决策余量")}：${formatModelScore(payload.decision_margin)}`,
    `${t("report.scoreNoticeLabel", "分数说明")}：${payload.score_notice}`,
    `${t("report.actionLabel", "建议动作")}：${payload.report.recommended_action}`,
    `${t("report.testimonyLabel", "机器证词")}：${payload.report.summary}`,
    `${t("report.statementLabel", "声明")}：${payload.report.disclaimer}`
  ].join("\n");
}

function buildReportHtml(payload = state.activePayload) {
  if (!payload) throw new Error("NO LIVE MODEL RESULT");
  const report = payload;
  const sections = report.report.sections.map((section) => `
    <section><h2>${escapeHtml(section.title || "记录")}</h2>${Array.isArray(section.items)
      ? `<ul>${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : `<p>${escapeHtml(section.body || "-")}</p>`}</section>
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
    model_score: state.activePayload?.model_score,
    score_kind: state.activePayload?.score_kind,
    decision_margin: state.activePayload?.decision_margin,
    score_notice: state.activePayload?.score_notice,
    localization: state.activePayload?.localization,
    provenance: state.activePayload?.provenance,
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

function bindModelConnectionControls() {
  dom.modelEndpoint.value = modelConnection.apiBaseUrl || window.location.origin;
  dom.modelConnectionButton.hidden = !usesRemoteModel();
  dom.modelConnectionButton.addEventListener("click", () => {
    openModelConnectionDialog();
  });
  dom.closeModelConnectionButton.addEventListener("click", () => {
    dom.modelPassword.value = "";
    dom.modelConnectionDialog.close();
  });
  dom.modelConnectionDialog.addEventListener("cancel", () => {
    dom.modelPassword.value = "";
  });
  dom.modelConnectionForm.addEventListener("submit", connectPrivateModel);
  dom.modelDisconnectButton.addEventListener("click", disconnectPrivateModel);
}

function openModelConnectionDialog(options = {}) {
  if (!usesRemoteModel()) return;
  dom.modelEndpoint.value = modelConnection.apiBaseUrl;
  if (!dom.modelUsername.value) {
    dom.modelUsername.value = modelConnection.username || "shareguard-demo";
  }
  if (options.message) {
    setModelConnectionStatus(options.state || "idle", options.message);
  }
  if (!dom.modelConnectionDialog.open) {
    dom.modelConnectionDialog.showModal();
  }
  window.setTimeout(() => dom.modelPassword.focus(), 0);
}

async function connectPrivateModel(event) {
  event.preventDefault();
  if (!usesRemoteModel()) return;
  const username = dom.modelUsername.value.trim();
  const password = dom.modelPassword.value;
  if (!username || !password) {
    setModelConnectionStatus("error", t("model.credentialsRequired", "请输入演示账号和访问密码。"));
    return;
  }

  const submitButton = dom.modelConnectionForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  modelConnection.status = "connecting";
  renderModelConnectionState();
  setModelConnectionStatus("connecting", t("model.connecting", "正在验证云端推理网关…"));

  try {
    const response = await fetch(privateApiUrl("/v1/ready"), {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Authorization": basicAuthorization(username, password)
      },
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      referrerPolicy: "no-referrer"
    });
    if (response.status === 401) {
      throw new ModelConnectionError(
        "credentials",
        t("model.invalid", "账号或密码无效，请重新输入。")
      );
    }
    if (!response.ok) {
      throw new ModelConnectionError(
        "gateway",
        `${t("model.unavailable", "云端推理网关暂不可用。")} HTTP ${response.status}`
      );
    }
    const payload = await response.json();
    if (payload.status !== "ready") {
      throw new ModelConnectionError(
        "gateway",
        t("model.notReady", "云端推理服务仍在启动，请稍后重试。")
      );
    }

    modelConnection.username = username;
    modelConnection.password = password;
    modelConnection.connected = true;
    modelConnection.status = "connected";
    dom.modelPassword.value = "";
    setModelConnectionStatus("connected", t("model.connected", "连接成功，真实模型推理已启用。"));
    renderModelConnectionState();
    showToast(t("model.connected", "连接成功，真实模型推理已启用。"));

    const shouldResume = modelConnection.pendingAnalysis;
    modelConnection.pendingAnalysis = false;
    if (shouldResume) {
      dom.modelConnectionDialog.close();
      await analyzeCurrentFile();
    }
  } catch (error) {
    modelConnection.username = "";
    modelConnection.password = "";
    modelConnection.connected = false;
    modelConnection.status = "error";
    dom.modelPassword.value = "";
    setModelConnectionStatus(
      "error",
      error instanceof ModelConnectionError
        ? error.message
        : t("model.networkError", "无法连接云端推理网关，请稍后重试。")
    );
    renderModelConnectionState();
    dom.modelPassword.focus();
  } finally {
    submitButton.disabled = false;
  }
}

function disconnectPrivateModel() {
  modelConnection.username = "";
  modelConnection.password = "";
  modelConnection.connected = false;
  modelConnection.pendingAnalysis = false;
  modelConnection.status = "idle";
  dom.modelPassword.value = "";
  setModelConnectionStatus("idle", t("model.disconnected", "云端推理连接已断开。"));
  renderModelConnectionState();
  if (state.currentFile) {
    renderAnalysisUnavailable(t("model.waiting", "等待连接云端推理后开始真实分析。"));
  }
}

function setModelConnectionStatus(status, message) {
  dom.modelConnectionStatus.dataset.state = status;
  dom.modelConnectionStatus.textContent = message || "";
}

function renderModelConnectionState() {
  if (!dom.modelConnectionButton) return;
  const status = modelConnection.connected ? "connected" : modelConnection.status;
  dom.modelConnectionButton.dataset.state = status;
  dom.modelDisconnectButton.hidden = !modelConnection.connected;
  const labelKey = modelConnection.connected
    ? "model.connectedShort"
    : status === "connecting"
      ? "model.connectingShort"
      : status === "error"
        ? "model.retry"
        : "model.connect";
  const fallback = modelConnection.connected
    ? "模型已连接"
    : status === "connecting"
      ? "正在连接"
      : status === "error"
        ? "重试连接"
        : "连接模型";
  dom.modelConnectionLabel.textContent = t(labelKey, fallback);

  if (!usesRemoteModel()) return;
  const engineIndicator = dom.engineLabel.previousElementSibling;
  engineIndicator?.classList.remove("credible", "caution", "risk");
  if (modelConnection.connected) {
    engineIndicator?.classList.add("credible");
    if (state.activePayload) {
      renderLiveEngineState(state.activePayload);
    } else {
      dom.engineLabel.textContent = t("engine.connected", "云端推理网关已连接，等待实际引擎返回");
    }
  } else if (status === "error") {
    engineIndicator?.classList.add("risk");
    dom.engineLabel.textContent = t("engine.unavailable", "云端推理连接失败，未生成鉴真结论");
  } else {
    engineIndicator?.classList.add("caution");
    dom.engineLabel.textContent = t("engine.awaiting", "等待云端推理授权，凭证不会写入仓库");
  }
}

class ModelConnectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ModelConnectionError";
    this.code = code;
  }
}

async function runSealingRitual() {
  dom.sealDialog.showModal();
  dom.sealTitle.textContent = t("seal.working", "正在生成证据包");
  dom.sealLog.textContent = "";
  dom.sealResult.hidden = true;
  dom.sealButton.disabled = true;
  const steps = [
    "[01] VALIDATE STRUCTURED HUMAN DECISION",
    "[02] FREEZE SERVER CASE PROJECTION",
    "[03] APPEND HASH-LINKED SEAL EVENT",
    "[04] COMPUTE CANONICAL PAYLOAD SHA-256",
    "[05] REQUEST PROTECTED ISSUER SIGNATURE",
    "[06] VERIFY PINNED ISSUER IDENTITY",
    "[07] ASSEMBLE SHAREGUARD .SGD V2 PACKAGE"
  ];

  try {
    for (const step of steps.slice(0, 3)) await appendSealLog(step);
    const evidencePackage = await requestServerEvidencePackage();
    for (const step of steps.slice(3)) await appendSealLog(step);
    await appendSealLog(`[OK] ISSUER ${evidencePackage.issuer}`);
    await appendSealLog(`[OK] KEY ID ${evidencePackage.key_id}`);
    await appendSealLog(`[OK] DIGEST ${evidencePackage.payload_sha256.slice(0, 24).toUpperCase()}...`);
    await appendSealLog("[OK] SERVER SIGNATURE / PINNED TRUST ROOT");
    state.evidencePackageBlob = new Blob(
      [JSON.stringify(evidencePackage, null, 2)],
      { type: "application/vnd.shareguard.dossier+json" }
    );
    state.evidencePackageName = `${reportFileStem()}.sgd`;
    dom.sealTitle.textContent = t("seal.complete", "证据包已签封");
    dom.sealResult.hidden = false;
    dom.custodySeal.textContent = evidencePackage.payload_sha256.slice(0, 12).toUpperCase();
    addCustodyEvent("SEAL-SERVICE", `Trusted evidence package issued: ${evidencePackage.payload_sha256.slice(0, 16)}`, "SEALED");
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

async function requestServerEvidencePackage() {
  const caseId = state.activePayload?.case_id || state.activeCaseRecord?.case_id;
  if (!caseId) throw new Error("PERSISTED CASE REQUIRED");
  if (!state.activeCaseRecord?.human_decision) throw new Error("STRUCTURED HUMAN DECISION REQUIRED");
  const headers = {
    "Accept": "application/vnd.shareguard.dossier+json, application/json",
    "Content-Type": "application/json"
  };
  if (usesRemoteModel()) {
    headers.Authorization = basicAuthorization(modelConnection.username, modelConnection.password);
  }
  const response = await fetch(
    usesRemoteModel()
      ? privateApiUrl(`/v1/cases/${encodeURIComponent(caseId)}/seal`)
      : `/v1/cases/${encodeURIComponent(caseId)}/seal`,
    {
      method: "POST",
      headers,
      body: "{}",
      cache: "no-store",
      credentials: "omit",
      mode: usesRemoteModel() ? "cors" : "same-origin",
      referrerPolicy: "no-referrer"
    }
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `SEAL SERVICE HTTP ${response.status}`);
  }
  if (
    payload?.schema !== "shareguard.sgd.v2"
    || !payload.payload_sha256
    || !payload.signature
    || !payload.key_id
  ) {
    throw new Error("INVALID SERVER EVIDENCE PACKAGE");
  }
  return payload;
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

function releaseCurrentObjectUrl() {
  if (!state.currentObjectUrl) return;
  URL.revokeObjectURL(state.currentObjectUrl);
  state.currentObjectUrl = null;
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

function localizeBoundaryState(value, reliability = null) {
  if (
    reliability?.status === "inconsistent"
    || reliability?.reason === "spatial_score_inconsistency"
  ) {
    return t("reliability.spatialInconsistent", "局部复核不一致");
  }
  const normalized = String(value || "").trim().toLowerCase();
  if (["low", "低"].includes(normalized)) return t("boundary.far", "远离阈值");
  if (["high", "高"].includes(normalized)) return t("boundary.near", "高度接近阈值");
  if (["medium", "中", "中等"].includes(normalized)) return t("boundary.middle", "接近阈值");
  return t("boundary.unknown", "未提供");
}

async function refreshLocalizedView() {
  renderCasePicker();
  renderCaseContext(state.activeCase);
  if (state.activePayload) {
    renderDecision(state.activePayload);
    renderReviewer(state.activePayload);
    renderAnnotations();
    renderProvenance();
  }
  if (usesRemoteModel()) {
    renderModelConnectionState();
  } else {
    if (state.activePayload) renderLiveEngineState(state.activePayload);
    else dom.engineLabel.textContent = t("engine.unavailable", "云端推理未连接，未生成鉴真结论");
  }
}

function formatModelScore(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${clamp(numeric, 0, 1).toFixed(3)} / 1.000` : "—";
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

document.addEventListener("DOMContentLoaded", init);
