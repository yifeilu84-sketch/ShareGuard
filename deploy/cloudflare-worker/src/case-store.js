const CASE_ID_PATTERN = /^sg_case_[0-9a-f]{32}$/;
const VERSION_ID_PATTERN = /^sg_ver_[0-9a-f]{32}$/;
const ACTOR_ID_PATTERN = /^sg_actor_[0-9a-f]{32}$/;
const GRANT_ID_PATTERN = /^sg_grant_[0-9a-f]{32}$/;
const DELETION_ID_PATTERN = /^sg_delete_[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ZERO_HASH = "0".repeat(64);
const VERSION_ROLES = new Set([
  "original",
  "observed_variant",
  "generated_stress_test",
]);
const HUMAN_ACTIONS = new Set([
  "allow",
  "request_original",
  "escalate",
  "hold",
]);
const FEEDBACK_OUTCOMES = new Set([
  "confirmed_real",
  "confirmed_generated",
  "unresolved",
]);
const WORKFLOW_PRIORITIES = new Set(["urgent", "high", "normal", "low"]);
const PROVENANCE_RELATIONSHIPS = new Set([
  "original_source",
  "observed_from",
  "received_from",
  "reposted_from",
]);
const CLOSED_STATUSES = new Set(["closed_allowed", "sealed"]);
const SLA_MINUTES = {
  urgent: 15,
  high: 60,
  normal: 240,
  low: 1440,
};


class CaseStoreError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}


function sortedValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortedValue);
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) {
        output[key] = sortedValue(value[key]);
      }
    }
    return output;
  }
  return value;
}


export function canonicalJson(value) {
  return JSON.stringify(sortedValue(value));
}


function clone(value) {
  return JSON.parse(JSON.stringify(value));
}


function currentTimestamp(value) {
  const timestamp = value || new Date().toISOString();
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    throw new CaseStoreError(400, "invalid_timestamp", "Timestamp is invalid.");
  }
  return new Date(timestamp).toISOString();
}


function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}


function priorityFromRisk(riskLevel) {
  const normalized = String(riskLevel || "").toLowerCase();
  if (new Set(["critical", "severe"]).has(normalized)) {
    return "urgent";
  }
  if (normalized === "high") {
    return "high";
  }
  if (normalized === "low") {
    return "low";
  }
  return "normal";
}


function slaDueAt(timestamp, priority) {
  const due = new Date(timestamp);
  due.setUTCMinutes(due.getUTCMinutes() + SLA_MINUTES[priority]);
  return due.toISOString();
}


function workflowTask(type, timestamp, actorId, { title = "", dueAt = "" } = {}) {
  return {
    task_id: randomId("sg_task"),
    type,
    title: title || type.replaceAll("_", " "),
    status: "open",
    created_at: timestamp,
    created_by: actorId,
    due_at: dueAt || null,
    completed_at: null,
    completed_by: null,
  };
}


function mediaGraphNode(version) {
  return {
    node_id: `media:${version.version_id}`,
    kind: "media_version",
    version_id: version.version_id,
    role: version.role,
    file_name: version.file_name,
    media_sha256: version.media_sha256,
    received_at: version.received_at,
  };
}


function initialWorkflow(version, timestamp, actorId) {
  const priority = priorityFromRisk(version.risk_level);
  const dueAt = slaDueAt(timestamp, priority);
  return {
    priority,
    assignee: "",
    sla_due_at: dueAt,
    tasks: [workflowTask("review_media", timestamp, actorId, {
      title: "Review analyzed media",
      dueAt,
    })],
  };
}


function legacyStatus(record) {
  if (record.status === "sealed") {
    return "sealed";
  }
  const action = record.human_decision?.action;
  return {
    allow: "closed_allowed",
    request_original: "awaiting_source",
    escalate: "escalated",
    hold: "held",
  }[action] || "awaiting_review";
}


function mediaDeletionPlan(record) {
  const versions = (record.versions || []).map(version => ({
    version_id: version.version_id,
    custody_status: version.media_custody?.status || "detached_digest_only",
  }));
  const committedIds = new Set(versions.map(version => version.version_id));
  const cleanupReservations = (record.ingest_reservations || [])
    .filter(reservation => (
      reservation.status === "cleanup_required" &&
      !committedIds.has(reservation.version_id)
    ))
    .map(reservation => ({
      version_id: reservation.version_id,
      custody_status: "encrypted_private",
    }));
  return [...versions, ...cleanupReservations];
}


function normalizedIngestReservations(value, record) {
  const committedIds = new Set((record.versions || []).map(version => version.version_id));
  if (!Array.isArray(value)) return [];
  return value.filter(reservation => (
    reservation &&
    VERSION_ID_PATTERN.test(String(reservation.version_id || "")) &&
    !committedIds.has(reservation.version_id) &&
    new Set(["active", "cleanup_required"]).has(reservation.status) &&
    !Number.isNaN(Date.parse(String(reservation.reserved_at || ""))) &&
    !Number.isNaN(Date.parse(String(reservation.updated_at || reservation.reserved_at || "")))
  )).map(reservation => ({
    version_id: reservation.version_id,
    status: reservation.status,
    reserved_at: new Date(reservation.reserved_at).toISOString(),
    updated_at: new Date(reservation.updated_at || reservation.reserved_at).toISOString(),
  }));
}


function normalizedPendingDeletion(value, record) {
  const deletionEvent = [...(record.events || [])].reverse().find(event => (
    event?.event_type === "case_deletion_requested" &&
    DELETION_ID_PATTERN.test(String(event.payload?.deletion_id || "")) &&
    ACTOR_ID_PATTERN.test(String(event.actor_id || "")) &&
    !Number.isNaN(Date.parse(String(event.created_at || "")))
  ));
  const source = deletionEvent ? {
    status: "pending",
    deletion_id: deletionEvent.payload.deletion_id,
    requested_at: deletionEvent.created_at,
    requested_by: deletionEvent.actor_id,
  } : value;
  if (
    !source ||
    source.status !== "pending" ||
    !DELETION_ID_PATTERN.test(String(source.deletion_id || "")) ||
    !ACTOR_ID_PATTERN.test(String(source.requested_by || "")) ||
    Number.isNaN(Date.parse(String(source.requested_at || "")))
  ) {
    return null;
  }
  return {
    status: "pending",
    deletion_id: source.deletion_id,
    requested_at: new Date(source.requested_at).toISOString(),
    requested_by: source.requested_by,
    media_versions: mediaDeletionPlan(record),
  };
}


