function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

export function createConcurrencyLimiter({
  concurrency = 1,
  maxPending = 2,
  queueFullMessage = "系统繁忙，请稍后重试",
} = {}) {
  const limit = positiveInteger(concurrency, 1);
  const pendingLimit = positiveInteger(maxPending, 2, 0);
  const queue = [];
  let active = 0;

  function releaseFactory() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      drain();
    };
  }

  function drain() {
    while (active < limit && queue.length > 0) {
      const resolve = queue.shift();
      active += 1;
      resolve(releaseFactory());
    }
  }

  function acquire() {
    if (active < limit) {
      active += 1;
      return Promise.resolve(releaseFactory());
    }
    if (queue.length >= pendingLimit) {
      const error = new Error(queueFullMessage);
      error.statusCode = 503;
      return Promise.reject(error);
    }
    return new Promise((resolve) => {
      queue.push(resolve);
    });
  }

  return {
    acquire,
    status: () => ({ active, pending: queue.length, concurrency: limit, maxPending: pendingLimit }),
  };
}
