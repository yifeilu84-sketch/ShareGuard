import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCaseCommand,
  buildMetrics,
  canonicalJson,
  createCase,
  migrateCaseRecord,
  reviewGrantIsActive,
  ShareGuardCaseStore,
  sortCaseSummaries,
  verifyEventChain,
} from "../src/case-store.js";


const CASE_ID = `sg_case_${"a".repeat(32)}`;
const VERSION_ID = `sg_ver_${"b".repeat(32)}`;
const ACTOR_ID = `sg_actor_${"c".repeat(32)}`;
const REVIEWER_ID = `sg_actor_${"e".repeat(32)}`;
const GRANT_ID = `sg_grant_${"f".repeat(32)}`;


function analysis(overrides = {}) {
  return {
    request_id: "sg_req_test",
    media_sha256: "d".repeat(64),
    engine_release: "shareguard-screening-2026.08",
    detector_engine: "shareguard-protected-screening-engine",
    decision_layer: "shareguard-editorial-policy-v2",
    machine_recommendation: "review",
    decision_label: "需要人工复核",
    risk_level: "high",
    model_score: 0.91,
    score_kind: "uncalibrated_ai_generation_score",
    decision_margin: 0.82,
    latency_ms: 512,
    image: {
      width: 1600,
      height: 900,
      format: "JPEG",
    },
    report: { report_id: "SG-TEST" },
    ...overrides,
  };
}


function memoryStorage() {
  const values = new Map();
  const storage = {
    async get(key) {
      return values.get(key);
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      return values.delete(key);
    },
    async list(options = {}) {
      return new Map([...values].filter(([key]) => key.startsWith(options.prefix || "")));
    },
    async transaction(callback) {
      return callback(storage);
    },
  };
  return { storage, values };
}


function encryptedCustody(overrides = {}) {
  return {
    status: "encrypted_private",
    plaintext_sha256: "d".repeat(64),
    byte_size: 1024,
    content_type: "image/jpeg",
    file_name: "camera.jpg",
    stored_at: "2026-08-08T04:00:00.000Z",
    retention_until: "2026-08-15T04:00:00.000Z",
    encryption: {
      algorithm: "AES-256-GCM",
      key_version: "v1",
      iv: "AQIDBAUGBwgJCgsM",
    },
    ...overrides,
  };
}


test("canonical JSON is stable across object key order", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [3, 2, 1] }),
    canonicalJson({ list: [3, 2, 1], a: { x: 3, y: 2 }, z: 1 }),
  );
});


test("a case starts with a hash-linked creation and analysis trail", async () => {
  const record = await createCase(analysis(), {
    caseId: CASE_ID,
    versionId: VERSION_ID,
    versionRole: "original",
    title: "Desk photo",
    actorId: ACTOR_ID,
    now: "2026-08-08T04:00:00.000Z",
  });

  assert.equal(record.case_id, CASE_ID);
  assert.equal(record.versions.length, 1);
  assert.equal(record.versions[0].version_id, VERSION_ID);
  assert.equal(record.versions[0].media_sha256, "d".repeat(64));
  assert.equal(record.events.length, 2);
  assert.equal(record.events[0].sequence, 1);
  assert.equal(record.events[0].previous_hash, "0".repeat(64));
  assert.equal(record.events[1].previous_hash, record.events[0].event_hash);
  assert.equal(record.status, "awaiting_review");
  assert.equal(record.workflow.priority, "high");
  assert.equal(record.workflow.tasks.length, 1);
  assert.equal(record.workflow.tasks[0].type, "review_media");
  assert.equal(record.workflow.tasks[0].status, "open");
  assert.equal(record.provenance_graph.nodes[0].kind, "media_version");
  assert.equal(record.provenance_graph.nodes[0].version_id, VERSION_ID);
  assert.equal(await verifyEventChain(record.events), true);
});


