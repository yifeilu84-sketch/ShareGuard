import assert from "node:assert/strict";
import test from "node:test";

import {
  issueReviewToken,
  verifyReviewToken,
} from "../src/review-access.js";


const OWNER_ID = `sg_actor_${"a".repeat(32)}`;
const CASE_ID = `sg_case_${"b".repeat(32)}`;
const ENV = { REVIEW_TOKEN_SECRET: "review-secret-with-at-least-thirty-two-bytes" };


test("review tokens are case scoped, expiring, and do not expose their secret", async () => {
  const issued = await issueReviewToken(ENV, {
    ownerId: OWNER_ID,
    caseId: CASE_ID,
    reviewerName: "External counsel",
    expiresInSeconds: 3600,
    now: "2026-08-08T04:00:00.000Z",
  });

  assert.match(issued.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(issued.token.includes(ENV.REVIEW_TOKEN_SECRET), false);
  assert.match(issued.grant.grant_id, /^sg_grant_[0-9a-f]{32}$/);
  assert.match(issued.grant.reviewer_actor_id, /^sg_actor_[0-9a-f]{32}$/);
  assert.equal(issued.grant.expires_at, "2026-08-08T05:00:00.000Z");

  const verified = await verifyReviewToken(ENV, issued.token, {
    now: "2026-08-08T04:30:00.000Z",
  });
  assert.equal(verified.owner_id, OWNER_ID);
  assert.equal(verified.case_id, CASE_ID);
  assert.equal(verified.grant_id, issued.grant.grant_id);
  assert.equal(verified.role, "reviewer");

  await assert.rejects(
    verifyReviewToken(ENV, issued.token, { now: "2026-08-08T05:00:01.000Z" }),
    /expired/i,
  );
});


test("review token tampering and unsafe expiry requests fail closed", async () => {
  await assert.rejects(
    issueReviewToken(ENV, {
      ownerId: OWNER_ID,
      caseId: CASE_ID,
      reviewerName: "Reviewer",
      expiresInSeconds: 60 * 60 * 24 * 31,
    }),
    /expiry/i,
  );
  const issued = await issueReviewToken(ENV, {
    ownerId: OWNER_ID,
    caseId: CASE_ID,
    reviewerName: "Reviewer",
    expiresInSeconds: 600,
  });
  const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith("a") ? "b" : "a"}`;
  await assert.rejects(verifyReviewToken(ENV, tampered), /signature|token/i);
  await assert.rejects(verifyReviewToken({}, issued.token), /configuration/i);
});
