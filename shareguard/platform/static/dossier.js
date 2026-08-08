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
const apiClient = window.ShareGuardApi?.createClient({
  baseUrl: usesRemoteModel() ? modelConnection.apiBaseUrl : ""
});

const state = {
  activeCase: { ...EMPTY_CASE },
  activeCaseRecord: null,
  caseSummaries: [],
  metrics: null,
  selectedVersionId: "",
  selectedAnnotationId: "",
  annotationEditing: false,
  annotationDraft: null,
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
    "dropOverlay", "toast",
    "modelConnectionButton", "modelConnectionLabel", "modelConnectionDialog",
    "modelConnectionForm", "modelEndpoint", "modelUsername", "modelPassword",
    "modelConnectionStatus", "modelDisconnectButton", "closeModelConnectionButton",
    "annotationLayer", "provenanceBody", "provenanceStatus",
    "caseRefreshButton", "caseDeleteButton", "versionInput", "versionImportButton",
    "localMediaInput", "localMediaButton", "annotationEditButton", "annotationNote",
    "annotationSaveButton", "annotationClearButton", "provenanceForm", "provenanceChannel",
    "provenanceUrl", "provenanceCapturedAt", "provenanceNote", "feedbackButton",
    "decisionDialog", "decisionForm", "humanDecisionAction", "humanDecisionReason",
    "humanDecisionNote", "closeDecisionButton", "feedbackDialog", "feedbackForm",
    "feedbackOutcome", "feedbackBasis", "closeFeedbackButton", "metricsSummary",
    "metricCases", "metricVersions", "metricDecisions", "metricOverrides",
    "metricLatency", "metricShift"
  ].forEach((id) => {
    dom[id] = document.getElementById(id);
  });
}

function init() {
  cacheDom();
  document.body.classList.toggle("remote-model-enabled", usesRemoteModel());
  bindViewControls();
  bindUploadControls();
  bindDossierControls();
  bindReportControls();
  bindReviewerControls();
  bindDialogControls();
  bindModelConnectionControls();
  bindPersistentWorkflowControls();
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
  const cases = Array.isArray(state.caseSummaries) ? state.caseSummaries : [];
  dom.quarantineCount.textContent = String(cases.length).padStart(2, "0");
  dom.queueCount.textContent = String(cases.filter((item) => item.status !== "sealed").length).padStart(2, "0");
  if (!cases.length) {
    dom.casePicker.innerHTML = `<div class="capability-empty">${escapeHtml(t("radar.empty", "尚无持久案件。导入影像后，案件会在此出现。"))}</div>`;
    return;
  }
  dom.casePicker.innerHTML = cases.map((item) => {
    const decision = item.human_decision?.action || item.latest_machine_recommendation || "review";
    return `
      <article class="quarantine-card" data-status="${escapeHtml(item.status)}">
        <button type="button" data-case-id="${escapeHtml(item.case_id)}">
          <span><b>${escapeHtml(shortCaseId(item.case_id))}</b><time>${escapeHtml(formatUtc(item.updated_at))}</time></span>
          <strong>${escapeHtml(item.title)}</strong>
          <span><small>${escapeHtml(item.version_count)} VERSION${item.version_count === 1 ? "" : "S"}</small><em>${escapeHtml(humanDecisionLabel(decision))}</em></span>
        </button>
      </article>`;
  }).join("");
  dom.casePicker.querySelectorAll("[data-case-id]").forEach((button) => {
    button.addEventListener("click", () => openPersistedCase(button.dataset.caseId));
  });
}

async function refreshPersistentWorkbench(options = {}) {
  if (!apiClient || (usesRemoteModel() && !modelConnection.connected)) return;
  const activeCaseId = options.preserveCase ? state.activeCaseRecord?.case_id : "";
  await Promise.all([loadCaseList(), loadOperationalMetrics()]);
  if (activeCaseId) {
    const current = state.caseSummaries.find((item) => item.case_id === activeCaseId);
    if (!current) resetActiveCase();
  }
}

async function loadCaseList() {
  const payload = await apiClient.listCases();
  state.caseSummaries = Array.isArray(payload?.cases) ? payload.cases : [];
  renderCasePicker();
  renderWaterfall();
  return state.caseSummaries;
}

