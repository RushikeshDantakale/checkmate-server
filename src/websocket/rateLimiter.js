'use strict';

/**
 * Per-socket token bucket (D-030). RAM only. A bucket holds `limit` tokens and refills
 * continuously, so "5 per 5 s" allows a burst of 5 and then one message per second.
 * Buckets belong to the socket: a new connection starts with full buckets (Phase 8 will review this).
 */
function consume(socket, key, limit, windowMs, now = Date.now()) {
  if (!socket.rateBuckets) socket.rateBuckets = new Map();
  let bucket = socket.rateBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: limit, last: now };
    socket.rateBuckets.set(key, bucket);
  }
  bucket.tokens = Math.min(limit, bucket.tokens + ((now - bucket.last) / windowMs) * limit);
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

module.exports = { consume };
