import assert from "node:assert/strict";
import test from "node:test";
import { createConcurrencyLimiter } from "./concurrency-limiter.mjs";

test("serializes work and rejects requests beyond the pending limit", async () => {
  const limiter = createConcurrencyLimiter({
    concurrency: 1,
    maxPending: 2,
    queueFullMessage: "视频处理中",
  });

  const releaseFirst = await limiter.acquire();
  const second = limiter.acquire();
  const third = limiter.acquire();
  await assert.rejects(limiter.acquire(), (error) => {
    assert.equal(error.statusCode, 503);
    assert.match(error.message, /视频处理中/);
    return true;
  });
  assert.deepEqual(limiter.status(), { active: 1, pending: 2, concurrency: 1, maxPending: 2 });

  releaseFirst();
  const releaseSecond = await second;
  assert.deepEqual(limiter.status(), { active: 1, pending: 1, concurrency: 1, maxPending: 2 });

  releaseSecond();
  const releaseThird = await third;
  releaseThird();
  assert.deepEqual(limiter.status(), { active: 0, pending: 0, concurrency: 1, maxPending: 2 });
});

test("release is idempotent", async () => {
  const limiter = createConcurrencyLimiter({ concurrency: 1, maxPending: 0 });
  const release = await limiter.acquire();
  release();
  release();
  assert.deepEqual(limiter.status(), { active: 0, pending: 0, concurrency: 1, maxPending: 0 });
});

test("a queued request can be cancelled without consuming a future slot", async () => {
  const limiter = createConcurrencyLimiter({ concurrency: 1, maxPending: 2 });
  const releaseFirst = await limiter.acquire();
  const controller = new AbortController();
  const queued = limiter.acquire({ signal: controller.signal });
  assert.equal(limiter.status().pending, 1);
  controller.abort();
  await assert.rejects(queued, (error) => error?.name === "AbortError");
  assert.equal(limiter.status().pending, 0);
  releaseFirst();
  const releaseNext = await limiter.acquire();
  releaseNext();
  assert.equal(limiter.status().active, 0);
});

test("disconnecting an active request releases its slot for the next request", async () => {
  const limiter = createConcurrencyLimiter({ concurrency: 1, maxPending: 1 });
  const controller = new AbortController();
  let expirationReason = "";
  const releaseFirst = await limiter.acquire({
    signal: controller.signal,
    onLeaseExpired: (reason) => {
      expirationReason = reason;
    },
  });
  const queued = limiter.acquire();

  controller.abort();
  const releaseNext = await queued;
  assert.equal(expirationReason, "aborted");
  assert.deepEqual(limiter.status(), { active: 1, pending: 0, concurrency: 1, maxPending: 1 });

  releaseFirst();
  releaseNext();
  assert.equal(limiter.status().active, 0);
});

test("a never-finishing active operation times out and cannot strand the limiter", async () => {
  const limiter = createConcurrencyLimiter({ concurrency: 1, maxPending: 1 });
  let expirationReason = "";
  await limiter.acquire({
    leaseTimeoutMs: 10,
    onLeaseExpired: (reason) => {
      expirationReason = reason;
    },
  });
  const queued = limiter.acquire();

  const releaseNext = await queued;
  assert.equal(expirationReason, "timeout");
  assert.deepEqual(limiter.status(), { active: 1, pending: 0, concurrency: 1, maxPending: 1 });

  releaseNext();
  assert.equal(limiter.status().active, 0);
});