async function loadOperationalMetrics() {
  const payload = await apiClient.getMetrics();
  const metrics = payload?.metrics || null;
  state.metrics = metrics;
  if (!metrics) return;
  const humanCount = Object.values(metrics.human_decisions || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  dom.metricCases.textContent = String(metrics.case_count ?? 0);
  dom.metricVersions.textContent = String(metrics.version_count ?? 0);
  dom.metricDecisions.textContent = String(humanCount);
  dom.metricOverrides.textContent = String(metrics.override_count ?? 0);
  dom.metricLatency.textContent = Number.isFinite(metrics.latency?.p50_ms) ? `${metrics.latency.p50_ms} ms` : "—";
  const shift = metrics.distribution_shift || {};
  dom.metricShift.textContent = shift.status === "insufficient_data"
    ? `${shift.sample_count || 0}/${shift.minimum_sample_count || 30}`
    : "NO BASELINE";
  dom.metricShift.title = shift.status === "insufficient_data"
    ? "样本不足，仅展示分数分布信号，不解释为准确率漂移。"
    : "尚未建立经验证的参考分布基线。";
  dom.intakeRate.textContent = metrics.latency?.sample_count ? String(metrics.latency.sample_count) : "0";
}

async function openPersistedCase(caseId) {
  try {
    const payload = await apiClient.getCase(caseId);
    const record = payload?.case;
    const version = record?.versions?.at(-1);
    if (!record || !version) throw new Error("案件记录不完整。");
    releaseCurrentObjectUrl();
    state.currentFile = null;
    state.currentDataUrl = "";
    state.activeCase = {
      id: record.case_id,
      code: record.case_id,
      title: record.title,
      workflow: "持久案件复核",
      source: record.declared_provenance?.channel || "DETACHED MEDIA",
      handler: "AUTHENTICATED REVIEWER",
      timestamp: formatUtc(record.created_at),
      briefing: "该案件已从持久证据链重新打开。影像原件不在服务器保存；可在本机重新关联并核对 SHA-256。"
    };
    setAnalysisPayload(payloadFromStoredVersion(record, version));
    renderPersistentCase(record);
    switchView("dossier");
  } catch (error) {
    showApiError(error, "无法打开持久案件。");
  }
}

function payloadFromStoredVersion(record, version) {
  return {
    backend: "persisted-case",
    case_id: record.case_id,
    version_id: version.version_id,
    case_status: record.status,
    chain_head: record.chain_head,
    case: record,
    request_id: version.request_id,
    model_version: version.engine_release,
    engine_release: version.engine_release,
    detector_engine: version.detector_engine,
    decision_layer: version.decision_layer,
    engine_role: "primary",
    file_name: version.file_name,
    media_sha256: version.media_sha256,
    model_score: version.model_score,
    score_kind: version.score_kind,
    decision_margin: version.decision_margin,
    risk_level: version.risk_level,
    decision: version.machine_recommendation,
    uncertainty: version.report?.uncertainty || "unknown",
    reliability: version.reliability,
    calibration: version.calibration,
    policy: version.policy,
    localization: { available: false, reason: "image_level_model", annotations: [] },
    provenance: { available: false, reason: "declared_source_rendered_separately", hops: [] },
    report: version.report || {},
    propagation_views: []
  };
}

function renderPersistentCase(record) {
  const sealed = record.status === "sealed";
  state.activeCaseRecord = record;
  document.body.classList.toggle("case-sealed", sealed);
  state.selectedVersionId = record.versions?.some((item) => item.version_id === state.selectedVersionId)
    ? state.selectedVersionId
    : record.versions?.at(-1)?.version_id || "";
  state.annotations = (record.annotations?.[state.selectedVersionId] || [])
    .map(normalizePersistedAnnotation)
    .filter(Boolean);
  state.provenance = record.declared_provenance
    ? declaredProvenanceView(record.declared_provenance)
    : { available: false, hops: [], reason: "source_data_not_provided" };
  state.custodyEvents = (record.events || []).map((event) => ({
    time: formatUtc(event.created_at),
    actor: String(event.actor_id || "").slice(-10).toUpperCase(),
    event: event.event_type,
    integrity: String(event.event_hash || "").slice(0, 12).toUpperCase()
  }));
  renderCaseContext(state.activeCase);
  renderAnnotations();
  renderProvenance();
  renderCustodyLog();
  dom.custodyDecision.textContent = record.human_decision
    ? humanDecisionLabel(record.human_decision.action).toUpperCase()
    : "HUMAN DECISION PENDING";
  dom.custodySeal.textContent = record.status === "sealed"
    ? String(record.chain_head).slice(0, 12).toUpperCase()
    : "NOT SEALED";
  dom.forceReleaseButton.disabled = sealed;
  dom.feedbackButton.disabled = sealed;
  dom.forceReleaseButton.textContent = record.human_decision
    ? `更新人工决定 · ${humanDecisionLabel(record.human_decision.action)}`
    : "记录人工决定";
  dom.feedbackButton.textContent = record.feedback
    ? `更新结果反馈 · ${feedbackOutcomeLabel(record.feedback.outcome)}`
    : "补录结果反馈";
  dom.caseDeleteButton.disabled = sealed;
  dom.sealButton.disabled = sealed || !record.human_decision;
  dom.versionInput.disabled = sealed;
  dom.versionImportButton.setAttribute("aria-disabled", String(sealed));
  dom.annotationEditButton.disabled = sealed;
  dom.annotationNote.disabled = sealed;
  dom.annotationSaveButton.disabled = sealed;
  dom.annotationClearButton.disabled = sealed;
  populateWorkflowForms(record);
}

async function deleteActiveCase() {
  const record = state.activeCaseRecord;
  if (!record || record.status === "sealed") return;
  if (!window.confirm(`删除未签封案件 ${shortCaseId(record.case_id)}？此操作无法撤销。`)) return;
  try {
    await apiClient.deleteCase(record.case_id);
    resetActiveCase();
    await refreshPersistentWorkbench();
    showToast("案件已删除。");
  } catch (error) {
    showApiError(error, "案件删除失败。");
  }
}

function resetActiveCase() {
  releaseCurrentObjectUrl();
  state.currentFile = null;
  state.currentDataUrl = "";
  state.activeCaseRecord = null;
  state.selectedVersionId = "";
  state.activeCase = { ...EMPTY_CASE };
  document.body.classList.remove("case-sealed");
  initializeProductionWorkbench();
  renderCaseContext(state.activeCase);
}

function renderCaseContext(item) {
  const displayCode = shortCaseId(item.code);
  dom.stageCaseCode.textContent = `CASE #${displayCode}`;
  dom.dossierTitle.textContent = caseText(item, "title");
  dom.caseTimestamp.textContent = item.timestamp;
  dom.caseSource.textContent = item.source;
  dom.caseHandler.textContent = item.handler;
  dom.caseContext.innerHTML = `
    <span>EVENT BRIEFING</span>
    <p>${escapeHtml(caseText(item, "briefing"))}</p>
  `;
  dom.footerCase.textContent = `CASE #${displayCode}`;
  dom.custodyCaseCode.textContent = displayCode;
  dom.reviewerTitle.textContent = `CASE #${displayCode}`;
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
  state.activeCaseRecord = null;
  state.selectedVersionId = "";
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

    if (!state.currentFile) throw new Error(t("model.noImage", "尚未选择待分析影像。"));
    if (!apiClient) throw new Error("SHAREGUARD API CLIENT UNAVAILABLE");
    const payload = await apiClient.analyze(state.currentFile, {
      locale: i18n?.getLocale() || "zh-CN",
      versionRole: "original",
      title: state.activeCase.title
    });
    if (payload.backend === "mock") {
      throw new Error(t("model.demoRejected", "正式工作台拒绝演示模型响应。"));
    } else {
      setAnalysisPayload(payload);
      if (payload.case) renderPersistentCase(payload.case);
      await refreshPersistentWorkbench({ preserveCase: true });
      analysisCompleted = true;
      if (usesRemoteModel()) {
        modelConnection.status = "connected";
        modelConnection.connected = true;
        renderModelConnectionState();
      }
    }
  } catch (error) {
    if (error?.status === 401 && usesRemoteModel()) {
      apiClient?.clearCredentials();
      modelConnection.username = "";
      modelConnection.password = "";
      modelConnection.connected = false;
      modelConnection.pendingAnalysis = true;
      modelConnection.status = "error";
      renderModelConnectionState();
      renderAnalysisUnavailable(t("model.invalid", "账号或密码无效，请重新输入。"));
      openModelConnectionDialog({ state: "error", message: t("model.invalid", "账号或密码无效，请重新输入。") });
      return;
    }
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
  dom.forceReleaseButton.textContent = "记录人工决定";
  dom.feedbackButton.disabled = true;
  dom.feedbackButton.textContent = "补录结果反馈";
  dom.caseDeleteButton.disabled = !state.activeCaseRecord;
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
  state.selectedVersionId = normalized.version_id
    || normalized.case?.versions?.at(-1)?.version_id
    || "";
  state.propagationViews = normalized.propagation_views;
  state.annotations = normalized.case?.annotations?.[state.selectedVersionId]
    || normalized.localization.annotations;
  state.provenance = normalized.case?.declared_provenance
    ? declaredProvenanceView(normalized.case.declared_provenance)
    : normalized.provenance;
  renderLiveEngineState(normalized);
  renderDecision(normalized);
  renderViews(normalized);
  renderAnnotations();
  renderProvenance();
  renderReviewer(normalized);
  updateCustodySummary(normalized);
  resizeForensicCanvas();
  dom.forceReleaseButton.disabled = false;
  dom.feedbackButton.disabled = false;
  dom.caseDeleteButton.disabled = normalized.case?.status === "sealed";
  dom.sealButton.disabled = !normalized.case?.human_decision || normalized.case?.status === "sealed";
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
    engine_release: String(payload.engine_release || payload.model_version || ""),
    media_sha256: String(payload.media_sha256 || ""),
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
    calibration: payload.calibration && typeof payload.calibration === "object" ? payload.calibration : { status: "unavailable" },
    policy: payload.policy && typeof payload.policy === "object" ? payload.policy : {},
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
    id: String(annotation.annotation_id || annotation.id || `annotation-${index + 1}`),
    annotation_id: String(annotation.annotation_id || annotation.id || `annotation-${index + 1}`),
    label: String(annotation.label || `R${index + 1}`),
    title: String(annotation.title || (annotation.origin === "human_reviewer" ? "人工复核标注" : "模型定位")),
    detail: String(annotation.note || annotation.detail || ""),
    note: String(annotation.note || annotation.detail || ""),
    origin: String(annotation.origin || "model_output"),
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

function normalizePersistedAnnotation(annotation, index) {
  return normalizeAnnotation({ ...annotation, origin: "human_reviewer" }, index);
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
    <button class="annotation-point${annotationId(annotation) === state.selectedAnnotationId ? " active" : ""}" type="button" data-annotation-index="${index}" data-origin="${escapeHtml(annotation.origin || "human_reviewer")}"
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
      state.selectedAnnotationId = annotationId(annotation);
      dom.annotationNote.value = String(annotation?.note || annotation?.detail || "");
      dom.annotationLayer.querySelectorAll("[data-annotation-index]").forEach((item) => item.classList.toggle("active", item === button));
      if (annotation) drawForensics({ x: annotation.x + annotation.width / 2, y: annotation.y + annotation.height / 2 });
    });
  });
  drawForensics();
}

