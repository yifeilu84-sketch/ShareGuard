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
  caseQuery: { status: "", priority: "", nextCursor: null, total: 0, loading: false },
  selectedVersionId: "",
  selectedAnnotationId: "",
  annotationEditing: false,
  annotationDraft: null,
  activePayload: null,
  currentFile: null,
  currentDataUrl: "",
  currentObjectUrl: null,
  versionMedia: new Map(),
  propagationViews: [],
  annotations: [],
  provenance: { available: false, nodes: [], edges: [], reason: "source_data_not_provided" },
  custodyEvents: [],
  evidencePackageBlob: null,
  evidencePackage: null,
  evidencePackageName: "",
  reviewAccess: { active: false, reviewerName: "", expiresAt: "" }
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
    "caseStatusFilter", "casePriorityFilter", "caseLoadMoreButton",
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
    "reviewGrantPanel", "reviewGrantForm", "reviewerName", "reviewGrantExpiry",
    "reviewGrantOutput", "reviewGrantLink", "copyReviewGrantButton", "reviewGrantList",
    "sealDialog", "sealTitle", "sealLog", "sealResult", "downloadSgdButton",
    "encryptEvidencePackage", "evidencePassphraseField", "evidencePassphrase",
    "dropOverlay", "toast",
    "modelConnectionButton", "modelConnectionLabel", "modelConnectionDialog",
    "modelConnectionForm", "modelEndpoint", "modelUsername", "modelPassword",
    "modelConnectionStatus", "modelDisconnectButton", "closeModelConnectionButton",
    "annotationLayer", "provenanceBody", "provenanceStatus",
    "caseRefreshButton", "caseDeleteButton", "versionInput", "versionImportButton", "scopedReviewReturnButton",
    "localMediaInput", "localMediaButton", "annotationEditButton", "annotationNote",
    "annotationSaveButton", "annotationClearButton", "provenanceForm", "provenanceChannel",
    "provenanceUrl", "provenanceCapturedAt", "provenanceNote", "feedbackButton",
    "provenanceTargetVersion", "provenanceRelationship", "provenanceDigest",
    "workflowState", "workflowDue", "workflowOpenCount", "workflowPriority",
    "workflowAssignee", "workflowSaveButton", "workflowTasks",
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

  const reviewToken = consumeReviewTokenFragment();
  if (reviewToken && apiClient) {
    state.reviewAccess.active = true;
    apiClient.setReviewToken(reviewToken);
    document.body.classList.add("scoped-review-mode");
    switchView("reviewer", { updateHistory: false });
    initializeProductionWorkbench();
    loadScopedReview().catch((error) => showApiError(error, "受控审查链接无法打开。"));
  } else {
    const reviewOnly = new URLSearchParams(window.location.search).get("review") === "1";
    switchView(reviewOnly ? "reviewer" : "dossier", { updateHistory: false });
    initializeProductionWorkbench();
  }
}

function consumeReviewTokenFragment() {
  const fragment = String(window.location.hash || "").replace(/^#/, "");
  const token = new URLSearchParams(fragment).get("review_token") || "";
  if (token && window.history?.replaceState) {
    window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
  }
  return token;
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
  dom.quarantineCount.textContent = String(state.caseQuery.total || cases.length).padStart(2, "0");
  dom.queueCount.textContent = String(cases.filter((item) => !["sealed", "closed_allowed"].includes(item.status)).length).padStart(2, "0");
  dom.caseLoadMoreButton.hidden = state.caseQuery.nextCursor === null;
  dom.caseLoadMoreButton.disabled = state.caseQuery.loading;
  if (!cases.length) {
    dom.casePicker.innerHTML = `<div class="capability-empty">${escapeHtml(t("radar.empty", "尚无持久案件。导入影像后，案件会在此出现。"))}</div>`;
    return;
  }
  dom.casePicker.innerHTML = cases.map((item) => {
    const decision = item.human_decision?.action || item.latest_machine_recommendation || "review";
    const workflow = item.workflow || {};
    const overdue = caseIsOverdue(item);
    const deletionPending = item.deletion?.status === "pending";
    return `
      <article class="quarantine-card${overdue ? " overdue" : ""}" data-status="${escapeHtml(deletionPending ? "deletion_pending" : item.status)}" data-priority="${escapeHtml(workflow.priority || "normal")}">
        <button type="button" data-case-id="${escapeHtml(item.case_id)}">
          <span><b>${escapeHtml(shortCaseId(item.case_id))}</b><time data-sla-due="${escapeHtml(workflow.sla_due_at || "")}">${escapeHtml(deletionPending ? "DELETE PENDING" : formatSla(workflow.sla_due_at, item.status))}</time></span>
          <strong>${escapeHtml(item.title)}</strong>
          <span><small>${escapeHtml(priorityLabel(workflow.priority))} / ${escapeHtml(workflow.open_task_count || 0)} TASK / ${escapeHtml(workflow.assignee || "未分配")}</small><em>${escapeHtml(deletionPending ? "DELETE PENDING" : humanDecisionLabel(decision))}</em></span>
        </button>
      </article>`;
  }).join("");
  dom.casePicker.querySelectorAll("[data-case-id]").forEach((button) => {
    button.addEventListener("click", () => openPersistedCase(button.dataset.caseId));
  });
}

async function refreshPersistentWorkbench(options = {}) {
  if (!apiClient || (usesRemoteModel() && !modelConnection.connected)) return;
  await Promise.all([loadCaseList(), loadOperationalMetrics()]);
}

async function loadCaseList(options = {}) {
  if (state.reviewAccess.active || state.caseQuery.loading) return state.caseSummaries;
  const append = options.append === true;
  state.caseQuery.loading = true;
  dom.caseLoadMoreButton.disabled = true;
  try {
    const payload = await apiClient.listCases({
      status: state.caseQuery.status,
      priority: state.caseQuery.priority,
      cursor: append ? state.caseQuery.nextCursor : 0,
      limit: 20
    });
    const incoming = Array.isArray(payload?.cases) ? payload.cases : [];
    state.caseSummaries = append
      ? [...new Map([...state.caseSummaries, ...incoming].map((item) => [item.case_id, item])).values()]
      : incoming;
    state.caseQuery.nextCursor = payload?.next_cursor ?? null;
    state.caseQuery.total = Number(payload?.total ?? state.caseSummaries.length);
    renderCasePicker();
    renderWaterfall();
    return state.caseSummaries;
  } finally {
    state.caseQuery.loading = false;
    dom.caseLoadMoreButton.disabled = false;
  }
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
    releaseAllVersionMedia();
    state.currentFile = null;
    state.currentDataUrl = "";
    state.activeCase = {
      id: record.case_id,
      code: record.case_id,
      title: record.title,
      workflow: "持久案件复核",
      source: record.declared_provenance?.channel || "PRIVATE MEDIA CUSTODY",
      handler: "AUTHENTICATED REVIEWER",
      timestamp: formatUtc(record.created_at),
      briefing: "该案件已从持久证据链重新打开。授权后从加密私有存储取回所选媒体，并在浏览器核对 SHA-256。"
    };
    setAnalysisPayload(payloadFromStoredVersion(record, version));
    renderPersistentCase(record);
    switchView("dossier");
    try {
      await loadSelectedVersionMedia(record, version);
    } catch (error) {
      renderMediaUnavailable(record, version);
      showApiError(error, "案宗已打开，但受保护媒体当前不可用。");
    }
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
    provenance: { available: false, reason: "case_graph_rendered_separately", nodes: [], edges: [] },
    report: version.report || {},
    propagation_views: []
  };
}