export function migrateCaseRecord(record) {
  if (!record || typeof record !== "object") {
    return record;
  }
  const next = clone(record);
  const firstVersion = next.versions?.[0] || {};
  const fallbackActor = next.events?.[0]?.actor_id || `sg_actor_${"0".repeat(32)}`;
  const createdAt = next.created_at || new Date(0).toISOString();
  next.schema = "shareguard.case.v3";
  next.status = legacyStatus(next);
  for (const version of next.versions || []) {
    if (!version.media_custody) {
      version.media_custody = {
        status: "detached_digest_only",
        plaintext_sha256: version.media_sha256,
        byte_size: null,
        content_type: "",
        file_name: version.file_name,
        stored_at: null,
        retention_until: null,
        encryption: null,
      };
    }
  }
  if (!next.workflow || typeof next.workflow !== "object") {
    next.workflow = initialWorkflow(firstVersion, createdAt, fallbackActor);
    if (CLOSED_STATUSES.has(next.status)) {
      for (const task of next.workflow.tasks) {
        task.status = "completed";
        task.completed_at = next.updated_at || createdAt;
        task.completed_by = next.human_decision?.actor_id || fallbackActor;
      }
    }
  }
  next.comments = Array.isArray(next.comments) ? next.comments : [];
  next.review_grants = Array.isArray(next.review_grants) ? next.review_grants : [];
  next.ingest_reservations = normalizedIngestReservations(next.ingest_reservations, next);
  next.deletion = normalizedPendingDeletion(next.deletion, next);
  if (!next.provenance_graph || typeof next.provenance_graph !== "object") {
    next.provenance_graph = {
      nodes: (next.versions || []).map(mediaGraphNode),
      edges: [],
    };
  }
  return next;
}


export function reviewGrantIsActive(record, claims, now = new Date().toISOString()) {
  if (!record || record.case_id !== claims?.case_id) return false;
  const grant = (record.review_grants || []).find(item => (
    item.grant_id === claims.grant_id &&
    item.reviewer_actor_id === claims.reviewer_actor_id &&
    item.role === "reviewer"
  ));
  if (!grant || grant.revoked_at) return false;
  const timestamp = Date.parse(now);
  return Number.isFinite(timestamp) && Date.parse(grant.expires_at) > timestamp;
}


function requiredId(value, pattern, field) {
  if (!pattern.test(String(value || ""))) {
    throw new CaseStoreError(400, "invalid_identifier", `${field} is invalid.`);
  }
  return String(value);
}


function boundedText(value, field, maxLength, { required = false } = {}) {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) {
    throw new CaseStoreError(400, "invalid_field", `${field} is required.`);
  }
  if (normalized.length > maxLength) {
    throw new CaseStoreError(
      400,
      "invalid_field",
      `${field} exceeds ${maxLength} characters.`,
    );
  }
  return normalized;
}


function finiteUnit(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new CaseStoreError(400, "invalid_field", `${field} must be between 0 and 1.`);
  }
  return number;
}


function safeUrl(value) {
  const text = boundedText(value, "source_url", 2048);
  if (!text) {
    return "";
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new CaseStoreError(400, "invalid_field", "source_url is invalid.");
  }
  if (!new Set(["https:", "http:"]).has(parsed.protocol)) {
    throw new CaseStoreError(
      400,
      "invalid_field",
      "source_url must use HTTP or HTTPS.",
    );
  }
  return parsed.toString();
}


async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}


async function appendEvent(record, type, payload, actorId, timestamp) {
  const events = record.events || [];
  const core = {
    sequence: events.length + 1,
    created_at: timestamp,
    actor_id: requiredId(actorId, ACTOR_ID_PATTERN, "actor_id"),
    event_type: boundedText(type, "event_type", 64, { required: true }),
    payload: clone(payload || {}),
    previous_hash: events.length ? events.at(-1).event_hash : ZERO_HASH,
  };
  const event = {
    ...core,
    event_hash: await sha256Hex(canonicalJson(core)),
  };
  record.events = [...events, event];
  record.chain_head = event.event_hash;
  record.updated_at = timestamp;
  return record;
}


export async function verifyEventChain(events) {
  if (!Array.isArray(events)) {
    return false;
  }
  let previousHash = ZERO_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const core = {
      sequence: event.sequence,
      created_at: event.created_at,
      actor_id: event.actor_id,
      event_type: event.event_type,
      payload: event.payload,
      previous_hash: event.previous_hash,
    };
    if (
      event.sequence !== index + 1 ||
      event.previous_hash !== previousHash ||
      event.event_hash !== await sha256Hex(canonicalJson(core))
    ) {
      return false;
    }
    previousHash = event.event_hash;
  }
  return true;
}


function sanitizeAnalysis(analysis) {
  if (!analysis || typeof analysis !== "object") {
    throw new CaseStoreError(400, "invalid_analysis", "Analysis result is required.");
  }
  const mediaSha256 = String(analysis.media_sha256 || "").toLowerCase();
  if (!SHA256_PATTERN.test(mediaSha256)) {
    throw new CaseStoreError(400, "invalid_analysis", "media_sha256 is invalid.");
  }
  const modelScore = finiteUnit(analysis.model_score, "model_score");
  const decisionMargin = finiteUnit(
    analysis.decision_margin ?? analysis.confidence ?? 0,
    "decision_margin",
  );
  const machineRecommendation = boundedText(
    analysis.machine_recommendation || analysis.decision,
    "machine_recommendation",
    32,
    { required: true },
  );
  if (!new Set(["allow", "review"]).has(machineRecommendation)) {
    throw new CaseStoreError(
      400,
      "invalid_analysis",
      "machine_recommendation is invalid.",
    );
  }
  const image = analysis.image || {};
  const width = Number.parseInt(String(image.width), 10);
  const height = Number.parseInt(String(image.height), 10);
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new CaseStoreError(400, "invalid_analysis", "Image dimensions are invalid.");
  }
  const latency = Number(analysis.latency_ms);
  if (!Number.isFinite(latency) || latency < 0 || latency > 3_600_000) {
    throw new CaseStoreError(400, "invalid_analysis", "latency_ms is invalid.");
  }

  return {
    request_id: boundedText(analysis.request_id, "request_id", 128, { required: true }),
    media_sha256: mediaSha256,
    engine_release: boundedText(
      analysis.engine_release || analysis.model_version,
      "engine_release",
      128,
      { required: true },
    ),
    detector_engine: boundedText(
      analysis.detector_engine,
      "detector_engine",
      128,
      { required: true },
    ),
    decision_layer: boundedText(
      analysis.decision_layer,
      "decision_layer",
      128,
      { required: true },
    ),
    machine_recommendation: machineRecommendation,
    decision_label: boundedText(analysis.decision_label, "decision_label", 128),
    risk_level: boundedText(analysis.risk_level, "risk_level", 32),
    model_score: modelScore,
    score_kind: boundedText(analysis.score_kind, "score_kind", 64, { required: true }),
    decision_margin: decisionMargin,
    latency_ms: Math.round(latency),
    image: {
      width,
      height,
      format: boundedText(image.format, "image.format", 16),
    },
    calibration: clone(analysis.calibration || { status: "unavailable" }),
    policy: clone(analysis.policy || {}),
    reliability: clone(analysis.reliability || {}),
    report: clone(analysis.report || {}),
  };
}