function normalizedEvidencePoint(clientX, clientY) {
  const rect = dom.evidenceViewport.getBoundingClientRect();
  return {
    x: clamp((clientX - rect.left) / rect.width, 0, 1),
    y: clamp((clientY - rect.top) / rect.height, 0, 1)
  };
}

function annotationBounds(start, end) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.max(0, Math.max(start.x, end.x) - x),
    height: Math.max(0, Math.max(start.y, end.y) - y)
  };
}

function finishAnnotationDraft(clientX, clientY) {
  if (!state.annotationDraft) return;
  const bounds = annotationBounds(
    state.annotationDraft.start,
    normalizedEvidencePoint(clientX, clientY)
  );
  state.annotationDraft = null;
  if (bounds.width < 0.01 || bounds.height < 0.01) {
    drawForensics();
    showToast("标注区域过小，请拖动框选一个明确区域。");
    return;
  }
  const id = `review-${Date.now().toString(36)}`;
  state.annotations.push({
    annotation_id: id,
    id,
    label: `R${state.annotations.length + 1}`,
    title: "人工复核标注",
    note: dom.annotationNote.value.trim(),
    detail: dom.annotationNote.value.trim(),
    origin: "human_reviewer",
    ...bounds
  });
  state.selectedAnnotationId = id;
  renderAnnotations();
}

function annotationId(annotation) {
  return String(annotation?.annotation_id || annotation?.id || "");
}

