// Tiny in-memory TTL cache with a bounded size (oldest-inserted evicted first).
// Per-process only: on Vercel each warm instance has its own copy, which is fine
// for a best-effort cache of public Sefaria data.

export function createTtlCache({ ttlMs = 60 * 60 * 1000, maxEntries = 500, now = Date.now } = {}) {
  const map = new Map(); // key -> { value, expires }

  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) {
        map.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      map.delete(key); // re-insert so it moves to the "newest" end
      map.set(key, { value, expires: now() + ttlMs });
      while (map.size > maxEntries) {
        map.delete(map.keys().next().value);
      }
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}