function sanitizeMediaCustody(value, analysis, fileName) {
  if (!value || value.status !== "encrypted_private") {
    return {
      status: "detached_digest_only",
      plaintext_sha256: analysis.media_sha256,
      byte_size: null,
      content_type: "",
      file_name: fileName,
      stored_at: null,
      retention_until: null,
      encryption: null,
    };
  }
  const digest = String(value.plaintext_sha256 || "").toLowerCase();
  if (digest !== analysis.media_sha256) {
    throw new CaseStoreError(400, "invalid_media_custody", "Media custody digest is invalid.");
  }
  const byteSize = Number.parseInt(String(value.byte_size), 10);
  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > 50_000_000) {
    throw new CaseStoreError(400, "invalid_media_custody", "Media custody size is invalid.");
  }
  const contentType = boundedText(value.content_type, "media.content_type", 64, { required: true });
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(contentType)) {
    throw new CaseStoreError(400, "invalid_media_custody", "Media custody type is invalid.");
  }
  const storedAt = currentTimestamp(value.stored_at);
  const retentionUntil = currentTimestamp(value.retention_until);
  const encryption = value.encryption || {};
  if (encryption.algorithm !== "AES-256-GCM") {
    throw new CaseStoreError(400, "invalid_media_custody", "Media custody encryption is invalid.");
  }
  return {
    status: "encrypted_private",
    plaintext_sha256: digest,
    byte_size: byteSize,
    content_type: contentType,
    file_name: boundedText(value.file_name || fileName, "media.file_name", 255, { required: true }),
    stored_at: storedAt,
    retention_until: retentionUntil,
    encryption: {
      algorithm: "AES-256-GCM",
      key_version: boundedText(
        encryption.key_version,
        "media.encryption.key_version",
        64,
        { required: true },
      ),
      iv: boundedText(encryption.iv, "media.encryption.iv", 64, { required: true }),
    },
  };
}


function versionFromAnalysis(analysis, context, timestamp) {
  const sanitized = sanitizeAnalysis(analysis);
  const versionId = requiredId(
    context.versionId || randomId("sg_ver"),
    VERSION_ID_PATTERN,
    "version_id",
  );
  const role = String(context.versionRole || "original");
  if (!VERSION_ROLES.has(role)) {
    throw new CaseStoreError(400, "invalid_field", "version_role is invalid.");
  }
  const fileName = boundedText(
    context.fileName || sanitized.report?.subject?.file_name || "upload",
    "file_name",
    255,
    { required: true },
  );
  return {
    version_id: versionId,
    role,
    file_name: fileName,
    received_at: timestamp,
    ...sanitized,
    media_custody: sanitizeMediaCustody(context.mediaCustody, sanitized, fileName),
  };
}


function versionEventPayload(version) {
  return {
    version_id: version.version_id,
    role: version.role,
    file_name: version.file_name,
    request_id: version.request_id,
    media_sha256: version.media_sha256,
    engine_release: version.engine_release,
    machine_recommendation: version.machine_recommendation,
    risk_level: version.risk_level,
    model_score: version.model_score,
    score_kind: version.score_kind,
    decision_margin: version.decision_margin,
    latency_ms: version.latency_ms,
    media_custody_status: version.media_custody.status,
  };
}


export async function createCase(analysis, context = {}) {
  const timestamp = currentTimestamp(context.now);
  const actorId = requiredId(context.actorId, ACTOR_ID_PATTERN, "actor_id");
  const caseId = requiredId(
    context.caseId || randomId("sg_case"),
    CASE_ID_PATTERN,
    "case_id",
  );
  const version = versionFromAnalysis(analysis, context, timestamp);
  const record = {
    schema: "shareguard.case.v3",
    case_id: caseId,
    title: boundedText(context.title || version.file_name, "title", 160, { required: true }),
    status: "awaiting_review",
    created_at: timestamp,
    updated_at: timestamp,
    sealed_at: null,
    versions: [version],
    declared_provenance: null,
    annotations: {},
    human_decision: null,
    feedback: null,
    workflow: initialWorkflow(version, timestamp, actorId),
    comments: [],
    review_grants: [],
    ingest_reservations: [],
    deletion: null,
    provenance_graph: {
      nodes: [mediaGraphNode(version)],
      edges: [],
    },
    events: [],
    chain_head: ZERO_HASH,
  };
  await appendEvent(record, "case_created", {
    case_id: caseId,
    title: record.title,
  }, actorId, timestamp);
  await appendEvent(
    record,
    "version_analyzed",
    versionEventPayload(version),
    actorId,
    timestamp,
  );
  return record;
}


function normalizeAnnotation(annotation, index, actorId, timestamp) {
  if (!annotation || typeof annotation !== "object") {
    throw new CaseStoreError(400, "invalid_field", "annotation is invalid.");
  }
  const x = finiteUnit(annotation.x, `annotations[${index}].x`);
  const y = finiteUnit(annotation.y, `annotations[${index}].y`);
  const width = finiteUnit(annotation.width, `annotations[${index}].width`);
  const height = finiteUnit(annotation.height, `annotations[${index}].height`);
  if (width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw new CaseStoreError(400, "invalid_field", "annotation bounds are invalid.");
  }
  return {
    annotation_id: boundedText(
      annotation.annotation_id || `annotation-${index + 1}`,
      "annotation_id",
      64,
      { required: true },
    ),
    x,
    y,
    width,
    height,
    note: boundedText(annotation.note, "annotation.note", 500),
    origin: "human_reviewer",
    actor_id: actorId,
    recorded_at: timestamp,
  };
}


