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

  function releaseFactory(options = {}) {
    let released = false;
    const signal = options?.signal;
    const leaseTimeoutMs = positiveInteger(options?.leaseTimeoutMs, 0, 0);
    const onLeaseExpired = typeof options?.onLeaseExpired === "function"
      ? options.onLeaseExpired
      : null;
    let leaseTimer = null;

    const release = (reason = "released") => {
      if (released) return;
      released = true;
      if (leaseTimer) clearTimeout(leaseTimer);
      signal?.removeEventListener("abort", onAbort);
      active = Math.max(0, active - 1);
      drain();
      if (reason !== "released" && onLeaseExpired) {
        try {
          onLeaseExpired(reason);
        } catch {
          // A cleanup callback must never strand the limiter slot.
        }
      }
    };
    const onAbort = () => release("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (leaseTimeoutMs > 0) {
      leaseTimer = setTimeout(() => release("timeout"), leaseTimeoutMs);
      leaseTimer.unref?.();
    }
    if (signal?.aborted) onAbort();
    return release;
  }

  function drain() {
    while (active < limit && queue.length > 0) {
      const entry = queue.shift();
      entry.signal?.removeEventListener("abort", entry.onAbort);
      if (entry.signal?.aborted) {
        entry.reject(entry.abortError());
        continue;
      }
      active += 1;
      entry.resolve(releaseFactory(entry.options));
    }
  }

  function acquire(options = {}) {
    const signal = options?.signal;
    const abortError = () => {
      const error = new Error("请求已取消");
      error.name = "AbortError";
      error.code = "ABORT_ERR";
      return error;
    };
    if (signal?.aborted) return Promise.reject(abortError());
    if (active < limit) {
      active += 1;
      return Promise.resolve(releaseFactory(options));
    }
    if (queue.length >= pendingLimit) {
      const error = new Error(queueFullMessage);
      error.statusCode = 503;
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, abortError, onAbort: null, options };
      entry.onAbort = () => {
        const index = queue.indexOf(entry);
        if (index < 0) return;
        queue.splice(index, 1);
        signal?.removeEventListener("abort", entry.onAbort);
        reject(abortError());
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      queue.push(entry);
      if (signal?.aborted) entry.onAbort();
    });
  }

  return {
    acquire,
    status: () => ({ active, pending: queue.length, concurrency: limit, maxPending: pendingLimit }),
  };
}