function renderProvenance() {
  if (!dom.provenanceBody || !dom.provenanceStatus) return;
  const provenance = state.provenance || { available: false, hops: [] };
  if (provenance.declared) {
    dom.provenanceStatus.textContent = "DECLARED / UNVERIFIED";
    dom.provenanceBody.className = "provenance-declaration";
    dom.provenanceBody.innerHTML = `
      <dl>
        <div><dt>CHANNEL</dt><dd>${escapeHtml(provenance.channel || "—")}</dd></div>
        <div><dt>URL</dt><dd>${provenance.source_url ? `<a href="${escapeHtml(provenance.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(provenance.source_url)}</a>` : "—"}</dd></div>
        <div><dt>CAPTURED</dt><dd>${escapeHtml(formatUtc(provenance.captured_at))}</dd></div>
        <div><dt>NOTE</dt><dd>${escapeHtml(provenance.note || "—")}</dd></div>
      </dl>`;
    return;
  }
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
  const persistedVersions = state.activeCaseRecord?.versions || payload.case?.versions || [];
  const views = suppliedViews.length
    ? suppliedViews
    : state.currentDataUrl
      ? [{ id: "current", label: t("view.uploaded", "上传原图"), data_url: state.currentDataUrl, size: "SOURCE", filter: "none", origin: "uploaded" }]
      : [];
  state.propagationViews = views;
  dom.compareRange.disabled = views.length < 2;
  const versionButtons = persistedVersions.map((version, index) => `
    <button class="evidence-version" type="button" data-version-id="${escapeHtml(version.version_id)}" aria-pressed="${version.version_id === state.selectedVersionId}">
      <span>V${String(index + 1).padStart(2, "0")}</span>
      <span><strong>${escapeHtml(version.role === "original" ? "原始导入" : version.role === "observed_variant" ? "观察传播版本" : "生成压力视图")}</strong><small>${escapeHtml(formatModelScore(version.model_score))}</small></span>
    </button>`).join("");
  const generatedButtons = views
    .map((view, index) => ({ view, index }))
    .filter(({ view }) => view.origin === "generated_from_upload")
    .map(({ view, index }, generatedIndex) => `
    <button class="evidence-version generated" type="button" data-view-index="${index}" aria-pressed="false">
      <span>G${String(generatedIndex + 1).padStart(2, "0")}</span>
      <span><strong>${escapeHtml(view.label)}</strong><small>${escapeHtml(view.origin === "generated_from_upload" ? "GENERATED STRESS VIEW" : view.size)}</small></span>
    </button>`).join("");
  dom.viewGrid.innerHTML = versionButtons || generatedButtons
    ? `${versionButtons}${generatedButtons}`
    : `<div class="capability-empty">${escapeHtml(t("evidence.noViews", "导入影像后显示案件版本。"))}</div>`;
  dom.viewGrid.querySelectorAll("[data-version-id]").forEach((button) => {
    button.addEventListener("click", () => selectStoredVersion(button.dataset.versionId));
  });
  dom.viewGrid.querySelectorAll("[data-view-index]").forEach((button) => {
    button.addEventListener("click", () => selectEvidenceView(Number(button.dataset.viewIndex)));
  });
  if (!views.length) {
    dom.emptyEvidenceState.hidden = false;
    dom.emptyEvidenceState.querySelector("strong").textContent = persistedVersions.length ? "DETACHED MEDIA" : "AWAITING IMAGE";
    dom.emptyEvidenceState.querySelector("span").textContent = persistedVersions.length
      ? "服务器仅保存媒体摘要。请关联本地原件以查看影像。"
      : "导入影像以启动真实模型分析";
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
  selectEvidenceView(0, { record: false });
}

function selectStoredVersion(versionId) {
  const record = state.activeCaseRecord;
  const version = record?.versions?.find((item) => item.version_id === versionId);
  if (!record || !version) return;
  const currentDigest = state.currentFile ? state.activePayload?.media_sha256 : "";
  if (currentDigest && currentDigest !== version.media_sha256) {
    releaseCurrentObjectUrl();
    state.currentFile = null;
    state.currentDataUrl = "";
  }
  state.selectedVersionId = version.version_id;
  setAnalysisPayload(payloadFromStoredVersion(record, version));
  renderPersistentCase(record);
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
  window.setTimeout(resizeForensicCanvas, 0);
}

function bindDossierControls() {
  const syncComparisonSplit = () => {
    dom.evidenceViewport.style.setProperty("--split", `${dom.compareRange.value}%`);
  };
  dom.compareRange.addEventListener("input", syncComparisonSplit);
  syncComparisonSplit();
}

function declaredProvenanceView(record) {
  return {
    available: true,
    declared: true,
    status: "declared_unverified",
    channel: String(record?.channel || ""),
    source_url: String(record?.source_url || ""),
    captured_at: String(record?.captured_at || ""),
    note: String(record?.note || ""),
    hops: []
  };
}

function populateWorkflowForms(record) {
  const provenance = record?.declared_provenance || {};
  dom.provenanceChannel.value = provenance.channel || "";
  dom.provenanceUrl.value = provenance.source_url || "";
  dom.provenanceCapturedAt.value = toLocalDateTimeValue(provenance.captured_at);
  dom.provenanceNote.value = provenance.note || "";
  const decision = record?.human_decision || {};
  dom.humanDecisionAction.value = decision.action || "";
  dom.humanDecisionReason.value = decision.reason_code || "";
  dom.humanDecisionNote.value = decision.note || "";
  const feedback = record?.feedback || {};
  dom.feedbackOutcome.value = feedback.outcome || "";
  dom.feedbackBasis.value = feedback.evidence_basis || "";
  const disabled = record?.status === "sealed";
  [...dom.provenanceForm.elements, ...dom.decisionForm.elements, ...dom.feedbackForm.elements]
    .forEach((control) => { control.disabled = disabled; });
}

function bindPersistentWorkflowControls() {
  dom.caseRefreshButton.addEventListener("click", () => {
    refreshPersistentWorkbench({ preserveCase: true }).catch((error) => showApiError(error, "刷新案件数据失败。"));
  });
  dom.caseDeleteButton.addEventListener("click", deleteActiveCase);
  dom.versionInput.addEventListener("change", () => {
    const [file] = dom.versionInput.files || [];
    dom.versionInput.value = "";
    if (file) analyzeObservedVersion(file);
  });
  dom.localMediaInput.addEventListener("change", () => {
    const [file] = dom.localMediaInput.files || [];
    dom.localMediaInput.value = "";
    if (file) attachLocalMedia(file);
  });
  dom.annotationEditButton.addEventListener("click", toggleAnnotationEditing);
  dom.annotationSaveButton.addEventListener("click", saveReviewerAnnotations);
  dom.annotationClearButton.addEventListener("click", deleteSelectedAnnotation);
  dom.provenanceForm.addEventListener("submit", submitDeclaredProvenance);
}

async function analyzeObservedVersion(file) {
  const record = state.activeCaseRecord;
  if (!record) {
    showToast("请先打开一个持久案件。");
    return;
  }
  if (record.status === "sealed") {
    showToast("已签封案件不能追加版本。");
    return;
  }
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
    showToast(t("toast.invalidType", "仅接受 JPEG、PNG 或 WebP 影像。"));
    return;
  }
  document.body.classList.add("is-analyzing");
  dom.stageStatusLabel.textContent = "正在分析观察版本";
  try {
    const payload = await apiClient.analyze(file, {
      caseId: record.case_id,
      versionRole: "observed_variant",
      locale: i18n?.getLocale() || "zh-CN"
    });
    releaseCurrentObjectUrl();
    state.currentFile = file;
    state.currentObjectUrl = URL.createObjectURL(file);
    state.currentDataUrl = state.currentObjectUrl;
    setAnalysisPayload(payload);
    renderPersistentCase(payload.case);
    await refreshPersistentWorkbench({ preserveCase: true });
    showToast("观察版本已分析并写入同一案件。" );
  } catch (error) {
    showApiError(error, "观察版本分析失败。");
  } finally {
    document.body.classList.remove("is-analyzing");
  }
}

async function attachLocalMedia(file) {
  const version = selectedVersion();
  if (!version) {
    showToast("当前案件没有可关联的版本。");
    return;
  }
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
    showToast(t("toast.invalidType", "仅接受 JPEG、PNG 或 WebP 影像。"));
    return;
  }
  try {
    const digest = await sha256Blob(file);
    if (digest !== String(version.media_sha256 || "").toLowerCase()) {
      throw new Error("本地文件 SHA-256 与所选版本不一致。");
    }
    releaseCurrentObjectUrl();
    state.currentFile = file;
    state.currentObjectUrl = URL.createObjectURL(file);
    state.currentDataUrl = state.currentObjectUrl;
    dom.previewImage.src = state.currentDataUrl;
    dom.processedImage.src = state.currentDataUrl;
    dom.reviewerImage.src = state.currentDataUrl;
    dom.reviewerImage.hidden = false;
    renderViews({ propagation_views: [{
      id: version.version_id,
      label: version.role === "original" ? "已验证本地原件" : "已验证观察版本",
      data_url: state.currentDataUrl,
      size: `${version.image?.width || "?"} × ${version.image?.height || "?"}`,
      origin: "local_digest_verified",
      observed: true
    }] });
    dom.fileMeta.textContent = `${file.name.toUpperCase()} / SHA-256 VERIFIED / ${formatBytes(file.size)}`;
    showToast("本地媒体与案宗摘要匹配，已在内存中关联。");
  } catch (error) {
    showApiError(error, "本地媒体关联失败。");
  }
}

function toggleAnnotationEditing() {
  if (!state.activeCaseRecord || state.activeCaseRecord.status === "sealed") return;
  if (!state.currentDataUrl) {
    showToast("请先关联当前版本的本地媒体，再进行框选标注。");
    return;
  }
  state.annotationEditing = !state.annotationEditing;
  state.annotationDraft = null;
  dom.annotationEditButton.setAttribute("aria-pressed", String(state.annotationEditing));
  dom.evidenceViewport.dataset.annotationEditing = String(state.annotationEditing);
  dom.stageStatusLabel.textContent = state.annotationEditing ? "人工标注模式：拖动框选区域" : "人工标注模式已关闭";
  hideForensicLens();
}

async function saveReviewerAnnotations() {
  const record = state.activeCaseRecord;
  const versionId = state.selectedVersionId;
  if (!record || !versionId || record.status === "sealed") return;
  const selected = state.annotations.find((item) => annotationId(item) === state.selectedAnnotationId);
  if (selected && dom.annotationNote.value.trim()) selected.note = dom.annotationNote.value.trim();
  const annotations = state.annotations.map((item, index) => ({
    annotation_id: annotationId(item) || `annotation-${index + 1}`,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    note: String(item.note || item.detail || "")
  }));
  try {
    const payload = await apiClient.replaceAnnotations(record.case_id, versionId, annotations);
    renderPersistentCase(payload.case);
    if (state.activePayload) state.activePayload.case = payload.case;
    showToast("人工标注已写入哈希审计链。");
  } catch (error) {
    showApiError(error, "人工标注保存失败。");
  }
}

function deleteSelectedAnnotation() {
  if (!state.selectedAnnotationId || state.activeCaseRecord?.status === "sealed") return;
  state.annotations = state.annotations.filter((item) => annotationId(item) !== state.selectedAnnotationId);
  state.selectedAnnotationId = "";
  dom.annotationNote.value = "";
  renderAnnotations();
}

async function submitDeclaredProvenance(event) {
  event.preventDefault();
  const record = state.activeCaseRecord;
  if (!record || record.status === "sealed") return;
  const capturedAt = dom.provenanceCapturedAt.value
    ? new Date(dom.provenanceCapturedAt.value).toISOString()
    : "";
  try {
    const payload = await apiClient.declareProvenance(record.case_id, {
      channel: dom.provenanceChannel.value.trim(),
      source_url: dom.provenanceUrl.value.trim(),
      captured_at: capturedAt,
      note: dom.provenanceNote.value.trim()
    });
    renderPersistentCase(payload.case);
    if (state.activePayload) state.activePayload.case = payload.case;
    showToast("声明来源已写入证据链，并标记为未独立验证。");
  } catch (error) {
    showApiError(error, "来源声明保存失败。");
  }
}

async function submitHumanDecision(event) {
  event.preventDefault();
  const record = state.activeCaseRecord;
  if (!record || record.status === "sealed") return;
  const reason = dom.humanDecisionReason.value;
  const note = dom.humanDecisionNote.value.trim();
  if (reason === "other" && !note) {
    showToast("理由选择“其他”时必须填写决定说明。");
    return;
  }
  try {
    const payload = await apiClient.recordDecision(record.case_id, {
      action: dom.humanDecisionAction.value,
      reason_code: reason,
      note
    });
    renderPersistentCase(payload.case);
    if (state.activePayload) state.activePayload.case = payload.case;
    dom.decisionDialog.close();
    showToast("人工决定已成为案宗正式处置记录。");
  } catch (error) {
    showApiError(error, "人工决定保存失败。");
  }
}

async function submitOutcomeFeedback(event) {
  event.preventDefault();
  const record = state.activeCaseRecord;
  if (!record || record.status === "sealed") return;
  const outcome = dom.feedbackOutcome.value;
  const basis = dom.feedbackBasis.value.trim();
  if (outcome !== "unresolved" && !basis) {
    showToast("确认结果必须填写证据依据。");
    return;
  }
  try {
    const payload = await apiClient.recordFeedback(record.case_id, {
      outcome,
      evidence_basis: basis
    });
    renderPersistentCase(payload.case);
    if (state.activePayload) state.activePayload.case = payload.case;
    dom.feedbackDialog.close();
    await loadOperationalMetrics();
    showToast("核查结果反馈已写入案件。" );
  } catch (error) {
    showApiError(error, "结果反馈保存失败。");
  }
}

function setupForensicCanvas() {
  if (!dom.evidenceViewport || !dom.forensicCanvas) return;
  const resizeObserver = "ResizeObserver" in window ? new ResizeObserver(resizeForensicCanvas) : null;
  resizeObserver?.observe(dom.evidenceViewport);
  window.addEventListener("resize", resizeForensicCanvas);
  dom.processedImage.addEventListener("load", resizeForensicCanvas);

  dom.evidenceViewport.addEventListener("pointerenter", (event) => {
    if (state.annotationEditing || event.pointerType !== "mouse" || touchLensLocked) return;
    showForensicLens();
  });
  dom.evidenceViewport.addEventListener("pointermove", (event) => {
    if (state.annotationEditing && state.annotationDraft?.pointerId === event.pointerId) {
      state.annotationDraft.current = normalizedEvidencePoint(event.clientX, event.clientY);
      drawForensics();
      return;
    }
    if (event.pointerType !== "mouse" || touchLensLocked) return;
    positionForensicLens(event.clientX, event.clientY);
  });
  dom.evidenceViewport.addEventListener("pointerleave", (event) => {
    if (state.annotationEditing || event.pointerType !== "mouse" || touchLensLocked) return;
    hideForensicLens();
  });
  dom.evidenceViewport.addEventListener("pointerdown", (event) => {
    if (state.annotationEditing) {
      if (event.target.closest?.("[data-annotation-index]")) return;
      event.preventDefault();
      const point = normalizedEvidencePoint(event.clientX, event.clientY);
      state.annotationDraft = { pointerId: event.pointerId, start: point, current: point };
      dom.evidenceViewport.setPointerCapture?.(event.pointerId);
      drawForensics();
      return;
    }
    if (event.pointerType === "mouse") return;
    touchPointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  dom.evidenceViewport.addEventListener("pointerup", (event) => {
    if (state.annotationEditing && state.annotationDraft?.pointerId === event.pointerId) {
      event.preventDefault();
      finishAnnotationDraft(event.clientX, event.clientY);
      dom.evidenceViewport.releasePointerCapture?.(event.pointerId);
      return;
    }
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
  dom.evidenceViewport.addEventListener("pointercancel", () => {
    touchPointerStart = null;
    state.annotationDraft = null;
    drawForensics();
  });
  dom.evidenceViewport.addEventListener("keydown", (event) => {
    if ((event.key === "Delete" || event.key === "Backspace") && state.selectedAnnotationId) {
      event.preventDefault();
      deleteSelectedAnnotation();
      return;
    }
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
      ctx.strokeStyle = annotationId(annotation) === state.selectedAnnotationId
        ? "rgba(255, 193, 7, .98)"
        : "rgba(211, 47, 47, .92)";
      ctx.strokeRect(
        rect.width * annotation.x,
        rect.height * annotation.y,
        rect.width * annotation.width,
        rect.height * annotation.height
      );
    });
    ctx.setLineDash([]);
  }

  if (state.annotationDraft) {
    const bounds = annotationBounds(state.annotationDraft.start, state.annotationDraft.current);
    ctx.strokeStyle = "rgba(255, 193, 7, .98)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      rect.width * bounds.x,
      rect.height * bounds.y,
      rect.width * bounds.width,
      rect.height * bounds.height
    );
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
  const rows = (state.caseSummaries || []).slice(0, 20).map((item) => ({
    time: formatUtc(item.updated_at),
    ingress: "PERSISTED CASE",
    asset: item.title,
    decision: item.human_decision?.action || item.latest_machine_recommendation || "review",
    route: item.status
  }));
  if (!rows.length) {
    dom.waterfallFeed.innerHTML = `<div class="capability-empty" role="row"><span role="cell">${escapeHtml(t("radar.noCases", "尚无真实案件记录。"))}</span></div>`;
    return;
  }
  dom.waterfallFeed.innerHTML = rows.map((row) => {
    const high = ["hold", "escalate"].includes(row.decision);
    const decisionClass = high ? "risk" : ["review", "request_original"].includes(row.decision) ? "caution" : "credible";
    return `
      <div class="intercept-row ${high ? "high" : ""} ${row.fresh ? "new" : ""}" role="row">
        <span role="cell">${escapeHtml(row.time)}</span>
        <span role="cell">${escapeHtml(row.ingress)}</span>
        <span role="cell">${escapeHtml(row.asset)}</span>
        <span role="cell" class="${decisionClass}"><i class="state-block ${decisionClass}"></i> ${escapeHtml(humanDecisionLabel(row.decision))}</span>
        <span role="cell">${escapeHtml(String(row.route).toUpperCase())}</span>
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

function canonicalCaseExport() {
  const record = state.activeCaseRecord;
  if (!record) throw new Error("NO PERSISTED CASE");
  return {
    schema: "shareguard.case.export.v2",
    generated_at: new Date().toISOString(),
    case_id: record.case_id,
    title: record.title,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    sealed_at: record.sealed_at,
    selected_version_id: state.selectedVersionId,
    versions: (record.versions || []).map((version) => ({
      version_id: version.version_id,
      role: version.role,
      file_name: version.file_name,
      received_at: version.received_at,
      media_sha256: version.media_sha256,
      engine_release: version.engine_release,
      decision_layer: version.decision_layer,
      machine_recommendation: version.machine_recommendation,
      model_score: version.model_score,
      score_kind: version.score_kind,
      decision_margin: version.decision_margin,
      calibration: version.calibration,
      latency_ms: version.latency_ms,
      image: version.image,
      report: version.report
    })),
    declared_provenance: record.declared_provenance,
    annotations: record.annotations,
    machine_recommendation: selectedVersion()?.machine_recommendation || null,
    human_decision: record.human_decision,
    feedback: record.feedback,
    event_count: record.events?.length || 0,
    chain_head: record.chain_head,
    trust: {
      package_schema: "shareguard.sgd.v2",
      signature_state: record.status === "sealed" ? "server_signed" : "not_sealed",
      media_storage: "detached_digest_only"
    }
  };
}

function reportText(bundle) {
  if (!bundle) return t("report.none", "ShareGuard暂无可用案宗。");
  const version = bundle.versions.find((item) => item.version_id === bundle.selected_version_id) || bundle.versions.at(-1) || {};
  return [
    `${t("report.title", "ShareGuard影像鉴真报告")} / CASE #${bundle.case_id}`,
    `案件状态：${bundle.status}`,
    `媒体 SHA-256：${version.media_sha256 || "—"}`,
    `引擎版本：${version.engine_release || "—"}`,
    `机器建议：${humanDecisionLabel(version.machine_recommendation)}`,
    `人工决定：${humanDecisionLabel(bundle.human_decision?.action)}`,
    `AI生成模型分数：${formatModelScore(version.model_score)}`,
    `分数语义：${version.score_kind || "—"}`,
    `事件链：${bundle.event_count} EVENTS / ${bundle.chain_head}`,
    "说明：机器分数未经概率校准，仅作为风险筛查信号；人工决定为正式处置记录。"
  ].join("\n");
}

function buildReportHtml(bundle) {
  const version = bundle.versions.find((item) => item.version_id === bundle.selected_version_id) || bundle.versions.at(-1) || {};
  const provenance = bundle.declared_provenance;
  return `<!doctype html>
<html lang="${escapeHtml(i18n?.getLocale() || "zh-CN")}"><head><meta charset="utf-8"><title>${escapeHtml(t("report.title", "ShareGuard影像鉴真报告"))}</title>
<style>body{margin:40px;color:#1a1a1a;background:#f7f5f0;font-family:Arial,sans-serif;line-height:1.55}header,section{padding:18px 0;border-bottom:1px solid #1a1a1a}h1,h2{font-family:Georgia,serif}small,dt{font-family:monospace}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 28px}dt{font-size:11px;color:#666}dd{margin:3px 0;overflow-wrap:anywhere}.risk{color:#d32f2f}@media print{body{background:#fff;margin:20mm}}</style></head>
<body><header><small>CASE #${escapeHtml(bundle.case_id)}</small><h1>${escapeHtml(t("report.title", "ShareGuard影像鉴真报告"))}</h1><p>${escapeHtml(bundle.title)}</p></header>
<section><h2 class="risk">${escapeHtml(humanDecisionLabel(bundle.human_decision?.action))}</h2><dl><div><dt>MACHINE RECOMMENDATION</dt><dd>${escapeHtml(humanDecisionLabel(version.machine_recommendation))}</dd></div><div><dt>MODEL SCORE</dt><dd>${escapeHtml(formatModelScore(version.model_score))}</dd></div><div><dt>ENGINE RELEASE</dt><dd>${escapeHtml(version.engine_release || "—")}</dd></div><div><dt>SCORE KIND</dt><dd>${escapeHtml(version.score_kind || "—")}</dd></div></dl></section>
<section><h2>证据标识</h2><dl><div><dt>MEDIA SHA-256</dt><dd>${escapeHtml(version.media_sha256 || "—")}</dd></div><div><dt>CHAIN HEAD</dt><dd>${escapeHtml(bundle.chain_head)}</dd></div><div><dt>EVENTS</dt><dd>${escapeHtml(bundle.event_count)}</dd></div><div><dt>TRUST STATE</dt><dd>${escapeHtml(bundle.trust.signature_state)}</dd></div></dl></section>
<section><h2>来源声明</h2><p>${provenance ? `${escapeHtml(provenance.channel)} / DECLARED UNVERIFIED / ${escapeHtml(provenance.source_url || "NO URL")}` : "未记录来源声明"}</p></section>
<section><small>机器分数未经概率校准，仅作为风险筛查信号；人工决定为正式处置记录。服务器仅保留媒体摘要，不嵌入原始影像。</small></section></body></html>`;
}

function saveHtmlReport() {
  const bundle = canonicalCaseExport();
  downloadBlob(buildReportHtml(bundle), `${reportFileStem()}.html`, "text/html;charset=utf-8");
}

function printReport() {
  const bundle = canonicalCaseExport();
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    showToast("浏览器阻止了打印窗口，请允许弹出窗口后重试。");
    return;
  }
  printWindow.opener = null;
  printWindow.document.open();
  printWindow.document.write(buildReportHtml(bundle));
  printWindow.document.close();
  printWindow.addEventListener("load", () => printWindow.print(), { once: true });
}

function downloadJsonReport() {
  const bundle = canonicalCaseExport();
  downloadBlob(JSON.stringify(bundle, null, 2), `${reportFileStem()}.json`, "application/json");
}

async function copyReport() {
  try {
    const bundle = canonicalCaseExport();
    await navigator.clipboard.writeText(reportText(bundle));
    showToast(t("toast.reportCopied", "案宗摘要已复制。"));
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
  dom.reviewForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = dom.reviewerComment.value.trim();
    if (!text) return;
    const selected = state.annotations.find((item) => annotationId(item) === state.selectedAnnotationId);
    if (!selected) {
      showToast("请先在案宗影像上选择或框选一个人工标注。" );
      return;
    }
    selected.note = text;
    selected.detail = text;
    dom.annotationNote.value = text;
    dom.reviewerComment.value = "";
    await saveReviewerAnnotations();
  });
}

