import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCaseCommand,
  buildMetrics,
  canonicalJson,
  createCase,
  migrateCaseRecord,
  sortCaseSummaries,
  verifyEventChain,
} from "../src/case-store.js";


const CASE_ID = `sg_case_${"a".repeat(32)}`;
const VERSION_ID = `sg_ver_${"b".repeat(32)}`;
const ACTOR_ID = `sg_actor_${"c".repeat(32)}`;


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