function completeOpenTasks(workflow, timestamp, actorId) {
  for (const task of workflow.tasks || []) {
    if (task.status === "open") {
      task.status = "completed";
      task.completed_at = timestamp;
      task.completed_by = actorId;
    }
  }
}


function addActionTask(workflow, action, timestamp, actorId) {
  const taskType = {
    request_original: "source_acquisition",
    escalate: "senior_review",
    hold: "hold_resolution",
  }[action];
  if (!taskType) {
    return;
  }
  workflow.tasks.push(workflowTask(taskType, timestamp, actorId, {
    title: {
      source_acquisition: "Obtain and verify the original media",
      senior_review: "Complete senior editorial review",
      hold_resolution: "Resolve publication hold",
    }[taskType],
    dueAt: workflow.sla_due_at,
  }));
}


export async function applyCaseCommand(record, command, context = {}) {
  if (!record || typeof record !== "object") {
    throw new CaseStoreError(404, "case_not_found", "Case not found.");
  }
  const migrated = migrateCaseRecord(record);
  if (!await verifyEventChain(migrated.events)) {
    throw new CaseStoreError(409, "invalid_event_chain", "Case event chain is invalid.");
  }
  const type = String(command?.type || "");
  const payload = command?.payload || {};
  const accessRole = String(context.accessRole || "owner");
  if (accessRole === "reviewer" && !new Set(["annotations", "comment"]).has(type)) {
    throw new CaseStoreError(403, "permission_denied", "Reviewer permission does not allow this command.");
  }
  if (!new Set(["owner", "reviewer"]).has(accessRole)) {
    throw new CaseStoreError(403, "permission_denied", "Access role is invalid.");
  }
  if (migrated.deletion?.status === "pending") {
    throw new CaseStoreError(
      409,
      "case_deletion_pending",
      "Case deletion is pending and the case cannot be changed.",
    );
  }
  if (migrated.status === "sealed") {
    const activeKeyId = migrated.events?.at(-1)?.payload?.key_id;
    if (type === "seal" && payload.key_id === activeKeyId) {
      return clone(migrated);
    }
    throw new CaseStoreError(409, "case_sealed", "Case is sealed and cannot be changed.");
  }
  const actorId = requiredId(context.actorId, ACTOR_ID_PATTERN, "actor_id");
  const timestamp = currentTimestamp(context.now);
  const next = clone(migrated);

  if (type === "add_version") {
    const version = versionFromAnalysis(payload.analysis, {
      versionId: payload.version_id,
      versionRole: payload.version_role,
      fileName: payload.file_name,
      mediaCustody: payload.media_custody,
    }, timestamp);
    if (next.versions.some(item => item.media_sha256 === version.media_sha256)) {
      throw new CaseStoreError(
        409,
        "duplicate_version",
        "This media digest already exists in the case.",
      );
    }
    next.versions.push(version);
    next.provenance_graph.nodes.push(mediaGraphNode(version));
    next.human_decision = null;
    next.status = "awaiting_review";
    next.workflow.tasks.push(workflowTask("review_media", timestamp, actorId, {
      title: "Review newly added media version",
      dueAt: next.workflow.sla_due_at,
    }));
    await appendEvent(
      next,
      "version_analyzed",
      versionEventPayload(version),
      actorId,
      timestamp,
    );
    return next;
  }

  if (type === "decision") {
    const action = String(payload.action || "");
    if (!HUMAN_ACTIONS.has(action)) {
      throw new CaseStoreError(400, "invalid_field", "action is invalid.");
    }
    const reasonCode = boundedText(
      payload.reason_code,
      "reason_code",
      64,
      { required: true },
    );
    const note = boundedText(payload.note, "note", 1000);
    if (reasonCode === "other" && !note) {
      throw new CaseStoreError(400, "invalid_field", "note is required for reason_code other.");
    }
    next.human_decision = {
      action,
      reason_code: reasonCode,
      note,
      actor_id: actorId,
      recorded_at: timestamp,
    };
    completeOpenTasks(next.workflow, timestamp, actorId);
    next.status = {
      allow: "closed_allowed",
      request_original: "awaiting_source",
      escalate: "escalated",
      hold: "held",
    }[action];
    addActionTask(next.workflow, action, timestamp, actorId);
    await appendEvent(next, "human_decision_recorded", next.human_decision, actorId, timestamp);
    return next;
  }

  if (type === "annotations") {
    const versionId = requiredId(payload.version_id, VERSION_ID_PATTERN, "version_id");
    if (!next.versions.some(item => item.version_id === versionId)) {
      throw new CaseStoreError(404, "version_not_found", "Version not found.");
    }
    if (!Array.isArray(payload.annotations) || payload.annotations.length > 50) {
      throw new CaseStoreError(400, "invalid_field", "annotations must contain at most 50 items.");
    }
    const annotations = payload.annotations.map((annotation, index) => (
      normalizeAnnotation(annotation, index, actorId, timestamp)
    ));
    next.annotations[versionId] = annotations;
    await appendEvent(next, "annotations_replaced", {
      version_id: versionId,
      annotations,
    }, actorId, timestamp);
    return next;
  }

  if (type === "provenance") {
    const versionId = payload.version_id
      ? requiredId(payload.version_id, VERSION_ID_PATTERN, "version_id")
      : next.versions.at(-1)?.version_id;
    const targetVersion = next.versions.find(item => item.version_id === versionId);
    if (!targetVersion) {
      throw new CaseStoreError(404, "version_not_found", "Version not found.");
    }
    const channel = boundedText(payload.channel, "channel", 120, { required: true });
    const capturedAt = boundedText(payload.captured_at, "captured_at", 64);
    if (capturedAt && Number.isNaN(Date.parse(capturedAt))) {
      throw new CaseStoreError(400, "invalid_field", "captured_at is invalid.");
    }
    const relationship = String(payload.relationship || "received_from");
    if (!PROVENANCE_RELATIONSHIPS.has(relationship)) {
      throw new CaseStoreError(400, "invalid_field", "relationship is invalid.");
    }
    const sourceDigest = String(payload.source_media_sha256 || "").toLowerCase();
    if (sourceDigest && !SHA256_PATTERN.test(sourceDigest)) {
      throw new CaseStoreError(400, "invalid_field", "source_media_sha256 is invalid.");
    }
    const verificationStatus = sourceDigest === targetVersion.media_sha256
      ? "digest_verified"
      : "declared_unverified";
    const sourceNode = {
      node_id: randomId("sg_src"),
      kind: "declared_source",
      channel,
      source_url: safeUrl(payload.source_url),
      captured_at: capturedAt ? new Date(capturedAt).toISOString() : "",
      note: boundedText(payload.note, "note", 1000),
      source_media_sha256: sourceDigest,
      actor_id: actorId,
      recorded_at: timestamp,
    };
    const edge = {
      edge_id: randomId("sg_edge"),
      source_node_id: sourceNode.node_id,
      target_node_id: `media:${versionId}`,
      target_version_id: versionId,
      relationship,
      verification_status: verificationStatus,
      evidence_basis: verificationStatus === "digest_verified"
        ? "exact_sha256_match"
        : "reviewer_declaration",
      actor_id: actorId,
      recorded_at: timestamp,
    };
    next.provenance_graph.nodes.push(sourceNode);
    next.provenance_graph.edges.push(edge);
    next.declared_provenance = {
      status: verificationStatus,
      ...sourceNode,
      relationship,
      target_version_id: versionId,
    };
    await appendEvent(
      next,
      "provenance_declared",
      { source_node: sourceNode, edge },
      actorId,
      timestamp,
    );
    return next;
  }

  if (type === "workflow") {
    const priority = payload.priority
      ? String(payload.priority)
      : next.workflow.priority;
    if (!WORKFLOW_PRIORITIES.has(priority)) {
      throw new CaseStoreError(400, "invalid_field", "priority is invalid.");
    }
    const assignee = payload.assignee === undefined
      ? next.workflow.assignee
      : boundedText(payload.assignee, "assignee", 120);
    const priorityChanged = priority !== next.workflow.priority;
    next.workflow.priority = priority;
    next.workflow.assignee = assignee;
    if (priorityChanged) {
      next.workflow.sla_due_at = slaDueAt(timestamp, priority);
      for (const task of next.workflow.tasks) {
        if (task.status === "open") {
          task.due_at = next.workflow.sla_due_at;
        }
      }
    }
    await appendEvent(next, "workflow_updated", {
      priority: next.workflow.priority,
      assignee: next.workflow.assignee,
      sla_due_at: next.workflow.sla_due_at,
    }, actorId, timestamp);
    return next;
  }

  if (type === "comment") {
    const comment = {
      comment_id: randomId("sg_comment"),
      body: boundedText(payload.body, "body", 2000, { required: true }),
      actor_id: actorId,
      recorded_at: timestamp,
    };
    next.comments.push(comment);
    await appendEvent(next, "comment_added", comment, actorId, timestamp);
    return next;
  }

  if (type === "review_grant") {
    const grantId = requiredId(payload.grant_id, GRANT_ID_PATTERN, "grant_id");
    if (next.review_grants.some(item => item.grant_id === grantId)) {
      throw new CaseStoreError(409, "duplicate_grant", "Review grant already exists.");
    }
    const issuedAt = currentTimestamp(payload.issued_at || timestamp);
    const expiresAt = currentTimestamp(payload.expires_at);
    if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
      throw new CaseStoreError(400, "invalid_field", "Review grant expiry is invalid.");
    }
    const grant = {
      grant_id: grantId,
      reviewer_actor_id: requiredId(
        payload.reviewer_actor_id,
        ACTOR_ID_PATTERN,
        "reviewer_actor_id",
      ),
      reviewer_name: boundedText(
        payload.reviewer_name,
        "reviewer_name",
        120,
        { required: true },
      ),
      role: payload.role === "reviewer" ? "reviewer" : "",
      issued_at: issuedAt,
      expires_at: expiresAt,
      issued_by: actorId,
      revoked_at: null,
      revoked_by: null,
    };
    if (!grant.role) {
      throw new CaseStoreError(400, "invalid_field", "Review grant role is invalid.");
    }
    next.review_grants.push(grant);
    await appendEvent(next, "review_grant_issued", grant, actorId, timestamp);
    return next;
  }

  if (type === "revoke_review_grant") {
    const grantId = requiredId(payload.grant_id, GRANT_ID_PATTERN, "grant_id");
    const grant = next.review_grants.find(item => item.grant_id === grantId);
    if (!grant) {
      throw new CaseStoreError(404, "grant_not_found", "Review grant not found.");
    }
    if (!grant.revoked_at) {
      grant.revoked_at = timestamp;
      grant.revoked_by = actorId;
      await appendEvent(next, "review_grant_revoked", {
        grant_id: grantId,
        revoked_at: timestamp,
      }, actorId, timestamp);
    }
    return next;
  }

  if (type === "feedback") {
    const outcome = String(payload.outcome || "");
    if (!FEEDBACK_OUTCOMES.has(outcome)) {
      throw new CaseStoreError(400, "invalid_field", "feedback outcome is invalid.");
    }
    const basis = boundedText(payload.evidence_basis, "evidence_basis", 1000);
    if (outcome !== "unresolved" && !basis) {
      throw new CaseStoreError(
        400,
        "invalid_field",
        "evidence_basis is required for confirmed feedback.",
      );
    }
    next.feedback = {
      outcome,
      evidence_basis: basis,
      actor_id: actorId,
      recorded_at: timestamp,
    };
    await appendEvent(next, "outcome_feedback_recorded", next.feedback, actorId, timestamp);
    return next;
  }

  if (type === "seal") {
    const reservations = Array.isArray(next.ingest_reservations)
      ? next.ingest_reservations
      : [];
    if (reservations.some(item => item.status === "active")) {
      throw new CaseStoreError(
        409,
        "case_ingest_in_progress",
        "Case media ingest is still in progress.",
      );
    }
    if (reservations.some(item => item.status === "cleanup_required")) {
      throw new CaseStoreError(
        409,
        "media_cleanup_required",
        "Uncommitted private media must be cleaned before sealing.",
      );
    }
    if (!next.human_decision) {
      throw new CaseStoreError(
        409,
        "decision_required",
        "A human decision is required before sealing.",
      );
    }
    const keyId = boundedText(payload.key_id, "key_id", 128, { required: true });
    next.status = "sealed";
    next.sealed_at = timestamp;
    await appendEvent(next, "case_sealed", {
      key_id: keyId,
      human_decision_action: next.human_decision.action,
    }, actorId, timestamp);
    return next;
  }

  throw new CaseStoreError(400, "invalid_command", "Case command is invalid.");
}