function renderReviewer(payload = state.activePayload) {
  if (!payload) return;
  dom.reviewerTitle.textContent = `CASE #${state.activeCase.code}`;
  dom.reviewerVerdict.textContent = state.activeCaseRecord?.human_decision
    ? `HUMAN / ${humanDecisionLabel(state.activeCaseRecord.human_decision.action).toUpperCase()}`
    : `MACHINE / ${humanDecisionLabel(payload.decision).toUpperCase()}`;
  dom.reviewerNarrative.textContent = payload.report.summary;
  if (state.currentDataUrl) {
    dom.reviewerImage.src = state.currentDataUrl;
    dom.reviewerImage.hidden = false;
  } else {
    dom.reviewerImage.removeAttribute("src");
    dom.reviewerImage.hidden = true;
  }
  renderReviewerNotes();
}

function renderReviewerNotes() {
  if (!dom.reviewThread) return;
  const annotations = state.annotations || [];
  if (!annotations.length) {
    dom.reviewThread.innerHTML = '<div class="capability-empty">尚无人工标注。</div>';
    return;
  }
  dom.reviewThread.innerHTML = annotations.map((annotation, index) => `
    <article class="review-note">
      <time>R${index + 1} / HUMAN REVIEWER</time>
      <p>${escapeHtml(annotation.note || annotation.detail || "未填写说明")}</p>
    </article>
  `).join("");
}

