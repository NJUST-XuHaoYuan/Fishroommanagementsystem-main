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