function percentile(values, quantile) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)];
}


function emptyCounts(keys) {
  return Object.fromEntries(keys.map(key => [key, 0]));
}


export function buildMetrics(cases) {
  const records = Array.isArray(cases) ? cases : [];
  const machine = emptyCounts(["allow", "review"]);
  const human = emptyCounts([...HUMAN_ACTIONS]);
  const feedback = emptyCounts([...FEEDBACK_OUTCOMES]);
  const latencies = [];
  const scores = [];
  let versionCount = 0;
  let overrideCount = 0;
  let sealedCount = 0;

  for (const record of records) {
    if (record.status === "sealed") {
      sealedCount += 1;
    }
    for (const version of record.versions || []) {
      versionCount += 1;
      if (machine[version.machine_recommendation] !== undefined) {
        machine[version.machine_recommendation] += 1;
      }
      if (Number.isFinite(version.latency_ms)) {
        latencies.push(version.latency_ms);
      }
      if (Number.isFinite(version.model_score)) {
        scores.push(version.model_score);
      }
    }
    const action = record.human_decision?.action;
    if (action && human[action] !== undefined) {
      human[action] += 1;
      const latestMachine = record.versions?.at(-1)?.machine_recommendation;
      if (latestMachine && latestMachine !== action) {
        overrideCount += 1;
      }
    }
    const outcome = record.feedback?.outcome;
    if (outcome && feedback[outcome] !== undefined) {
      feedback[outcome] += 1;
    }
  }

  const meanLatency = latencies.length
    ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
    : null;
  const histogram = [0, 0, 0, 0, 0];
  for (const score of scores) {
    histogram[Math.min(4, Math.floor(score * 5))] += 1;
  }

  return {
    generated_at: new Date().toISOString(),
    case_count: records.length,
    open_case_count: records.length - sealedCount,
    sealed_case_count: sealedCount,
    version_count: versionCount,
    machine_recommendations: machine,
    human_decisions: human,
    override_count: overrideCount,
    feedback,
    latency: {
      sample_count: latencies.length,
      mean_ms: meanLatency,
      p50_ms: percentile(latencies, 0.5),
      p95_ms: percentile(latencies, 0.95),
    },
    score_histogram: {
      sample_count: scores.length,
      bins: ["0.0-0.2", "0.2-0.4", "0.4-0.6", "0.6-0.8", "0.8-1.0"],
      counts: histogram,
    },
    distribution_shift: {
      status: scores.length < 30 ? "insufficient_data" : "baseline_unavailable",
      sample_count: scores.length,
      minimum_sample_count: 30,
      interpretation: "score_distribution_signal_not_accuracy_drift",
    },
  };
}