function bindDialogControls() {
  dom.forceReleaseButton.addEventListener("click", () => dom.decisionDialog.showModal());
  dom.feedbackButton.addEventListener("click", () => dom.feedbackDialog.showModal());
  dom.closeDecisionButton.addEventListener("click", () => dom.decisionDialog.close());
  dom.closeFeedbackButton.addEventListener("click", () => dom.feedbackDialog.close());
  dom.decisionForm.addEventListener("submit", submitHumanDecision);
  dom.feedbackForm.addEventListener("submit", submitOutcomeFeedback);
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
    setModelConnectionStatus("error", t("model.credentialsRequired", "请输入访问账号和访问密码。"));
    return;
  }

  const submitButton = dom.modelConnectionForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  modelConnection.status = "connecting";
  renderModelConnectionState();
  setModelConnectionStatus("connecting", t("model.connecting", "正在验证云端推理网关…"));

  try {
    apiClient?.setCredentials(username, password);
    const payload = await apiClient.ready();
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
    await refreshPersistentWorkbench({ preserveCase: true });

    const shouldResume = modelConnection.pendingAnalysis;
    modelConnection.pendingAnalysis = false;
    if (shouldResume) {
      dom.modelConnectionDialog.close();
      await analyzeCurrentFile();
    }
  } catch (error) {
    apiClient?.clearCredentials();
    modelConnection.username = "";
    modelConnection.password = "";
    modelConnection.connected = false;
    modelConnection.status = "error";
    dom.modelPassword.value = "";
    setModelConnectionStatus(
      "error",
      error?.status === 401
        ? t("model.invalid", "账号或密码无效，请重新输入。")
        : error instanceof ModelConnectionError
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
  apiClient?.clearCredentials();
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
    state.activeCaseRecord = evidencePackage.case;
    if (state.activePayload) state.activePayload.case = evidencePackage.case;
    renderPersistentCase(evidencePackage.case);
    dom.sealTitle.textContent = t("seal.complete", "证据包已签封");
    dom.sealResult.hidden = false;
    dom.custodySeal.textContent = evidencePackage.payload_sha256.slice(0, 12).toUpperCase();
  } catch (error) {
    await appendSealLog(`[ERROR] ${String(error?.message || "SIGNING FAILED")}`);
    dom.sealTitle.textContent = t("seal.failed", "签封失败");
  } finally {
    dom.sealButton.disabled = state.activeCaseRecord?.status === "sealed"
      || !state.activeCaseRecord?.human_decision;
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
  const payload = await apiClient.sealCase(caseId);
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

function selectedVersion() {
  return state.activeCaseRecord?.versions?.find((item) => item.version_id === state.selectedVersionId)
    || state.activeCaseRecord?.versions?.at(-1)
    || null;
}

async function sha256Blob(blob) {
  if (!window.crypto?.subtle) throw new Error("WEB CRYPTO API UNAVAILABLE");
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function shortCaseId(caseId) {
  const value = String(caseId || "PENDING");
  return value.startsWith("sg_case_") ? `SG-${value.slice(-8).toUpperCase()}` : value.toUpperCase();
}

function formatUtc(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function toLocalDateTimeValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function humanDecisionLabel(action) {
  return ({
    allow: "允许使用",
    review: "人工复核",
    request_original: "索取原件",
    escalate: "升级复核",
    hold: "暂缓发布"
  })[String(action)] || "待人工决定";
}

function feedbackOutcomeLabel(outcome) {
  return ({
    confirmed_real: "确认真实",
    confirmed_generated: "确认生成",
    unresolved: "仍未解决"
  })[String(outcome)] || "尚未反馈";
}

function showApiError(error, fallback) {
  const detail = error?.code === "rate_limited" && error?.retryAfter
    ? `请在 ${error.retryAfter} 秒后重试。`
    : String(error?.message || "");
  showToast(`${fallback}${detail ? ` ${detail}` : ""}`);
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