test("legacy open cases migrate to a deterministic triage workflow", async () => {
  const legacy = await createCase(analysis(), {
    caseId: CASE_ID,
    versionId: VERSION_ID,
    actorId: ACTOR_ID,
    now: "2026-08-08T04:00:00.000Z",
  });
  legacy.schema = "shareguard.case.v2";
  legacy.status = "open";
  delete legacy.workflow;
  delete legacy.comments;
  delete legacy.review_grants;
  delete legacy.provenance_graph;

  const migrated = migrateCaseRecord(legacy);

  assert.equal(migrated.schema, "shareguard.case.v3");
  assert.equal(migrated.status, "awaiting_review");
  assert.equal(migrated.workflow.priority, "high");
  assert.equal(migrated.workflow.tasks[0].type, "review_media");
  assert.equal(migrated.provenance_graph.nodes[0].media_sha256, "d".repeat(64));
  assert.deepEqual(migrated.comments, []);
  assert.deepEqual(migrated.review_grants, []);
  assert.equal(await verifyEventChain(migrated.events), true);
});


test("a reasoned human decision is server-attributed and append only", async () => {
  const initial = await createCase(analysis(), {
    caseId: CASE_ID,
    versionId: VERSION_ID,
    versionRole: "original",
    actorId: ACTOR_ID,
    now: "2026-08-08T04:00:00.000Z",
  });
  const decided = await applyCaseCommand(initial, {
    type: "decision",
    payload: {
      action: "hold",
      reason_code: "source_unverified",
      note: "Awaiting the camera original.",
    },
  }, {
    actorId: ACTOR_ID,
    now: "2026-08-08T04:01:00.000Z",
  });

  assert.deepEqual(decided.human_decision, {
    action: "hold",
    reason_code: "source_unverified",
    note: "Awaiting the camera original.",
    actor_id: ACTOR_ID,
    recorded_at: "2026-08-08T04:01:00.000Z",
  });
  assert.equal(initial.human_decision, null);
  assert.equal(decided.events.length, 3);
  assert.equal(decided.status, "held");
  assert.equal(
    decided.workflow.tasks.find(item => item.type === "review_media").status,
    "completed",
  );
  assert.equal(
    decided.workflow.tasks.find(item => item.type === "hold_resolution").status,
    "open",
  );
  assert.equal(await verifyEventChain(decided.events), true);

  await assert.rejects(
    applyCaseCommand(initial, {
      type: "decision",
      payload: { action: "hold", reason_code: "" },
    }, { actorId: ACTOR_ID }),
    /reason_code/,
  );
});


test("workflow commands assign cases, change priority, and preserve an audit trail", async () => {
  const initial = await createCase(analysis({ risk_level: "medium" }), {
    caseId: CASE_ID,
    versionId: VERSION_ID,
    actorId: ACTOR_ID,
    now: "2026-08-08T04:00:00.000Z",
  });
  const updated = await applyCaseCommand(initial, {
    type: "workflow",
    payload: {
      priority: "urgent",
      assignee: "Night editor",
    },
  }, {
    actorId: ACTOR_ID,
    now: "2026-08-08T04:10:00.000Z",
  });

  assert.equal(updated.workflow.priority, "urgent");
  assert.equal(updated.workflow.assignee, "Night editor");
  assert.equal(updated.workflow.sla_due_at, "2026-08-08T04:25:00.000Z");
  assert.equal(updated.events.at(-1).event_type, "workflow_updated");
  assert.equal(await verifyEventChain(updated.events), true);
});


test("triage summaries place urgent and overdue cases first", () => {
  const records = [
    { case_id: "normal", status: "awaiting_review", updated_at: "2026-08-08T04:20:00Z", workflow: { priority: "normal", sla_due_at: "2026-08-08T10:00:00Z" } },
    { case_id: "sealed", status: "sealed", updated_at: "2026-08-08T04:30:00Z", workflow: { priority: "urgent", sla_due_at: "2026-08-08T04:00:00Z" } },
    { case_id: "urgent", status: "awaiting_review", updated_at: "2026-08-08T04:00:00Z", workflow: { priority: "urgent", sla_due_at: "2026-08-08T05:00:00Z" } },
    { case_id: "overdue", status: "awaiting_source", updated_at: "2026-08-08T03:00:00Z", workflow: { priority: "high", sla_due_at: "2026-08-08T03:30:00Z" } },
  ];

  const ordered = sortCaseSummaries(records, "2026-08-08T04:30:00.000Z");

  assert.deepEqual(ordered.map(item => item.case_id), ["overdue", "urgent", "normal", "sealed"]);
});


