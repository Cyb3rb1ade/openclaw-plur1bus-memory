/**
 * lib/bounded-operation-queue.js — depth-bounded queue that sheds oldest
 * low-priority background jobs before dropping explicit work.
 *
 * The scheduler uses this for recall and per-agent capture queues so that
 * background backlogs cannot grow without bound under memory pressure.
 */

function isEvictable(item) {
  return item?.background === true && item?.priority === "low";
}

function isExplicit(item) {
  return item?.background !== true || item?.priority !== "low";
}

export function makeBoundedQueue({ maxDepth = Infinity, onEvict } = {}) {
  const depth = Number.isFinite(maxDepth) && maxDepth > 0 ? Math.floor(maxDepth) : Infinity;
  const queue = [];

  function evictOldestLowPriority() {
    for (let i = 0; i < queue.length; i++) {
      if (isEvictable(queue[i])) {
        const evicted = queue.splice(i, 1)[0];
        if (typeof onEvict === "function") {
          try {
            onEvict(evicted, { queueDepth: queue.length });
          } catch (_) {
            // Eviction callback must not break enqueue.
          }
        }
        return true;
      }
    }
    return false;
  }

  return {
    get queue() {
      return queue;
    },
    get length() {
      return queue.length;
    },
    /**
     * Try to add an item to the queue.
     * @returns {{accepted: boolean, evicted: boolean, dropped: boolean}}
     */
    push(item) {
      if (depth === Infinity || queue.length < depth) {
        queue.push(item);
        return { accepted: true, evicted: false, dropped: false };
      }

      // Queue full: try to evict the oldest low-priority background job.
      if (isEvictable(item) && evictOldestLowPriority()) {
        queue.push(item);
        return { accepted: true, evicted: true, dropped: false };
      }

      // If the new item is explicit (not background/low), never silently drop
      // it; accept a temporary soft-cap exceed instead.
      if (isExplicit(item)) {
        queue.push(item);
        return { accepted: true, evicted: false, dropped: false };
      }

      // New item is low-priority background and no evictable job exists.
      return { accepted: false, evicted: false, dropped: true };
    },
    shift() {
      return queue.shift();
    },
    clear() {
      queue.length = 0;
    },
  };
}
