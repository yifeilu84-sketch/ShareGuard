import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCaseCommand,
  buildMetrics,
  canonicalJson,
  createCase,
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
  assert.equal(await verifyEventChain(record.events), true);
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
  assert.equal(await verifyEventChain(decided.events), true);

  await assert.rejects(
    applyCaseCommand(initial, {
      type: "decision",
      payload: { action: "hold", reason_code: "" },
    }, { actorId: ACTOR_ID }),
    /reason_code/,
  );
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
