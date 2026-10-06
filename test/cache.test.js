import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTtlCache } from "../lib/cache.js";

describe("createTtlCache", () => {
  it("returns values until they expire", () => {
    let t = 1000;
    const cache = createTtlCache({ ttlMs: 50, now: () => t });
    cache.set("a", { x: 1 });
    assert.deepEqual(cache.get("a"), { x: 1 });
    t += 49;
    assert.deepEqual(cache.get("a"), { x: 1 });
    t += 1;
    assert.equal(cache.get("a"), undefined, "expires exactly at ttl");
    assert.equal(cache.size, 0, "expired entries are removed on read");
  });

  it("re-setting a key refreshes its ttl", () => {
    let t = 0;
    const cache = createTtlCache({ ttlMs: 10, now: () => t });
    cache.set("a", 1);
    t = 8;
    cache.set("a", 2);
    t = 15;
    assert.equal(cache.get("a"), 2);
  });

  it("evicts the oldest-inserted entries beyond maxEntries", () => {
    const cache = createTtlCache({ maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 11); // moves "a" to newest
    cache.set("c", 3);
    assert.equal(cache.size, 2);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), 11);
    assert.equal(cache.get("c"), 3);
  });

  it("clear() empties the cache and misses return undefined", () => {
    const cache = createTtlCache();
    cache.set("a", 0);
    assert.equal(cache.get("a"), 0, "falsy values are still hits");
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.get("missing"), undefined);
  });

  it("uses Date.now by default (mocked timers)", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const cache = createTtlCache({ ttlMs: 1000 });
    cache.set("a", 1);
    t.mock.timers.tick(999);
    assert.equal(cache.get("a"), 1);
    t.mock.timers.tick(1);
    assert.equal(cache.get("a"), undefined);
  });
});