test("reviewer annotations are normalized and cannot masquerade as model output", async () => {
  const initial = await createCase(analysis(), {
    caseId: CASE_ID,
    versionId: VERSION_ID,
    versionRole: "original",
    actorId: ACTOR_ID,
  });
  const annotated = await applyCaseCommand(initial, {
    type: "annotations",
    payload: {
      version_id: VERSION_ID,
      annotations: [{
        annotation_id: "ann-1",
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.25,
        note: "Repeated edge pattern",
      }],
    },
  }, { actorId: ACTOR_ID });

  assert.equal(annotated.annotations[VERSION_ID][0].origin, "human_reviewer");
  assert.equal(annotated.annotations[VERSION_ID][0].actor_id, ACTOR_ID);
  assert.equal(await verifyEventChain(annotated.events), true);

  await assert.rejects(
    applyCaseCommand(initial, {
      type: "annotations",
      payload: {
        version_id: VERSION_ID,
        annotations: [{
          annotation_id: "bad",
          x: 0.9,
          y: 0.2,
          width: 0.3,
          height: 0.2,
          note: "outside",
        }],
      },
    }, { actorId: ACTOR_ID }),
    /bounds/,
  );
});


test("provenance creates explicit graph nodes and never upgrades an unsupported claim", async () => {
  const initial = await createCase(analysis(), {
    caseId: CASE_ID,
    versionId: VERSION_ID,
    actorId: ACTOR_ID,
    now: "2026-08-08T04:00:00.000Z",
  });
  const declared = await applyCaseCommand(initial, {
    type: "provenance",
    payload: {
      version_id: VERSION_ID,
      relationship: "received_from",
      channel: "Reporter camera card",
      source_url: "https://example.test/source",
      captured_at: "2026-08-08T03:30:00.000Z",
      note: "Declared during intake.",
      verification_status: "verified",
    },
  }, { actorId: ACTOR_ID, now: "2026-08-08T04:02:00.000Z" });

  assert.equal(declared.provenance_graph.nodes.length, 2);
  assert.equal(declared.provenance_graph.edges.length, 1);
  assert.equal(declared.provenance_graph.edges[0].relationship, "received_from");
  assert.equal(declared.provenance_graph.edges[0].verification_status, "declared_unverified");
  assert.equal(declared.provenance_graph.edges[0].target_version_id, VERSION_ID);
  assert.equal(await verifyEventChain(declared.events), true);
});


test("comments are attributed and appended to the evidence chain", async () => {
  const initial = await createCase(analysis(), {
    caseId: CASE_ID,
    versionId: VERSION_ID,
    actorId: ACTOR_ID,
  });
  const commented = await applyCaseCommand(initial, {
    type: "comment",
    payload: { body: "Please obtain the camera original." },
  }, { actorId: ACTOR_ID, now: "2026-08-08T04:03:00.000Z" });

  assert.equal(commented.comments.length, 1);
  assert.equal(commented.comments[0].body, "Please obtain the camera original.");
  assert.equal(commented.comments[0].actor_id, ACTOR_ID);
  assert.equal(commented.events.at(-1).event_type, "comment_added");
});