function caseSummary(record) {
  record = migrateCaseRecord(record);
  const latest = record.versions?.at(-1) || {};
  const openTasks = (record.workflow?.tasks || []).filter(task => task.status === "open");
  return {
    case_id: record.case_id,
    title: record.title,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
    sealed_at: record.sealed_at,
    version_count: record.versions?.length || 0,
    latest_machine_recommendation: latest.machine_recommendation || null,
    latest_risk_level: latest.risk_level || null,
    human_decision: record.human_decision,
    workflow: {
      priority: record.workflow.priority,
      assignee: record.workflow.assignee,
      sla_due_at: record.workflow.sla_due_at,
      open_task_count: openTasks.length,
      next_task: openTasks[0]?.type || null,
    },
    deletion: record.deletion,
    chain_head: record.chain_head,
  };
}


export function sortCaseSummaries(records, now = new Date().toISOString()) {
  const timestamp = Date.parse(now);
  const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3 };
  return [...(records || [])].sort((left, right) => {
    const leftClosed = CLOSED_STATUSES.has(left.status) ? 1 : 0;
    const rightClosed = CLOSED_STATUSES.has(right.status) ? 1 : 0;
    if (leftClosed !== rightClosed) {
      return leftClosed - rightClosed;
    }
    const leftOverdue = !leftClosed && Date.parse(left.workflow?.sla_due_at || "") < timestamp ? 0 : 1;
    const rightOverdue = !rightClosed && Date.parse(right.workflow?.sla_due_at || "") < timestamp ? 0 : 1;
    if (leftOverdue !== rightOverdue) {
      return leftOverdue - rightOverdue;
    }
    const priorityDifference = (priorityRank[left.workflow?.priority] ?? 9) - (
      priorityRank[right.workflow?.priority] ?? 9
    );
    if (priorityDifference) {
      return priorityDifference;
    }
    return String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
  });
}


function internalJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}


async function readJson(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    throw new CaseStoreError(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CaseStoreError(400, "invalid_json", "Request body must be a JSON object.");
  }
  return payload;
}


