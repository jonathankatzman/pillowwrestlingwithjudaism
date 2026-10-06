import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter, rateLimitConfigFromEnv, clientIp } from "../lib/rateLimit.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("createRateLimiter", () => {
  it("enforces the short window per key and reports retryAfterSec", () => {
    let now = 0;
    const rl = createRateLimiter({ windowMs: 10 * MIN, windowMax: 2, dailyMax: 0, now: () => now });
    assert.deepEqual(rl.check("a"), { ok: true });
    now = 1 * MIN;
    assert.deepEqual(rl.check("a"), { ok: true });
    now = 2 * MIN;
    assert.deepEqual(rl.check("a"), { ok: false, reason: "window", retryAfterSec: 8 * 60 });
    assert.deepEqual(rl.check("b"), { ok: true }, "other keys are independent");
    now = 10 * MIN; // first hit has left the window
    assert.deepEqual(rl.check("a"), { ok: true });
    assert.equal(rl.check("a").reason, "window");
  });

  it("denied requests are not counted", () => {
    let now = 0;
    const rl = createRateLimiter({ windowMs: MIN, windowMax: 1, dailyMax: 0, now: () => now });
    rl.check("a");
    for (let i = 0; i < 5; i++) assert.equal(rl.check("a").ok, false);
    now = MIN;
    assert.equal(rl.check("a").ok, true);
  });

  it("enforces the daily cap across windows", () => {
    let now = 0;
    const rl = createRateLimiter({ windowMs: MIN, windowMax: 2, dailyMax: 3, now: () => now });
    assert.ok(rl.check("a").ok);
    assert.ok(rl.check("a").ok);
    now = 2 * MIN;
    assert.ok(rl.check("a").ok);
    now = 4 * MIN;
    const denied = rl.check("a");
    assert.equal(denied.reason, "daily");
    assert.equal(denied.retryAfterSec, Math.ceil((DAY - 4 * MIN) / 1000));
    now = DAY; // first two hits (t=0) have aged out
    assert.ok(rl.check("a").ok);
  });

  it("a max of 0 disables that limit", () => {
    const rl = createRateLimiter({ windowMax: 0, dailyMax: 0, now: () => 0 });
    for (let i = 0; i < 1000; i++) assert.ok(rl.check("a").ok);
  });

  it("bounds the number of tracked keys and supports reset()", () => {
    const rl = createRateLimiter({ windowMax: 1, dailyMax: 0, maxKeys: 2, now: () => 0 });
    rl.check("a");
    rl.check("b");
    rl.check("c"); // evicts "a"
    assert.ok(rl.check("a").ok, "evicted key starts fresh");
    assert.equal(rl.check("c").ok, false);
    rl.reset();
    assert.ok(rl.check("c").ok);
  });
});

describe("rateLimitConfigFromEnv", () => {
  it("uses defaults", () => {
    assert.deepEqual(rateLimitConfigFromEnv({}), {
      windowMs: 10 * MIN,
      windowMax: 10,
      dailyMax: 50,
    });
  });
  it("parses overrides and ignores junk", () => {
    assert.deepEqual(
      rateLimitConfigFromEnv({
        RATE_LIMIT_WINDOW_MINUTES: "5",
        RATE_LIMIT_WINDOW_MAX: "0",
        RATE_LIMIT_DAILY_MAX: "-3",
      }),
      { windowMs: 5 * MIN, windowMax: 0, dailyMax: 50 }
    );
    assert.equal(rateLimitConfigFromEnv({ RATE_LIMIT_WINDOW_MAX: "lots" }).windowMax, 10);
  });
});

describe("clientIp", () => {
  it("prefers the first x-forwarded-for hop", () => {
    const req = {
      headers: { "x-forwarded-for": " 203.0.113.7 , 10.0.0.1" },
      socket: { remoteAddress: "::1" },
    };
    assert.equal(clientIp(req), "203.0.113.7");
  });
  it("handles an array header", () => {
    assert.equal(
      clientIp({ headers: { "x-forwarded-for": ["198.51.100.2, 10.0.0.1"] } }),
      "198.51.100.2"
    );
  });
  it("falls back to the socket address, then req.ip, then 'unknown'", () => {
    assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "::1" } }), "::1");
    assert.equal(clientIp({ headers: { "x-forwarded-for": "" }, ip: "1.2.3.4" }), "1.2.3.4");
    assert.equal(clientIp({}), "unknown");
  });
});