test("scoped review grants expire, revoke, and restrict reviewer commands", async () => {
  const initial = await createCase(analysis(), {
    caseId: CASE_ID,
    versionId: VERSION_ID,
    actorId: ACTOR_ID,
    now: "2026-08-08T04:00:00.000Z",
  });
  const granted = await applyCaseCommand(initial, {
    type: "review_grant",
    payload: {
      grant_id: GRANT_ID,
      reviewer_actor_id: REVIEWER_ID,
      reviewer_name: "External counsel",
      role: "reviewer",
      issued_at: "2026-08-08T04:01:00.000Z",
      expires_at: "2026-08-08T05:01:00.000Z",
    },
  }, { actorId: ACTOR_ID, now: "2026-08-08T04:01:00.000Z" });

  assert.equal(granted.review_grants.length, 1);
  assert.equal(reviewGrantIsActive(granted, {
    grant_id: GRANT_ID,
    reviewer_actor_id: REVIEWER_ID,
    case_id: CASE_ID,
  }, "2026-08-08T04:30:00.000Z"), true);
  assert.equal(reviewGrantIsActive(granted, {
    grant_id: GRANT_ID,
    reviewer_actor_id: REVIEWER_ID,
    case_id: CASE_ID,
  }, "2026-08-08T05:01:01.000Z"), false);

  const commented = await applyCaseCommand(granted, {
    type: "comment",
    payload: { body: "Independent review completed." },
  }, { actorId: REVIEWER_ID, accessRole: "reviewer" });
  assert.equal(commented.comments.at(-1).actor_id, REVIEWER_ID);
  await assert.rejects(
    applyCaseCommand(granted, {
      type: "workflow",
      payload: { priority: "low" },
    }, { actorId: REVIEWER_ID, accessRole: "reviewer" }),
    /permission/i,
  );

  const revoked = await applyCaseCommand(commented, {
    type: "revoke_review_grant",
    payload: { grant_id: GRANT_ID },
  }, { actorId: ACTOR_ID, now: "2026-08-08T04:40:00.000Z" });
  assert.equal(revoked.review_grants[0].revoked_at, "2026-08-08T04:40:00.000Z");
  assert.equal(reviewGrantIsActive(revoked, {
    grant_id: GRANT_ID,
    reviewer_actor_id: REVIEWER_ID,
    case_id: CASE_ID,
  }, "2026-08-08T04:41:00.000Z"), false);
});


test("sealing freezes the case projection", async () => {
  const initial = await createCase(analysis(), {
    caseId: CASE_ID,
    versionId: VERSION_ID,
    versionRole: "original",
    actorId: ACTOR_ID,
  });
  const decided = await applyCaseCommand(initial, {
    type: "decision",
    payload: { action: "allow", reason_code: "source_verified" },
  }, { actorId: ACTOR_ID });
  const sealed = await applyCaseCommand(decided, {
    type: "seal",
    payload: { key_id: "sg-signing-2026-01" },
  }, {
    actorId: ACTOR_ID,
    now: "2026-08-08T04:02:00.000Z",
  });

  assert.equal(sealed.status, "sealed");
  assert.equal(sealed.sealed_at, "2026-08-08T04:02:00.000Z");
  assert.equal(await verifyEventChain(sealed.events), true);

  const resealed = await applyCaseCommand(sealed, {
    type: "seal",
    payload: { key_id: "sg-signing-2026-01" },
  }, { actorId: ACTOR_ID });
  assert.deepEqual(resealed, sealed);

  await assert.rejects(
    applyCaseCommand(sealed, {
      type: "provenance",
      payload: { channel: "newsroom" },
    }, { actorId: ACTOR_ID }),
    /sealed/,
  );
});