export class ShareGuardCaseStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    try {
      return await this.handle(request);
    } catch (error) {
      if (error instanceof CaseStoreError) {
        return internalJson({ error: { code: error.code, message: error.message } }, error.status);
      }
      return internalJson(
        { error: { code: "case_store_unavailable", message: "Case store is unavailable." } },
        503,
      );
    }
  }

  async handle(request) {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    if (request.method === "POST" && url.pathname === "/ingest") {
      const payload = await readJson(request);
      const actorId = requiredId(payload.actor_id, ACTOR_ID_PATTERN, "actor_id");
      const requestedCaseId = payload.case_id || null;
      const result = await this.state.storage.transaction(async transaction => {
        if (requestedCaseId) {
          const caseId = requiredId(requestedCaseId, CASE_ID_PATTERN, "case_id");
          const key = `case:${caseId}`;
          const existing = await transaction.get(key);
          if (!existing) {
            throw new CaseStoreError(404, "case_not_found", "Case not found.");
          }
          const reservationId = payload.reservation_id
            ? requiredId(payload.reservation_id, VERSION_ID_PATTERN, "reservation_id")
            : null;
          if (reservationId && reservationId !== payload.version_id) {
            throw new CaseStoreError(409, "ingest_reservation_conflict", "Ingest reservation does not match the version.");
          }
          const migrated = migrateCaseRecord(existing);
          if (reservationId && !migrated.ingest_reservations.some(reservation => (
            reservation.version_id === reservationId && reservation.status === "active"
          ))) {
            throw new CaseStoreError(409, "ingest_reservation_missing", "Active ingest reservation was not found.");
          }
          const next = await applyCaseCommand(migrated, {
            type: "add_version",
            payload: {
              analysis: payload.analysis,
              version_id: payload.version_id,
              version_role: payload.version_role,
              file_name: payload.file_name,
              media_custody: payload.media_custody,
            },
          }, { actorId });
          if (reservationId) {
            next.ingest_reservations = next.ingest_reservations.filter(
              reservation => reservation.version_id !== reservationId,
            );
          }
          await transaction.put(key, next);
          return next;
        }
        const created = await createCase(payload.analysis, {
          caseId: payload.new_case_id,
          versionId: payload.version_id,
          versionRole: payload.version_role,
          fileName: payload.file_name,
          mediaCustody: payload.media_custody,
          title: payload.title,
          actorId,
        });
        await transaction.put(`case:${created.case_id}`, created);
        return created;
      });
      return internalJson({ case: result }, requestedCaseId ? 200 : 201);
    }

    if (request.method === "GET" && url.pathname === "/cases") {
      const stored = await this.state.storage.list({ prefix: "case:" });
      const statusFilter = String(url.searchParams.get("status") || "").trim();
      const priorityFilter = String(url.searchParams.get("priority") || "").trim();
      const requestedLimit = Number.parseInt(url.searchParams.get("limit") || "20", 10);
      const limit = Number.isSafeInteger(requestedLimit)
        ? Math.max(1, Math.min(100, requestedLimit))
        : 20;
      const requestedCursor = Number.parseInt(url.searchParams.get("cursor") || "0", 10);
      const cursor = Number.isSafeInteger(requestedCursor) && requestedCursor >= 0
        ? requestedCursor
        : 0;
      const ordered = sortCaseSummaries([...stored.values()].map(caseSummary));
      const filtered = ordered.filter(record => (
        (!statusFilter || record.status === statusFilter) &&
        (!priorityFilter || record.workflow.priority === priorityFilter)
      ));
      const cases = filtered.slice(cursor, cursor + limit);
      const nextCursor = cursor + cases.length < filtered.length
        ? cursor + cases.length
        : null;
      return internalJson({ cases, next_cursor: nextCursor, total: filtered.length });
    }

    if (request.method === "GET" && url.pathname === "/metrics") {
      const stored = await this.state.storage.list({ prefix: "case:" });
      return internalJson({ metrics: buildMetrics([...stored.values()]) });
    }

    if (segments[0] === "cases" && segments.length >= 2) {
      const caseId = requiredId(segments[1], CASE_ID_PATTERN, "case_id");
      const key = `case:${caseId}`;
      const tombstoneKey = `deletion:${caseId}`;
      if (request.method === "GET" && segments.length === 2) {
        const record = await this.state.storage.get(key);
        if (!record) {
          throw new CaseStoreError(404, "case_not_found", "Case not found.");
        }
        return internalJson({ case: migrateCaseRecord(record) });
      }
      if (
        request.method === "POST" &&
        segments.length === 3 &&
        segments[2] === "ingest-reservations"
      ) {
        const payload = await readJson(request);
        const actorId = requiredId(payload.actor_id, ACTOR_ID_PATTERN, "actor_id");
        const versionId = requiredId(payload.version_id, VERSION_ID_PATTERN, "version_id");
        const timestamp = currentTimestamp();
        const result = await this.state.storage.transaction(async transaction => {
          const existing = await transaction.get(key);
          if (!existing) {
            throw new CaseStoreError(404, "case_not_found", "Case not found.");
          }
          const migrated = migrateCaseRecord(existing);
          if (!await verifyEventChain(migrated.events)) {
            throw new CaseStoreError(409, "invalid_event_chain", "Case event chain is invalid.");
          }
          if (migrated.deletion?.status === "pending") {
            throw new CaseStoreError(409, "case_deletion_pending", "Case deletion is pending.");
          }
          if (migrated.status === "sealed") {
            throw new CaseStoreError(409, "case_sealed", "Case is sealed and cannot be changed.");
          }
          if (migrated.versions.some(version => version.version_id === versionId)) {
            throw new CaseStoreError(409, "duplicate_version", "Version already exists in the case.");
          }
          const current = migrated.ingest_reservations.find(
            reservation => reservation.version_id === versionId,
          );
          if (current) {
            return { reservation: current, created: false };
          }
          const reservation = {
            version_id: versionId,
            status: "active",
            reserved_at: timestamp,
            updated_at: timestamp,
          };
          migrated.ingest_reservations.push(reservation);
          await transaction.put(key, migrated);
          return { reservation, created: true };
        });
        return internalJson(
          { reservation: result.reservation },
          result.created ? 201 : 200,
        );
      }
      if (
        request.method === "POST" &&
        segments.length === 5 &&
        segments[2] === "ingest-reservations" &&
        new Set(["release", "abandon"]).has(segments[4])
      ) {
        const versionId = requiredId(segments[3], VERSION_ID_PATTERN, "version_id");
        const action = segments[4];
        const payload = await readJson(request);
        requiredId(payload.actor_id, ACTOR_ID_PATTERN, "actor_id");
        const timestamp = currentTimestamp();
        const result = await this.state.storage.transaction(async transaction => {
          const existing = await transaction.get(key);
          if (!existing) {
            throw new CaseStoreError(404, "case_not_found", "Case not found.");
          }
          const migrated = migrateCaseRecord(existing);
          if (!await verifyEventChain(migrated.events)) {
            throw new CaseStoreError(409, "invalid_event_chain", "Case event chain is invalid.");
          }
          const committedVersion = migrated.versions.find(
            item => item.version_id === versionId,
          );
          if (committedVersion) {
            return {
              committed: true,
              version_id: versionId,
              case: migrated,
            };
          }
          const reservation = migrated.ingest_reservations.find(
            item => item.version_id === versionId,
          );
          if (!reservation) {
            return { released: true, version_id: versionId };
          }
          if (action === "release") {
            migrated.ingest_reservations = migrated.ingest_reservations.filter(
              item => item.version_id !== versionId,
            );
            await transaction.put(key, migrated);
            return { released: true, version_id: versionId };
          }
          reservation.status = "cleanup_required";
          reservation.updated_at = timestamp;
          await transaction.put(key, migrated);
          return { reservation };
        });
        return internalJson(result);
      }
      if (
        request.method === "POST" &&
        segments.length === 3 &&
        segments[2] === "delete-plan"
      ) {
        const payload = await readJson(request);
        const actorId = requiredId(payload.actor_id, ACTOR_ID_PATTERN, "actor_id");
        const timestamp = currentTimestamp();
        const plan = await this.state.storage.transaction(async transaction => {
          const existing = await transaction.get(key);
          if (!existing) {
            const tombstone = await transaction.get(tombstoneKey);
            if (tombstone?.deleted === true) {
              return {
                deleted: true,
                case_id: tombstone.case_id,
                deletion_id: tombstone.deletion_id,
              };
            }
            throw new CaseStoreError(404, "case_not_found", "Case not found.");
          }
          const migrated = migrateCaseRecord(existing);
          if (!await verifyEventChain(migrated.events)) {
            throw new CaseStoreError(409, "invalid_event_chain", "Case event chain is invalid.");
          }
          if (migrated.status === "sealed") {
            throw new CaseStoreError(409, "case_sealed", "A sealed case cannot be deleted.");
          }
          if (migrated.ingest_reservations.some(reservation => reservation.status === "active")) {
            throw new CaseStoreError(
              409,
              "case_ingest_in_progress",
              "A media version is still being persisted; retry deletion after it settles.",
            );
          }
          if (!migrated.deletion) {
            migrated.deletion = {
              status: "pending",
              deletion_id: randomId("sg_delete"),
              requested_at: timestamp,
              requested_by: actorId,
              media_versions: mediaDeletionPlan(migrated),
            };
            await appendEvent(migrated, "case_deletion_requested", {
              deletion_id: migrated.deletion.deletion_id,
              media_versions: migrated.deletion.media_versions,
            }, actorId, timestamp);
            await transaction.put(key, migrated);
          }
          return {
            deletion_id: migrated.deletion.deletion_id,
            case_id: migrated.case_id,
            media_versions: migrated.deletion.media_versions,
          };
        });
        return internalJson(plan);
      }
      if (
        request.method === "POST" &&
        segments.length === 3 &&
        segments[2] === "delete-commit"
      ) {
        const payload = await readJson(request);
        const actorId = requiredId(payload.actor_id, ACTOR_ID_PATTERN, "actor_id");
        const deletionId = requiredId(
          payload.deletion_id,
          DELETION_ID_PATTERN,
          "deletion_id",
        );
        const timestamp = currentTimestamp();
        const result = await this.state.storage.transaction(async transaction => {
          const existing = await transaction.get(key);
          if (!existing) {
            const tombstone = await transaction.get(tombstoneKey);
            if (tombstone?.deletion_id === deletionId) {
              return tombstone;
            }
            if (tombstone) {
              throw new CaseStoreError(409, "deletion_conflict", "Deletion identifier does not match.");
            }
            throw new CaseStoreError(404, "case_not_found", "Case not found.");
          }
          const migrated = migrateCaseRecord(existing);
          if (!await verifyEventChain(migrated.events)) {
            throw new CaseStoreError(409, "invalid_event_chain", "Case event chain is invalid.");
          }
          if (migrated.deletion?.deletion_id !== deletionId) {
            throw new CaseStoreError(409, "deletion_conflict", "Deletion identifier does not match.");
          }
          const tombstone = {
            deleted: true,
            case_id: caseId,
            deletion_id: deletionId,
            deleted_at: timestamp,
            deleted_by: actorId,
          };
          await transaction.delete(key);
          await transaction.put(tombstoneKey, tombstone);
          return tombstone;
        });
        return internalJson({
          deleted: true,
          case_id: result.case_id,
          deletion_id: result.deletion_id,
        });
      }
      if (request.method === "DELETE" && segments.length === 2) {
        const record = await this.state.storage.get(key);
        if (!record) {
          throw new CaseStoreError(404, "case_not_found", "Case not found.");
        }
        throw new CaseStoreError(
          409,
          "deletion_protocol_required",
          "Case deletion requires the two-phase deletion protocol.",
        );
      }
      if (request.method === "POST" && segments.length === 3) {
        const commandType = {
          decision: "decision",
          annotations: "annotations",
          provenance: "provenance",
          feedback: "feedback",
          workflow: "workflow",
          comments: "comment",
          "review-grants": "review_grant",
          seal: "seal",
        }[segments[2]];
        if (!commandType) {
          throw new CaseStoreError(404, "not_found", "Route not found.");
        }
        const payload = await readJson(request);
        const actorId = requiredId(payload.actor_id, ACTOR_ID_PATTERN, "actor_id");
        const accessRole = payload.access_role === "reviewer" ? "reviewer" : "owner";
        const record = await this.state.storage.transaction(async transaction => {
          const existing = await transaction.get(key);
          if (!existing) {
            throw new CaseStoreError(404, "case_not_found", "Case not found.");
          }
          const next = await applyCaseCommand(existing, {
            type: commandType,
            payload,
          }, { actorId, accessRole });
          await transaction.put(key, next);
          return next;
        });
        return internalJson({ case: record });
      }
      if (
        request.method === "POST" &&
        segments.length === 5 &&
        segments[2] === "review-grants" &&
        segments[4] === "revoke"
      ) {
        const grantId = requiredId(segments[3], GRANT_ID_PATTERN, "grant_id");
        const payload = await readJson(request);
        const actorId = requiredId(payload.actor_id, ACTOR_ID_PATTERN, "actor_id");
        const record = await this.state.storage.transaction(async transaction => {
          const existing = await transaction.get(key);
          if (!existing) {
            throw new CaseStoreError(404, "case_not_found", "Case not found.");
          }
          const next = await applyCaseCommand(existing, {
            type: "revoke_review_grant",
            payload: { grant_id: grantId },
          }, { actorId });
          await transaction.put(key, next);
          return next;
        });
        return internalJson({ case: record });
      }
    }

    throw new CaseStoreError(404, "not_found", "Route not found.");
  }
}
