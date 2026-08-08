# R2 Free-Tier Hard Limit Implementation Plan

1. Add failing tests for a singleton storage-quota Durable Object and its
   observable HTTP contract.
2. Implement the quota ledger with transactional reserve and release routes.
3. Bind and migrate the Durable Object, then make readiness fail closed when
   the binding or limits are absent.
4. Reserve quota before each encrypted R2 write and release it only after
   confirmed cleanup or case deletion.
5. Add integration tests for rejection and failure-safe cleanup behavior.
6. Run all Worker and Python tests plus a Wrangler deployment dry-run.
7. After the user enables R2, create the private bucket, configure seven-day
   expiration, install secrets, deploy the Worker, fast-forward `main`, and
   verify the live workflow.