function caseMutationLocked(record) {
  return record?.status === "sealed" || record?.deletion?.status === "pending";
}

function renderPersistentCase(record) {
  const sealed = record.status === "sealed";
  const deletionPending = record.deletion?.status === "pending";
  const locked = caseMutationLocked(record);
  state.activeCaseRecord = record;
  document.body.classList.toggle("case-sealed", sealed);
  document.body.classList.toggle("case-deleting", deletionPending);
  state.selectedVersionId = record.versions?.some((item) => item.version_id === state.selectedVersionId)
    ? state.selectedVersionId
    : record.versions?.at(-1)?.version_id || "";
  state.annotations = (record.annotations?.[state.selectedVersionId] || [])
    .map(normalizePersistedAnnotation)
    .filter(Boolean);
  state.provenance = provenanceGraphView(record);
  state.custodyEvents = (record.events || []).map((event) => ({
    time: formatUtc(event.created_at),
    actor: String(event.actor_id || "").slice(-10).toUpperCase(),
    event: event.event_type,
    integrity: String(event.event_hash || "").slice(0, 12).toUpperCase()
  }));
  renderCaseContext(state.activeCase);
  renderAnnotations();
  renderProvenance();
  renderWorkflow(record);
  renderComments(record);
  renderReviewGrants(record);
  renderCustodyLog();
  dom.custodyDecision.textContent = record.human_decision
    ? humanDecisionLabel(record.human_decision.action).toUpperCase()
    : "OPERATOR CONFIRMATION PENDING";
  dom.custodySeal.textContent = deletionPending
    ? "DELETE PENDING"
    : record.status === "sealed"
      ? String(record.chain_head).slice(0, 12).toUpperCase()
      : "NOT SEALED";
  dom.forceReleaseButton.disabled = locked;
  dom.feedbackButton.disabled = locked;
  dom.forceReleaseButton.textContent = record.human_decision
    ? `更新处置确认 · ${humanDecisionLabel(record.human_decision.action)}`
    : "确认系统处置";
  dom.feedbackButton.textContent = record.feedback
    ? `更新结果反馈 · ${feedbackOutcomeLabel(record.feedback.outcome)}`
    : "补录结果反馈";
  dom.caseDeleteButton.disabled = sealed;
  dom.caseDeleteButton.textContent = deletionPending ? "RETRY SAFE DELETE" : "删除未签封案件";
  dom.sealButton.disabled = locked || !record.human_decision;
  dom.versionInput.disabled = locked;
  dom.versionImportButton.setAttribute("aria-disabled", String(locked));
  dom.annotationEditButton.disabled = locked;
  dom.annotationNote.disabled = locked;
  dom.annotationSaveButton.disabled = locked;
  dom.annotationClearButton.disabled = locked;
  dom.reviewerComment.disabled = locked;
  dom.reviewForm.querySelector('[type="submit"]').disabled = locked;
  [...dom.reviewGrantForm.elements].forEach((control) => {
    control.disabled = locked || state.reviewAccess.active;
  });
  populateWorkflowForms(record);
}

async function deleteActiveCase() {
  const record = state.activeCaseRecord;
  if (!record || record.status === "sealed") return;
  const prompt = record.deletion?.status === "pending"
    ? `继续清理案件 ${shortCaseId(record.case_id)} 的私有媒体并提交删除？`
    : `删除未签封案件 ${shortCaseId(record.case_id)}？此操作无法撤销。`;
  if (!window.confirm(prompt)) return;
  try {
    await apiClient.deleteCase(record.case_id);
    resetActiveCase();
    await refreshPersistentWorkbench();
    showToast("案件已删除。");
  } catch (error) {
    try {
      const refreshed = await apiClient.getCase(record.case_id);
      if (refreshed?.case) renderPersistentCase(refreshed.case);
      await loadCaseList();
    } catch (verificationError) {
      if (verificationError?.status === 404 || verificationError?.code === "case_not_found") {
        resetActiveCase();
        await refreshPersistentWorkbench();
        showToast("案件已删除。");
        return;
      }
    }
    showApiError(error, "案件删除失败。");
  }
}

