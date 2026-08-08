const CASE_ID_PATTERN = /^sg_case_[0-9a-f]{32}$/;
const VERSION_ID_PATTERN = /^sg_ver_[0-9a-f]{32}$/;
const ACTOR_ID_PATTERN = /^sg_actor_[0-9a-f]{32}$/;
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
  return {
    version_id: versionId,
    role,
    file_name: boundedText(
      context.fileName || sanitized.report?.subject?.file_name || "upload",
      "file_name",
      255,
      { required: true },
    ),
    received_at: timestamp,
    ...sanitized,
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
    schema: "shareguard.case.v2",
    case_id: caseId,
    title: boundedText(context.title || version.file_name, "title", 160, { required: true }),
    status: "open",
    created_at: timestamp,
    updated_at: timestamp,
    sealed_at: null,
    versions: [version],
    declared_provenance: null,
    annotations: {},
    human_decision: null,
    feedback: null,
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


function normalizeAnnotation(annotation, index) {
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
  };
}


export async function applyCaseCommand(record, command, context = {}) {
  if (!record || typeof record !== "object") {
    throw new CaseStoreError(404, "case_not_found", "Case not found.");
  }
  if (!await verifyEventChain(record.events)) {
    throw new CaseStoreError(409, "invalid_event_chain", "Case event chain is invalid.");
  }
  const type = String(command?.type || "");
  const payload = command?.payload || {};
  if (record.status === "sealed") {
    const activeKeyId = record.events?.at(-1)?.payload?.key_id;
    if (type === "seal" && payload.key_id === activeKeyId) {
      return clone(record);
    }
    throw new CaseStoreError(409, "case_sealed", "Case is sealed and cannot be changed.");
  }
  const actorId = requiredId(context.actorId, ACTOR_ID_PATTERN, "actor_id");
  const timestamp = currentTimestamp(context.now);
  const next = clone(record);

  if (type === "add_version") {
    const version = versionFromAnalysis(payload.analysis, {
      versionId: payload.version_id,
      versionRole: payload.version_role,
      fileName: payload.file_name,
    }, timestamp);
    if (next.versions.some(item => item.media_sha256 === version.media_sha256)) {
      throw new CaseStoreError(
        409,
        "duplicate_version",
        "This media digest already exists in the case.",
      );
    }
    next.versions.push(version);
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
    const annotations = payload.annotations.map(normalizeAnnotation);
    next.annotations[versionId] = annotations;
    await appendEvent(next, "annotations_replaced", {
      version_id: versionId,
      annotations,
    }, actorId, timestamp);
    return next;
  }

  if (type === "provenance") {
    const channel = boundedText(payload.channel, "channel", 120, { required: true });
    const capturedAt = boundedText(payload.captured_at, "captured_at", 64);
    if (capturedAt && Number.isNaN(Date.parse(capturedAt))) {
      throw new CaseStoreError(400, "invalid_field", "captured_at is invalid.");
    }
    next.declared_provenance = {
      status: "declared_unverified",
      channel,
      source_url: safeUrl(payload.source_url),
      captured_at: capturedAt ? new Date(capturedAt).toISOString() : "",
      note: boundedText(payload.note, "note", 1000),
      actor_id: actorId,
      recorded_at: timestamp,
    };
    await appendEvent(
      next,
      "provenance_declared",
      next.declared_provenance,
      actorId,
      timestamp,
    );
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
  const latest = record.versions?.at(-1) || {};
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
    chain_head: record.chain_head,
  };
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
          const next = await applyCaseCommand(existing, {
            type: "add_version",
            payload: {
              analysis: payload.analysis,
              version_id: payload.version_id,
              version_role: payload.version_role,
              file_name: payload.file_name,
            },
          }, { actorId });
          await transaction.put(key, next);
          return next;
        }
        const created = await createCase(payload.analysis, {
          caseId: payload.new_case_id,
          versionId: payload.version_id,
          versionRole: payload.version_role,
          fileName: payload.file_name,
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
      const cases = [...stored.values()]
        .map(caseSummary)
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
      return internalJson({ cases });
    }

    if (request.method === "GET" && url.pathname === "/metrics") {
      const stored = await this.state.storage.list({ prefix: "case:" });
      return internalJson({ metrics: buildMetrics([...stored.values()]) });
    }

    if (segments[0] === "cases" && segments.length >= 2) {
      const caseId = requiredId(segments[1], CASE_ID_PATTERN, "case_id");
      const key = `case:${caseId}`;
      if (request.method === "GET" && segments.length === 2) {
        const record = await this.state.storage.get(key);
        if (!record) {
          throw new CaseStoreError(404, "case_not_found", "Case not found.");
        }
        return internalJson({ case: record });
      }
      if (request.method === "DELETE" && segments.length === 2) {
        const record = await this.state.storage.get(key);
        if (!record) {
          throw new CaseStoreError(404, "case_not_found", "Case not found.");
        }
        if (record.status === "sealed") {
          throw new CaseStoreError(409, "case_sealed", "A sealed case cannot be deleted.");
        }
        await this.state.storage.delete(key);
        return internalJson({ deleted: true, case_id: caseId });
      }
      if (request.method === "POST" && segments.length === 3) {
        const commandType = {
          decision: "decision",
          annotations: "annotations",
          provenance: "provenance",
          feedback: "feedback",
          seal: "seal",
        }[segments[2]];
        if (!commandType) {
          throw new CaseStoreError(404, "not_found", "Route not found.");
        }
        const payload = await readJson(request);
        const actorId = requiredId(payload.actor_id, ACTOR_ID_PATTERN, "actor_id");
        const record = await this.state.storage.transaction(async transaction => {
          const existing = await transaction.get(key);
          if (!existing) {
            throw new CaseStoreError(404, "case_not_found", "Case not found.");
          }
          const next = await applyCaseCommand(existing, {
            type: commandType,
            payload,
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