test("two-phase deletion freezes a case and retries with one stable plan", async () => {
  const { storage } = memoryStorage();
  const record = await createCase(analysis(), {
    caseId: CASE_ID,
    versionId: VERSION_ID,
    versionRole: "original",
    fileName: "camera.jpg",
    mediaCustody: encryptedCustody(),
    actorId: ACTOR_ID,
    now: "2026-08-08T04:00:00.000Z",
  });
  await storage.put(`case:${CASE_ID}`, record);
  const object = new ShareGuardCaseStore({ storage }, {});
  const post = (path, payload) => object.fetch(new Request(
    `https://shareguard-case-store.internal${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, actor_id: ACTOR_ID }),
    },
  ));

  const firstPlanResponse = await post(`/cases/${CASE_ID}/delete-plan`, {});
  assert.equal(firstPlanResponse.status, 200);
  const firstPlan = await firstPlanResponse.json();
  assert.match(firstPlan.deletion_id, /^sg_delete_[0-9a-f]{32}$/);
  assert.deepEqual(firstPlan.media_versions, [{
    version_id: VERSION_ID,
    custody_status: "encrypted_private",
  }]);

  const retryPlan = await (await post(`/cases/${CASE_ID}/delete-plan`, {})).json();
  assert.equal(retryPlan.deletion_id, firstPlan.deletion_id);
  const pending = await storage.get(`case:${CASE_ID}`);
  assert.equal(pending.deletion.status, "pending");
  assert.equal(pending.events.at(-1).event_type, "case_deletion_requested");
  assert.equal(
    pending.events.filter(event => event.event_type === "case_deletion_requested").length,
    1,
  );
  assert.equal(await verifyEventChain(pending.events), true);
  const projectionMissing = structuredClone(pending);
  delete projectionMissing.deletion;
  const recoveredProjection = migrateCaseRecord(projectionMissing);
  assert.equal(recoveredProjection.deletion.status, "pending");
  assert.equal(recoveredProjection.deletion.deletion_id, firstPlan.deletion_id);
  await assert.rejects(
    applyCaseCommand(recoveredProjection, {
      type: "workflow",
      payload: { priority: "low" },
    }, { actorId: ACTOR_ID }),
    error => error.code === "case_deletion_pending",
  );

  const workflowResponse = await post(`/cases/${CASE_ID}/workflow`, { priority: "low" });
  assert.equal(workflowResponse.status, 409);
  assert.equal((await workflowResponse.json()).error.code, "case_deletion_pending");
  const ingestResponse = await post("/ingest", {
    case_id: CASE_ID,
    version_id: `sg_ver_${"1".repeat(32)}`,
    version_role: "observed_variant",
    file_name: "variant.jpg",
    media_custody: encryptedCustody({
      file_name: "variant.jpg",
      plaintext_sha256: "e".repeat(64),
    }),
    analysis: analysis({ media_sha256: "e".repeat(64) }),
  });
  assert.equal(ingestResponse.status, 409);
  assert.equal((await ingestResponse.json()).error.code, "case_deletion_pending");

  const directDelete = await object.fetch(new Request(
    `https://shareguard-case-store.internal/cases/${CASE_ID}`,
    { method: "DELETE" },
  ));
  assert.equal(directDelete.status, 409);
  assert.equal((await directDelete.json()).error.code, "deletion_protocol_required");

  const conflict = await post(`/cases/${CASE_ID}/delete-commit`, {
    deletion_id: `sg_delete_${"f".repeat(32)}`,
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "deletion_conflict");
  assert.ok(await storage.get(`case:${CASE_ID}`));

  const committed = await post(`/cases/${CASE_ID}/delete-commit`, {
    deletion_id: firstPlan.deletion_id,
  });
  assert.equal(committed.status, 200);
  assert.deepEqual(await committed.json(), {
    deleted: true,
    case_id: CASE_ID,
    deletion_id: firstPlan.deletion_id,
  });
  assert.equal(await storage.get(`case:${CASE_ID}`), undefined);

  const committedAgain = await post(`/cases/${CASE_ID}/delete-commit`, {
    deletion_id: firstPlan.deletion_id,
  });
  assert.equal(committedAgain.status, 200);
  assert.equal((await committedAgain.json()).deleted, true);
  const planAfterCommit = await post(`/cases/${CASE_ID}/delete-plan`, {});
  assert.equal(planAfterCommit.status, 200);
  assert.deepEqual(await planAfterCommit.json(), {
    deleted: true,
    case_id: CASE_ID,
    deletion_id: firstPlan.deletion_id,
  });
});


test("an active media ingest reservation blocks deletion and failed cleanup joins the plan", async () => {
  const { storage } = memoryStorage();
  const created = await createCase(analysis(), {
    caseId: CASE_ID,
    versionId: VERSION_ID,
    actorId: ACTOR_ID,
    now: "2026-08-08T04:00:00.000Z",
  });
  const record = await applyCaseCommand(created, {
    type: "decision",
    payload: { action: "allow", reason_code: "source_verified" },
  }, { actorId: ACTOR_ID, now: "2026-08-08T04:00:30.000Z" });
  await storage.put(`case:${CASE_ID}`, record);
  const object = new ShareGuardCaseStore({ storage }, {});
  const reservedVersionId = `sg_ver_${"1".repeat(32)}`;
  const post = (path, payload = {}) => object.fetch(new Request(
    `https://shareguard-case-store.internal${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, actor_id: ACTOR_ID }),
    },
  ));

  const reserved = await post(`/cases/${CASE_ID}/ingest-reservations`, {
    version_id: reservedVersionId,
  });
  assert.equal(reserved.status, 201);
  assert.equal((await reserved.json()).reservation.status, "active");

  const activeSeal = await post(`/cases/${CASE_ID}/seal`, { key_id: "sg-signing-test" });
  assert.equal(activeSeal.status, 409);
  assert.equal((await activeSeal.json()).error.code, "case_ingest_in_progress");

  const busyPlan = await post(`/cases/${CASE_ID}/delete-plan`);
  assert.equal(busyPlan.status, 409);
  assert.equal((await busyPlan.json()).error.code, "case_ingest_in_progress");
  assert.equal((await storage.get(`case:${CASE_ID}`)).deletion, null);

  const abandoned = await post(
    `/cases/${CASE_ID}/ingest-reservations/${reservedVersionId}/abandon`,
  );
  assert.equal(abandoned.status, 200);
  assert.equal((await abandoned.json()).reservation.status, "cleanup_required");

  const dirtySeal = await post(`/cases/${CASE_ID}/seal`, { key_id: "sg-signing-test" });
  assert.equal(dirtySeal.status, 409);
  assert.equal((await dirtySeal.json()).error.code, "media_cleanup_required");

  const plan = await (await post(`/cases/${CASE_ID}/delete-plan`)).json();
  assert.deepEqual(plan.media_versions, [
    { version_id: VERSION_ID, custody_status: "detached_digest_only" },
    { version_id: reservedVersionId, custody_status: "encrypted_private" },
  ]);
  assert.equal((await storage.get(`case:${CASE_ID}`)).deletion.status, "pending");
});


test("abandoning an ingest after a lost commit response reports the committed version", async () => {
  const { storage } = memoryStorage();
  const created = await createCase(analysis(), {
    caseId: CASE_ID,
    versionId: VERSION_ID,
    actorId: ACTOR_ID,
    now: "2026-08-08T06:00:00.000Z",
  });
  await storage.put(`case:${CASE_ID}`, created);
  const object = new ShareGuardCaseStore({ storage }, {});
  const committedVersionId = `sg_ver_${"2".repeat(32)}`;
  const post = (path, payload = {}) => object.fetch(new Request(
    `https://shareguard-case-store.internal${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, actor_id: ACTOR_ID }),
    },
  ));

  assert.equal((await post(`/cases/${CASE_ID}/ingest-reservations`, {
    version_id: committedVersionId,
  })).status, 201);
  const committed = await post("/ingest", {
    case_id: CASE_ID,
    version_id: committedVersionId,
    reservation_id: committedVersionId,
    version_role: "observed_variant",
    file_name: "observed.jpg",
    analysis: analysis({ media_sha256: "9".repeat(64) }),
  });
  assert.equal(committed.status, 200);

  const reconciled = await post(
    `/cases/${CASE_ID}/ingest-reservations/${committedVersionId}/abandon`,
  );
  assert.equal(reconciled.status, 200);
  const payload = await reconciled.json();
  assert.equal(payload.committed, true);
  assert.equal(payload.version_id, committedVersionId);
  assert.equal(payload.case.versions.at(-1).version_id, committedVersionId);
});


test("metrics use persisted cases and label small samples honestly", async () => {
  const first = await createCase(analysis({ model_score: 0.91, latency_ms: 500 }), {
    caseId: CASE_ID,
    versionId: VERSION_ID,
    versionRole: "original",
    actorId: ACTOR_ID,
  });
  const decided = await applyCaseCommand(first, {
    type: "decision",
    payload: { action: "allow", reason_code: "source_verified" },
  }, { actorId: ACTOR_ID });

  const metrics = buildMetrics([decided]);

  assert.equal(metrics.case_count, 1);
  assert.equal(metrics.version_count, 1);
  assert.equal(metrics.machine_recommendations.review, 1);
  assert.equal(metrics.human_decisions.allow, 1);
  assert.equal(metrics.override_count, 1);
  assert.equal(metrics.latency.mean_ms, 500);
  assert.equal(metrics.distribution_shift.status, "insufficient_data");
});