function resetActiveCase() {
  releaseAllVersionMedia();
  state.currentFile = null;
  state.currentDataUrl = "";
  state.activeCaseRecord = null;
  state.selectedVersionId = "";
  state.activeCase = { ...EMPTY_CASE };
  document.body.classList.remove("case-sealed");
  document.body.classList.remove("case-deleting");
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
  releaseAllVersionMedia();
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
    briefing: t("case.upload.briefing", "该影像由当前工作台导入，系统将调用云端筛查引擎生成图像级判定，并在授权案件中保全原始字节。")
  };
  state.activePayload = null;
  state.activeCaseRecord = null;
  state.selectedVersionId = "";
  state.annotations = [];
  state.provenance = { available: false, nodes: [], edges: [], reason: "source_data_not_provided" };
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
      rememberVersionMedia(payload.version_id, state.currentFile, payload.media_sha256, {
        url: state.currentObjectUrl,
        source: "current_upload"
      });
      state.currentObjectUrl = null;
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
  state.provenance = { available: false, nodes: [], edges: [], reason: "source_data_not_provided" };
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
  dom.forceReleaseButton.textContent = "确认系统处置";
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
  state.provenance = normalized.case ? provenanceGraphView(normalized.case) : normalized.provenance;
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
  dom.sealButton.disabled = !normalized.case?.human_decision || caseMutationLocked(normalized.case);
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
  const scoreNotice = String(payload.score_notice || report.score_notice || "");
  const currentView = state.currentDataUrl
    ? [{ id: "current", label: t("view.uploaded", "上传原图"), data_url: state.currentDataUrl, size: "SOURCE", filter: "none", origin: "uploaded", observed: true }]
    : [];
  const localization = {
    available: false,
    annotations: [],
    reason: String(payload.localization?.reason || "image_level_model")
  };
  const provenance = {
    available: false,
    nodes: [],
    edges: [],
    reason: String(payload.provenance?.reason || "source_data_not_provided")
  };
  const reliability = normalizeReliability(payload.reliability);
  const detectorEngine = String(payload.detector_engine || payload.model_version || "unknown");
  const decisionLayer = String(payload.decision_layer || "shareguard-dossier-v1");
  const shadowEvaluation = normalizeShadowEvaluation(payload.shadow_evaluation);
  const summary = modelDecisionSummary(decision);
  const recommendedAction = systemActionLabel(decision);
  const notes = [
    `模型判定：${modelVerdictLabel(decision)}`,
    `判定强度：${decisionStrengthLabel(decisionMargin)}`,
    `边界状态：${localizeBoundaryState(payload.uncertainty || report.uncertainty, reliability)}`,
    `系统动作：${recommendedAction}`
  ];
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
    risk_level: riskLevel,
    decision,
    uncertainty: String(payload.uncertainty || report.uncertainty || "unknown"),
    reliability,
    calibration: payload.calibration && typeof payload.calibration === "object" ? payload.calibration : { status: "unavailable" },
    policy: payload.policy && typeof payload.policy === "object" ? payload.policy : {},
    localization,
    provenance,
    report: {
      conclusion: modelVerdictLabel(decision),
      summary,
      recommended_action: recommendedAction,
      sections: Array.isArray(report.sections) ? report.sections : [],
      notes: notes.map(String),
      disclaimer: ""
    },
    propagation_views: currentView
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
    title: String(annotation.title || "人工复核标注"),
    detail: String(annotation.note || annotation.detail || ""),
    note: String(annotation.note || annotation.detail || ""),
    origin: "human_reviewer",
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    width: clamp(width, 0, 1),
    height: clamp(height, 0, 1)
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
    hold: [t("decision.hold.en", "SUSPEND"), t("decision.hold.local", "暂停分发")],
    review: [t("decision.review.en", "REVIEW"), t("decision.review.local", "进入复核")],
    allow: [t("decision.allow.en", "RELEASE"), t("decision.allow.local", "允许使用")]
  };
  const [english, chinese] = verdicts[payload.decision] || verdicts.review;
  dom.decisionPanel.dataset.decision = payload.decision;
  dom.decisionTitle.innerHTML = `${escapeHtml(english)}<br><em>${escapeHtml(chinese)}</em>`;
  restartCssAnimation(dom.decisionTitle, "stamp-enter");
  dom.riskProbability.textContent = modelVerdictLabel(payload.decision);
  dom.riskProbability.removeAttribute("title");
  dom.confidenceValue.textContent = decisionStrengthLabel(payload.decision_margin);
  dom.confidenceValue.removeAttribute("title");
  dom.uncertaintyValue.textContent = localizeBoundaryState(payload.uncertainty, payload.reliability);
  dom.recommendedAction.textContent = systemActionLabel(payload.decision);
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
  const provenance = state.provenance || { available: false, nodes: [], edges: [] };
  if (!provenance.available || !provenance.nodes.length) {
    dom.provenanceStatus.textContent = "NO SOURCE DATA";
    dom.provenanceBody.className = "capability-empty";
    dom.provenanceBody.textContent = t("provenance.unavailable", "尚未记录来源或传播链路。");
    return;
  }
  const nodes = new Map(provenance.nodes.map((node) => [node.node_id, node]));
  const verified = provenance.edges.filter((edge) => edge.verification_status === "digest_verified").length;
  const declared = provenance.edges.filter((edge) => edge.verification_status === "declared_unverified").length;
  dom.provenanceStatus.textContent = `${verified} DIGEST VERIFIED / ${declared} DECLARED`;
  dom.provenanceBody.className = "provenance-graph-list";
  const edgeRows = provenance.edges.map((edge) => {
    const source = nodes.get(edge.source_node_id) || {};
    const target = nodes.get(edge.target_node_id) || {};
    const status = edge.verification_status === "digest_verified" ? "DIGEST VERIFIED" : "DECLARED / UNVERIFIED";
    return `<article data-verification="${escapeHtml(edge.verification_status || "declared_unverified")}">
      <div><span>${escapeHtml(source.channel || "DECLARED SOURCE")}</span><b>${escapeHtml(provenanceRelationshipLabel(edge.relationship))}</b><span>${escapeHtml(versionNodeLabel(target))}</span></div>
      <small>${escapeHtml(status)} / ${escapeHtml(edge.evidence_basis || "reviewer_declaration")}</small>
      ${source.source_url ? `<a href="${escapeHtml(source.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.source_url)}</a>` : ""}
      <p>${escapeHtml(source.note || "未附加说明")}</p>
      <time>${escapeHtml(formatUtc(source.captured_at || edge.recorded_at))}</time>
    </article>`;
  }).join("");
  const unlinkedMedia = provenance.nodes
    .filter((node) => node.kind === "media_version" && !provenance.edges.some((edge) => edge.target_node_id === node.node_id))
    .map((node) => `<article data-verification="media_only"><div><span>UPLOADED MEDIA</span><b>保全节点</b><span>${escapeHtml(versionNodeLabel(node))}</span></div><small>SHA-256 ${escapeHtml(String(node.media_sha256 || "").slice(0, 16).toUpperCase())}…</small></article>`)
    .join("");
  dom.provenanceBody.innerHTML = edgeRows || unlinkedMedia
    ? `${edgeRows}${unlinkedMedia}`
    : `<div class="capability-empty">仅有媒体节点，尚未记录来源关系。</div>`;
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
  const persistedVersions = state.activeCaseRecord?.versions || payload.case?.versions || [];
  const views = persistedVersions.map((version) => ({
    id: version.version_id,
    label: versionRoleLabel(version.role),
    data_url: state.versionMedia.get(version.version_id)?.url || "",
    size: version.image?.width && version.image?.height ? `${version.image.width} × ${version.image.height}` : "MEDIA",
    origin: "uploaded_version"
  }));
  if (!views.length && state.currentDataUrl) {
    views.push({ id: "current", label: t("view.uploaded", "当前上传"), data_url: state.currentDataUrl, size: "SOURCE", origin: "current_upload" });
  }
  state.propagationViews = views;
  const versionButtons = persistedVersions.map((version, index) => `
    <button class="evidence-version" type="button" data-version-id="${escapeHtml(version.version_id)}" aria-pressed="${version.version_id === state.selectedVersionId}">
      <span>V${String(index + 1).padStart(2, "0")}</span>
      <span><strong>${escapeHtml(versionRoleLabel(version.role))}</strong><small>${escapeHtml(modelVerdictLabel(version.machine_recommendation))} / ${escapeHtml(version.media_custody?.status === "encrypted_private" ? "PRIVATE" : "DIGEST ONLY")}</small></span>
    </button>`).join("");
  dom.viewGrid.innerHTML = versionButtons
    ? versionButtons
    : `<div class="capability-empty">${escapeHtml(t("evidence.noViews", "导入影像后显示案件版本。"))}</div>`;
  dom.viewGrid.querySelectorAll("[data-version-id]").forEach((button) => {
    button.addEventListener("click", () => selectStoredVersion(button.dataset.versionId));
  });
  const selected = persistedVersions.find((version) => version.version_id === state.selectedVersionId) || persistedVersions.at(-1);
  const selectedMedia = selected ? state.versionMedia.get(selected.version_id) : null;
  if (!selectedMedia && !state.currentDataUrl) {
    dom.emptyEvidenceState.hidden = false;
    dom.emptyEvidenceState.querySelector("strong").textContent = persistedVersions.length ? "LOADING PROTECTED MEDIA" : "AWAITING IMAGE";
    dom.emptyEvidenceState.querySelector("span").textContent = persistedVersions.length
      ? "正在从加密私有存储取回并核对媒体摘要"
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
  const selectedUrl = selectedMedia?.url || state.currentDataUrl;
  const original = persistedVersions.find((version) => version.role === "original") || persistedVersions[0];
  const originalMedia = original ? state.versionMedia.get(original.version_id) : null;
  const compareReady = Boolean(originalMedia?.url && selected?.version_id !== original?.version_id);
  dom.processedImage.src = selectedUrl;
  dom.processedImage.style.filter = "none";
  dom.previewImage.src = compareReady ? originalMedia.url : selectedUrl;
  dom.reviewerImage.src = selectedUrl;
  dom.reviewerImage.hidden = false;
  dom.originalLayer.hidden = !compareReady;
  dom.splitIndicator.hidden = !compareReady;
  dom.comparisonControl.hidden = !compareReady;
  dom.compareRange.disabled = !compareReady;
  dom.stageViewLabel.textContent = versionRoleLabel(selected?.role || "original").toUpperCase();
  dom.stageStatusLabel.textContent = compareReady
    ? "正在对比案件中的两个真实上传版本"
    : "受保护媒体已取回并通过 SHA-256 核对";
  window.setTimeout(resizeForensicCanvas, 0);
}

function renderMediaUnavailable(record, version) {
  dom.emptyEvidenceState.hidden = false;
  dom.emptyEvidenceState.querySelector("strong").textContent = "MEDIA UNAVAILABLE";
  dom.emptyEvidenceState.querySelector("span").textContent = version?.media_custody?.status === "detached_digest_only"
    ? "该历史版本仅保留摘要；可重新关联 SHA-256 匹配的本地原件"
    : "受保护媒体暂时无法取回；案件记录与审计链仍可复核";
  dom.processedImage.hidden = true;
  dom.originalLayer.hidden = true;
  dom.splitIndicator.hidden = true;
  dom.comparisonControl.hidden = true;
  dom.stageViewLabel.textContent = versionRoleLabel(version?.role || "original").toUpperCase();
  dom.stageStatusLabel.textContent = "媒体不可用 / 案件元数据已载入";
  dom.fileMeta.textContent = `${String(version?.file_name || "MEDIA").toUpperCase()} / SHA-256 ${String(version?.media_sha256 || "").slice(0, 12).toUpperCase() || "UNAVAILABLE"}`;
  renderReviewer(state.activePayload || payloadFromStoredVersion(record, version));
}

async function selectStoredVersion(versionId) {
  const record = state.activeCaseRecord;
  const version = record?.versions?.find((item) => item.version_id === versionId);
  if (!record || !version) return;
  state.selectedVersionId = version.version_id;
  setAnalysisPayload(payloadFromStoredVersion(record, version));
  renderPersistentCase(record);
  try {
    await loadSelectedVersionMedia(record, version);
  } catch (error) {
    showApiError(error, "无法读取所选版本媒体。");
  }
}

function bindDossierControls() {
  const syncComparisonSplit = () => {
    dom.evidenceViewport.style.setProperty("--split", `${dom.compareRange.value}%`);
  };
  dom.compareRange.addEventListener("input", syncComparisonSplit);
  syncComparisonSplit();
}

function provenanceGraphView(record) {
  const graph = record?.provenance_graph;
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes.filter((node) => node && node.node_id) : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges.filter((edge) => edge && edge.edge_id) : [];
  return {
    available: nodes.length > 0,
    nodes,
    edges,
    reason: nodes.length ? "" : "source_data_not_provided"
  };
}

async function loadSelectedVersionMedia(record, version) {
  if (!record || !version) return;
  dom.stageStatusLabel.textContent = "正在读取受保护媒体并核对 SHA-256";
  const selectedMedia = await ensureVersionMedia(record, version);
  const original = record.versions?.find((item) => item.role === "original") || record.versions?.[0];
  if (original && original.version_id !== version.version_id) {
    await ensureVersionMedia(record, original);
  }
  state.currentFile = selectedMedia.blob;
  state.currentDataUrl = selectedMedia.url;
  renderViews(state.activePayload || payloadFromStoredVersion(record, version));
  renderReviewer(state.activePayload);
  dom.fileMeta.textContent = `${String(version.file_name || "MEDIA").toUpperCase()} / SHA-256 VERIFIED / ${formatBytes(selectedMedia.blob.size)}`;
}

async function ensureVersionMedia(record, version) {
  const cached = state.versionMedia.get(version.version_id);
  if (cached) return cached;
  const response = state.reviewAccess.active
    ? await apiClient.getReviewMedia(version.version_id)
    : await apiClient.getCaseMedia(record.case_id, version.version_id);
  const expected = String(version.media_sha256 || "").toLowerCase();
  if (response.sha256 && response.sha256 !== expected) {
    throw new Error("媒体响应摘要与案件记录不一致。");
  }
  const actual = await sha256Blob(response.blob);
  if (!expected || actual !== expected) {
    throw new Error("媒体 SHA-256 核对失败。");
  }
  return rememberVersionMedia(version.version_id, response.blob, actual, { source: "private_custody" });
}

function rememberVersionMedia(versionId, blob, sha256, options = {}) {
  if (!versionId || !(blob instanceof Blob)) return null;
  const existing = state.versionMedia.get(versionId);
  if (existing?.url && existing.url !== options.url) URL.revokeObjectURL(existing.url);
  const entry = {
    blob,
    sha256: String(sha256 || "").toLowerCase(),
    source: String(options.source || "memory"),
    url: options.url || URL.createObjectURL(blob)
  };
  state.versionMedia.set(versionId, entry);
  return entry;
}

function populateWorkflowForms(record) {
  const provenance = record?.declared_provenance || {};
  dom.provenanceTargetVersion.innerHTML = (record?.versions || []).map((version, index) => (
    `<option value="${escapeHtml(version.version_id)}">V${String(index + 1).padStart(2, "0")} / ${escapeHtml(versionRoleLabel(version.role))}</option>`
  )).join("");
  dom.provenanceTargetVersion.value = provenance.target_version_id || state.selectedVersionId || record?.versions?.at(-1)?.version_id || "";
  dom.provenanceRelationship.value = provenance.relationship || "received_from";
  dom.provenanceChannel.value = provenance.channel || "";
  dom.provenanceUrl.value = provenance.source_url || "";
  dom.provenanceCapturedAt.value = toLocalDateTimeValue(provenance.captured_at);
  dom.provenanceDigest.value = provenance.source_media_sha256 || "";
  dom.provenanceNote.value = provenance.note || "";
  const decision = record?.human_decision || {};
  dom.humanDecisionAction.value = decision.action || "";
  dom.humanDecisionReason.value = decision.reason_code || "";
  dom.humanDecisionNote.value = decision.note || "";
  const feedback = record?.feedback || {};
  dom.feedbackOutcome.value = feedback.outcome || "";
  dom.feedbackBasis.value = feedback.evidence_basis || "";
  const disabled = caseMutationLocked(record);
  [...dom.provenanceForm.elements, ...dom.decisionForm.elements, ...dom.feedbackForm.elements]
    .forEach((control) => { control.disabled = disabled; });
}

function bindPersistentWorkflowControls() {
  dom.caseRefreshButton.addEventListener("click", () => {
    refreshPersistentWorkbench({ preserveCase: true }).catch((error) => showApiError(error, "刷新案件数据失败。"));
  });
  dom.caseDeleteButton.addEventListener("click", deleteActiveCase);
  dom.scopedReviewReturnButton.addEventListener("click", () => switchView("reviewer"));
  dom.caseStatusFilter.addEventListener("change", () => {
    state.caseQuery.status = dom.caseStatusFilter.value;
    loadCaseList().catch((error) => showApiError(error, "案件筛选失败。"));
  });
  dom.casePriorityFilter.addEventListener("change", () => {
    state.caseQuery.priority = dom.casePriorityFilter.value;
    loadCaseList().catch((error) => showApiError(error, "案件筛选失败。"));
  });
  dom.caseLoadMoreButton.addEventListener("click", () => {
    loadCaseList({ append: true }).catch((error) => showApiError(error, "更多案件加载失败。"));
  });
  dom.workflowSaveButton.addEventListener("click", submitWorkflowUpdate);
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

function renderWorkflow(record) {
  if (!record || !dom.workflowState) return;
  const workflow = record.workflow || {};
  const tasks = Array.isArray(workflow.tasks) ? workflow.tasks : [];
  const openTasks = tasks.filter((task) => task.status === "open");
  dom.workflowState.textContent = record.deletion?.status === "pending"
    ? `DELETE PENDING / ${priorityLabel(workflow.priority)}`
    : `${caseStatusLabel(record.status)} / ${priorityLabel(workflow.priority)}`;
  dom.workflowState.dataset.overdue = String(caseIsOverdue(record));
  dom.workflowDue.textContent = formatSla(workflow.sla_due_at, record.status);
  dom.workflowOpenCount.textContent = String(openTasks.length);
  dom.workflowPriority.value = workflow.priority || "normal";
  dom.workflowAssignee.value = workflow.assignee || "";
  dom.workflowTasks.innerHTML = tasks.length
    ? tasks.map((task) => `<article data-status="${escapeHtml(task.status || "open")}"><span>${escapeHtml(taskStatusLabel(task.status))}</span><b>${escapeHtml(task.title || task.type || "Review task")}</b><time>${escapeHtml(formatUtc(task.due_at || task.completed_at))}</time></article>`).join("")
    : '<div class="capability-empty">当前没有任务。</div>';
  const disabled = caseMutationLocked(record) || state.reviewAccess.active;
  dom.workflowPriority.disabled = disabled;
  dom.workflowAssignee.disabled = disabled;
  dom.workflowSaveButton.disabled = disabled;
}

async function submitWorkflowUpdate() {
  const record = state.activeCaseRecord;
  if (!record || caseMutationLocked(record) || state.reviewAccess.active) return;
  try {
    const payload = await apiClient.updateWorkflow(record.case_id, {
      priority: dom.workflowPriority.value,
      assignee: dom.workflowAssignee.value.trim()
    });
    renderPersistentCase(payload.case);
    if (state.activePayload) state.activePayload.case = payload.case;
    await loadCaseList();
    showToast("分诊优先级与负责人已写入审计链。");
  } catch (error) {
    showApiError(error, "分诊更新失败。");
  }
}

async function analyzeObservedVersion(file) {
  const record = state.activeCaseRecord;
  if (!record) {
    showToast("请先打开一个持久案件。");
    return;
  }
  if (caseMutationLocked(record)) {
    showToast(record.deletion?.status === "pending" ? "案件正在删除，不能追加版本。" : "已签封案件不能追加版本。");
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
    state.currentFile = file;
    const objectUrl = URL.createObjectURL(file);
    rememberVersionMedia(payload.version_id, file, payload.media_sha256, {
      url: objectUrl,
      source: "current_upload"
    });
    state.currentDataUrl = objectUrl;
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
    state.currentFile = file;
    const entry = rememberVersionMedia(version.version_id, file, digest, {
      source: "local_digest_verified"
    });
    state.currentDataUrl = entry.url;
    dom.previewImage.src = state.currentDataUrl;
    dom.processedImage.src = state.currentDataUrl;
    dom.reviewerImage.src = state.currentDataUrl;
    dom.reviewerImage.hidden = false;
    renderViews(state.activePayload || payloadFromStoredVersion(state.activeCaseRecord, version));
    dom.fileMeta.textContent = `${file.name.toUpperCase()} / SHA-256 VERIFIED / ${formatBytes(file.size)}`;
    showToast("本地媒体与案宗摘要匹配，已在内存中关联。");
  } catch (error) {
    showApiError(error, "本地媒体关联失败。");
  }
}

function toggleAnnotationEditing() {
  if (!state.activeCaseRecord || caseMutationLocked(state.activeCaseRecord)) return;
  if (!state.currentDataUrl) {
    showToast("请先载入当前版本媒体，再进行框选标注。");
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
  if (!record || !versionId || caseMutationLocked(record)) return;
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
    const payload = state.reviewAccess.active
      ? await apiClient.replaceReviewAnnotations(versionId, annotations)
      : await apiClient.replaceAnnotations(record.case_id, versionId, annotations);
    renderPersistentCase(payload.case);
    if (state.activePayload) state.activePayload.case = payload.case;
    showToast("人工标注已写入哈希审计链。");
  } catch (error) {
    showApiError(error, "人工标注保存失败。");
  }
}

function deleteSelectedAnnotation() {
  if (!state.selectedAnnotationId || caseMutationLocked(state.activeCaseRecord)) return;
  state.annotations = state.annotations.filter((item) => annotationId(item) !== state.selectedAnnotationId);
  state.selectedAnnotationId = "";
  dom.annotationNote.value = "";
  renderAnnotations();
}

async function submitDeclaredProvenance(event) {
  event.preventDefault();
  const record = state.activeCaseRecord;
  if (!record || caseMutationLocked(record)) return;
  const capturedAt = dom.provenanceCapturedAt.value
    ? new Date(dom.provenanceCapturedAt.value).toISOString()
    : "";
  try {
    const payload = await apiClient.declareProvenance(record.case_id, {
      version_id: dom.provenanceTargetVersion.value,
      relationship: dom.provenanceRelationship.value,
      channel: dom.provenanceChannel.value.trim(),
      source_url: dom.provenanceUrl.value.trim(),
      captured_at: capturedAt,
      source_media_sha256: dom.provenanceDigest.value.trim().toLowerCase(),
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
  if (!record || caseMutationLocked(record)) return;
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
    showToast("处置确认已写入证据链，可以签封导出。");
  } catch (error) {
    showApiError(error, "处置确认保存失败。");
  }
}

async function submitOutcomeFeedback(event) {
  event.preventDefault();
  const record = state.activeCaseRecord;
  if (!record || caseMutationLocked(record)) return;
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
  dom.intakeRate.textContent = "0";
  dom.queueCount.textContent = "00";
  window.setInterval(() => {
    if (document.hidden || state.reviewAccess.active) return;
    refreshPersistentWorkbench({ preserveCase: true }).catch(() => {});
  }, 30_000);
}

function startQuarantineCountdowns() {
  window.setInterval(() => {
    dom.casePicker.querySelectorAll("[data-sla-due]").forEach((node) => {
      const card = node.closest(".quarantine-card");
      const summary = state.caseSummaries.find((item) => item.case_id === card?.querySelector("[data-case-id]")?.dataset.caseId);
      node.textContent = formatSla(node.dataset.slaDue, summary?.status);
      card?.classList.toggle("overdue", caseIsOverdue(summary));
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
    schema: "shareguard.case.export.v3",
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
    provenance_graph: record.provenance_graph,
    annotations: record.annotations,
    workflow: record.workflow,
    comments: record.comments,
    machine_recommendation: selectedVersion()?.machine_recommendation || null,
    human_decision: record.human_decision,
    feedback: record.feedback,
    event_count: record.events?.length || 0,
    chain_head: record.chain_head,
    trust: {
      package_schema: "shareguard.sgd.v3",
      signature_state: record.status === "sealed" ? "server_signed" : "not_sealed",
      media_storage: record.versions?.every((version) => version.media_custody?.status === "encrypted_private")
        ? "encrypted_private_custody"
        : "mixed_or_digest_only"
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
    `模型判定：${modelVerdictLabel(version.machine_recommendation)}`,
    `判定强度：${decisionStrengthLabel(version.decision_margin)}`,
    `边界状态：${localizeBoundaryState(version.report?.uncertainty, version.reliability)}`,
    `系统动作：${systemActionLabel(version.machine_recommendation)}`,
    `处置确认：${humanDecisionLabel(bundle.human_decision?.action)}`,
    `事件链：${bundle.event_count} EVENTS / ${bundle.chain_head}`
  ].join("\n");
}

function buildReportHtml(bundle) {
  const version = bundle.versions.find((item) => item.version_id === bundle.selected_version_id) || bundle.versions.at(-1) || {};
  const provenance = bundle.declared_provenance;
  return `<!doctype html>
<html lang="${escapeHtml(i18n?.getLocale() || "zh-CN")}"><head><meta charset="utf-8"><title>${escapeHtml(t("report.title", "ShareGuard影像鉴真报告"))}</title>
<style>body{margin:40px;color:#1a1a1a;background:#f7f5f0;font-family:Arial,sans-serif;line-height:1.55}header,section{padding:18px 0;border-bottom:1px solid #1a1a1a}h1,h2{font-family:Georgia,serif}small,dt{font-family:monospace}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 28px}dt{font-size:11px;color:#666}dd{margin:3px 0;overflow-wrap:anywhere}.risk{color:#d32f2f}@media print{body{background:#fff;margin:20mm}}</style></head>
<body><header><small>CASE #${escapeHtml(bundle.case_id)}</small><h1>${escapeHtml(t("report.title", "ShareGuard影像鉴真报告"))}</h1><p>${escapeHtml(bundle.title)}</p></header>
<section><h2 class="risk">${escapeHtml(systemActionLabel(version.machine_recommendation))}</h2><dl><div><dt>模型判定</dt><dd>${escapeHtml(modelVerdictLabel(version.machine_recommendation))}</dd></div><div><dt>判定强度</dt><dd>${escapeHtml(decisionStrengthLabel(version.decision_margin))}</dd></div><div><dt>边界状态</dt><dd>${escapeHtml(localizeBoundaryState(version.report?.uncertainty, version.reliability))}</dd></div><div><dt>处置确认</dt><dd>${escapeHtml(humanDecisionLabel(bundle.human_decision?.action))}</dd></div><div><dt>引擎版本</dt><dd>${escapeHtml(version.engine_release || "—")}</dd></div><div><dt>系统动作</dt><dd>${escapeHtml(systemActionLabel(version.machine_recommendation))}</dd></div></dl></section>
<section><h2>证据标识</h2><dl><div><dt>MEDIA SHA-256</dt><dd>${escapeHtml(version.media_sha256 || "—")}</dd></div><div><dt>CHAIN HEAD</dt><dd>${escapeHtml(bundle.chain_head)}</dd></div><div><dt>EVENTS</dt><dd>${escapeHtml(bundle.event_count)}</dd></div><div><dt>TRUST STATE</dt><dd>${escapeHtml(bundle.trust.signature_state)}</dd></div></dl></section>
<section><h2>来源声明</h2><p>${provenance ? `${escapeHtml(provenance.channel)} / DECLARED UNVERIFIED / ${escapeHtml(provenance.source_url || "NO URL")}` : "未记录来源声明"}</p></section>
  <section><small>本报告记录模型判定、系统动作、处置确认与完整事件链。授权媒体在限定保留期内经应用层 AES-256-GCM 加密托管；导出的 .sgd v3 会记录媒体、报告、处置与签名清单。</small></section></body></html>`;
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
  dom.openReviewerButton.addEventListener("click", () => {
    if (!state.activeCaseRecord) {
      showToast("请先打开一个持久案件。");
      return;
    }
    switchView("reviewer");
    renderReviewer();
  });
  dom.reviewForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = dom.reviewerComment.value.trim();
    const record = state.activeCaseRecord;
    if (!text || !record || caseMutationLocked(record)) return;
    try {
      const payload = state.reviewAccess.active
        ? await apiClient.addReviewComment({ body: text })
        : await apiClient.addComment(record.case_id, { body: text });
      dom.reviewerComment.value = "";
      renderPersistentCase(payload.case);
      if (state.activePayload) state.activePayload.case = payload.case;
      showToast("审查意见已写入案件审计链。");
    } catch (error) {
      showApiError(error, "审查意见保存失败。");
    }
  });
  dom.reviewGrantForm.addEventListener("submit", submitReviewGrant);
  dom.copyReviewGrantButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(dom.reviewGrantLink.value);
      showToast("受限审查链接已复制。");
    } catch {
      showToast("浏览器无法写入剪贴板，请手动复制链接。");
    }
  });
}

async function loadScopedReview() {
  const payload = await apiClient.getReviewCase();
  const record = payload?.case;
  const version = record?.versions?.at(-1);
  if (!record || !version) throw new Error("受控案件记录不完整。");
  const context = record.reviewer_context || {};
  state.reviewAccess.reviewerName = context.reviewer_name || "CASE REVIEWER";
  state.reviewAccess.expiresAt = context.expires_at || "";
  state.activeCase = {
    id: record.case_id,
    code: record.case_id,
    title: record.title,
    workflow: "受控案件审查",
    source: record.declared_provenance?.channel || "PRIVATE MEDIA CUSTODY",
    handler: state.reviewAccess.reviewerName,
    timestamp: formatUtc(record.created_at),
    briefing: `该链接仅授权查看本案件、读取受保护媒体、提交评论与人工标注；有效期至 ${formatUtc(state.reviewAccess.expiresAt)}。`
  };
  setAnalysisPayload(payloadFromStoredVersion(record, version));
  renderPersistentCase(record);
  switchView("reviewer", { updateHistory: false });
  try {
    await loadSelectedVersionMedia(record, version);
  } catch (error) {
    renderMediaUnavailable(record, version);
    showApiError(error, "受控案件已打开，但受保护媒体当前不可用。");
  }
}

function renderReviewer(payload = state.activePayload) {
  if (!payload) return;
  dom.reviewerTitle.textContent = `CASE #${shortCaseId(state.activeCase.code)}`;
  dom.reviewerVerdict.textContent = state.activeCaseRecord?.human_decision
    ? `HUMAN / ${humanDecisionLabel(state.activeCaseRecord.human_decision.action).toUpperCase()}`
    : `MACHINE / ${humanDecisionLabel(payload.decision).toUpperCase()}`;
  dom.reviewerNarrative.textContent = payload.report?.summary || "该案件尚无机器摘要。";
  if (state.currentDataUrl) {
    dom.reviewerImage.src = state.currentDataUrl;
    dom.reviewerImage.hidden = false;
  } else {
    dom.reviewerImage.removeAttribute("src");
    dom.reviewerImage.hidden = true;
  }
  renderComments(state.activeCaseRecord);
}

function renderReviewerNotes() {
  renderComments(state.activeCaseRecord);
}

function renderComments(record) {
  if (!dom.reviewThread) return;
  const comments = Array.isArray(record?.comments) ? record.comments : [];
  const annotations = state.annotations || [];
  const rows = [
    ...comments.map((comment) => ({
      kind: "COMMENT",
      actor: String(comment.actor_id || "").slice(-10).toUpperCase(),
      time: comment.recorded_at,
      body: comment.body
    })),
    ...annotations.filter((annotation) => annotation.note || annotation.detail).map((annotation, index) => ({
      kind: `ANNOTATION R${index + 1}`,
      actor: String(annotation.actor_id || "HUMAN").slice(-10).toUpperCase(),
      time: annotation.recorded_at,
      body: annotation.note || annotation.detail
    }))
  ].sort((left, right) => String(left.time || "").localeCompare(String(right.time || "")));
  dom.reviewThread.innerHTML = rows.length
    ? rows.map((row) => `<article class="review-note"><time>${escapeHtml(row.kind)} / ${escapeHtml(row.actor || "REVIEWER")} / ${escapeHtml(formatUtc(row.time))}</time><p>${escapeHtml(row.body || "未填写说明")}</p></article>`).join("")
    : '<div class="capability-empty">尚无审查意见或人工标注。</div>';
}

async function submitReviewGrant(event) {
  event.preventDefault();
  const record = state.activeCaseRecord;
  if (!record || caseMutationLocked(record) || state.reviewAccess.active) return;
  try {
    const payload = await apiClient.issueReviewGrant(record.case_id, {
      reviewer_name: dom.reviewerName.value.trim(),
      expires_in_seconds: Number(dom.reviewGrantExpiry.value)
    });
    dom.reviewGrantLink.value = payload.review_url;
    dom.reviewGrantOutput.hidden = false;
    dom.reviewerName.value = "";
    renderPersistentCase(payload.case);
    if (state.activePayload) state.activePayload.case = payload.case;
    showToast("案件级限时审查权限已生成。");
  } catch (error) {
    showApiError(error, "审查权限生成失败。");
  }
}

function renderReviewGrants(record) {
  if (!dom.reviewGrantList) return;
  const grants = Array.isArray(record?.review_grants) ? record.review_grants : [];
  dom.reviewGrantList.innerHTML = grants.length
    ? grants.map((grant) => {
        const active = !grant.revoked_at && Date.parse(grant.expires_at) > Date.now();
        const revocable = active && !caseMutationLocked(record);
        return `<article data-active="${active}"><div><b>${escapeHtml(grant.reviewer_name)}</b><span>${active ? "ACTIVE" : grant.revoked_at ? "REVOKED" : "EXPIRED"}</span></div><time>${escapeHtml(formatUtc(grant.expires_at))}</time>${revocable ? `<button type="button" data-revoke-grant="${escapeHtml(grant.grant_id)}">撤销</button>` : ""}</article>`;
      }).join("")
    : '<div class="capability-empty">尚未签发案件级审查权限。</div>';
  dom.reviewGrantList.querySelectorAll("[data-revoke-grant]").forEach((button) => {
    button.addEventListener("click", () => revokeReviewGrant(button.dataset.revokeGrant));
  });
}

async function revokeReviewGrant(grantId) {
  const record = state.activeCaseRecord;
  if (!record || caseMutationLocked(record) || state.reviewAccess.active) return;
  try {
    const payload = await apiClient.revokeReviewGrant(record.case_id, grantId);
    renderPersistentCase(payload.case);
    if (state.activePayload) state.activePayload.case = payload.case;
    showToast("审查权限已立即撤销。");
  } catch (error) {
    showApiError(error, "审查权限撤销失败。");
  }
}

function openDecisionConfirmation() {
  const record = state.activeCaseRecord;
  if (!record || caseMutationLocked(record)) return;
  const decision = state.activePayload?.decision
    || selectedVersion()?.machine_recommendation
    || "review";
  const existing = record.human_decision;
  dom.humanDecisionAction.value = existing?.action || operatorActionForDecision(decision);
  dom.humanDecisionReason.value = existing?.reason_code || "model_signal";
  dom.humanDecisionNote.value = existing?.note || operatorConfirmationNote(decision);
  dom.decisionDialog.showModal();
}

function bindDialogControls() {
  dom.forceReleaseButton.addEventListener("click", openDecisionConfirmation);
  dom.feedbackButton.addEventListener("click", () => dom.feedbackDialog.showModal());
  dom.closeDecisionButton.addEventListener("click", () => dom.decisionDialog.close());
  dom.closeFeedbackButton.addEventListener("click", () => dom.feedbackDialog.close());
  dom.decisionForm.addEventListener("submit", submitHumanDecision);
  dom.feedbackForm.addEventListener("submit", submitOutcomeFeedback);
  dom.sealButton.addEventListener("click", runSealingRitual);
  dom.encryptEvidencePackage.addEventListener("change", () => {
    dom.evidencePassphraseField.hidden = !dom.encryptEvidencePackage.checked;
    if (!dom.encryptEvidencePackage.checked) dom.evidencePassphrase.value = "";
  });
  dom.downloadSgdButton.addEventListener("click", downloadEvidencePackage);
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
    dom.engineLabel.textContent = t("engine.awaiting", "等待云端推理授权；凭证仅保存在当前页面内存");
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
  if (!state.activeCaseRecord?.human_decision || caseMutationLocked(state.activeCaseRecord)) return;
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
    "[07] ASSEMBLE SIGNED SHAREGUARD .SGD V3 PAYLOAD"
  ];

  try {
    for (const step of steps.slice(0, 3)) await appendSealLog(step);
    const evidencePackage = await requestServerEvidencePackage();
    for (const step of steps.slice(3)) await appendSealLog(step);
    await appendSealLog(`[OK] ISSUER ${evidencePackage.issuer}`);
    await appendSealLog(`[OK] KEY ID ${evidencePackage.key_id}`);
    await appendSealLog(`[OK] DIGEST ${evidencePackage.payload_sha256.slice(0, 24).toUpperCase()}...`);
    await appendSealLog("[OK] SERVER SIGNATURE / PINNED TRUST ROOT");
    state.evidencePackage = evidencePackage;
    state.evidencePackageBlob = null;
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
    dom.sealButton.disabled = caseMutationLocked(state.activeCaseRecord)
      || !state.activeCaseRecord?.human_decision;
  }
}

async function downloadEvidencePackage() {
  if (!state.evidencePackage || !window.ShareGuardSgd) return;
  const encrypted = dom.encryptEvidencePackage.checked;
  const passphrase = encrypted ? dom.evidencePassphrase.value : "";
  if (encrypted && passphrase.length < 12) {
    showToast("交接口令至少需要 12 个字符。");
    dom.evidencePassphrase.focus();
    return;
  }
  dom.downloadSgdButton.disabled = true;
  try {
    const bytes = await window.ShareGuardSgd.pack(state.evidencePackage, { passphrase });
    state.evidencePackageBlob = new Blob(
      [bytes],
      { type: "application/vnd.shareguard.sgd" }
    );
    downloadBlob(
      state.evidencePackageBlob,
      state.evidencePackageName,
      "application/vnd.shareguard.sgd"
    );
    showToast(encrypted ? "已下载本地口令加密证据包。" : "已下载签名压缩证据包。");
  } catch (error) {
    showToast(String(error?.message || "证据包封装失败。"));
  } finally {
    dom.downloadSgdButton.disabled = false;
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
  if (caseMutationLocked(state.activeCaseRecord)) throw new Error("CASE IS IMMUTABLE");
  const payload = await apiClient.sealCase(caseId);
  if (
    payload?.schema !== "shareguard.sgd.v3"
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

function releaseAllVersionMedia() {
  releaseCurrentObjectUrl();
  for (const entry of state.versionMedia.values()) {
    if (entry?.url) URL.revokeObjectURL(entry.url);
  }
  state.versionMedia.clear();
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

function modelVerdictLabel(decision) {
  return decision === "hold"
    ? t("model.verdict.generated", "AI生成")
    : decision === "allow"
      ? t("model.verdict.camera", "真人拍摄")
      : t("model.verdict.review", "需专项复核");
}

function decisionStrengthLabel(value) {
  const margin = Number(value);
  if (!Number.isFinite(margin)) return t("strength.unknown", "未提供");
  if (margin >= 0.67) return t("strength.high", "高");
  if (margin >= 0.3) return t("strength.medium", "中");
  return t("strength.boundary", "边界");
}

function systemActionLabel(decision) {
  return decision === "hold"
    ? t("action.hold", "暂停分发并进入签封")
    : decision === "allow"
      ? t("action.allow", "允许使用并保存报告")
      : t("action.review", "进入专项复核队列");
}

function modelDecisionSummary(decision) {
  if (decision === "hold") {
    return t("summary.hold", "ShareGuard判定该影像为AI生成内容，系统已暂停分发并建立签封任务。");
  }
  if (decision === "allow") {
    return t("summary.allow", "ShareGuard判定该影像为真人拍摄内容，系统已允许使用并保存检测报告。");
  }
  return t("summary.review", "ShareGuard已将该影像置入专项复核队列，并锁定当前版本与证据记录。");
}

function operatorActionForDecision(decision) {
  if (decision === "hold") return "hold";
  if (decision === "allow") return "allow";
  return "escalate";
}

function operatorConfirmationNote(decision) {
  if (decision === "hold") return "确认系统已暂停该影像分发，并将模型判定与来源记录写入证据链。";
  if (decision === "allow") return "确认系统已允许使用，并保留本次检测报告。";
  return "确认该影像已进入专项复核队列。";
}

function decisionLabel(decision) {
  return decision === "hold"
    ? t("decision.hold.local", "暂停分发")
    : decision === "allow"
      ? t("decision.allow.local", "允许使用")
      : t("decision.review.local", "进入复核");
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
  })[String(action)] || "待处置确认";
}

function versionRoleLabel(role) {
  return ({
    original: "原始导入",
    observed_variant: "观察版本"
  })[String(role)] || "上传版本";
}

function versionNodeLabel(node) {
  const version = state.activeCaseRecord?.versions?.find((item) => item.version_id === node?.version_id);
  return version
    ? `${versionRoleLabel(version.role)} / ${shortVersionId(version.version_id)}`
    : shortVersionId(node?.version_id || node?.node_id || "MEDIA");
}

function shortVersionId(versionId) {
  const value = String(versionId || "MEDIA");
  return value.startsWith("sg_ver_") ? `V-${value.slice(-6).toUpperCase()}` : value.replace(/^media:/, "").slice(-14).toUpperCase();
}

function provenanceRelationshipLabel(relationship) {
  return ({
    received_from: "接收自",
    derived_from: "衍生自",
    captured_from: "采集自",
    published_at: "发布于"
  })[String(relationship)] || String(relationship || "关联");
}

function priorityLabel(priority) {
  return ({ urgent: "紧急", high: "高", normal: "普通", low: "低" })[String(priority)] || "普通";
}

function caseStatusLabel(status) {
  return ({
    awaiting_review: "待人工复核",
    awaiting_source: "等待来源材料",
    escalated: "已升级复核",
    held: "暂缓发布",
    closed_allowed: "已允许使用",
    sealed: "已签封"
  })[String(status)] || String(status || "待处理");
}

function taskStatusLabel(status) {
  return status === "completed" ? "DONE" : "OPEN";
}

function caseIsOverdue(record) {
  if (!record || ["sealed", "closed_allowed"].includes(record.status)) return false;
  const due = Date.parse(record.workflow?.sla_due_at || "");
  return Number.isFinite(due) && due < Date.now();
}

function formatSla(value, status) {
  if (!value) return "NO SLA";
  if (["sealed", "closed_allowed"].includes(status)) return "CLOSED";
  const due = Date.parse(value);
  if (!Number.isFinite(due)) return "NO SLA";
  const remaining = due - Date.now();
  const absolute = Math.abs(remaining);
  const hours = Math.floor(absolute / 3_600_000);
  const minutes = Math.floor((absolute % 3_600_000) / 60_000);
  return `${remaining < 0 ? "OVERDUE" : "DUE"} ${hours ? `${hours}H ` : ""}${minutes}M`;
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
