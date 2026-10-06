// In-memory per-IP rate limiter for /api/ask.
//
// NOTE: this is best effort. On Vercel each function instance keeps its own
// memory and instances come and go, so a determined client can exceed these
// limits. The real guard in production is a Vercel Firewall rate-limit rule on
// /api/ask (plus a spend limit in the Anthropic Console). This layer just stops
// casual hammering of a single warm instance and keeps local dev honest.

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function intFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function rateLimitConfigFromEnv(env = process.env) {
  return {
    windowMs: intFromEnv(env, "RATE_LIMIT_WINDOW_MINUTES", 10) * MINUTE,
    windowMax: intFromEnv(env, "RATE_LIMIT_WINDOW_MAX", 10),
    dailyMax: intFromEnv(env, "RATE_LIMIT_DAILY_MAX", 50),
  };
}

// Client IP: first hop of x-forwarded-for when present (Vercel sets this header
// itself), else the socket address. Without a trusted proxy in front, the header
// is client-controlled, so locally this is only a courtesy limit.
export function clientIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || req.ip || "unknown";
}

/**
 * @param {{windowMs?: number, windowMax?: number, dailyMax?: number, now?: () => number, maxKeys?: number}} opts
 * A max of 0 disables that limit.
 */
export function createRateLimiter({
  windowMs = 10 * MINUTE,
  windowMax = 10,
  dailyMax = 50,
  now = Date.now,
  maxKeys = 10_000,
} = {}) {
  const hits = new Map(); // key -> sorted timestamps within the last day

  function prune(key, t) {
    const list = (hits.get(key) ?? []).filter((ts) => t - ts < DAY);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  }

  return {
    /** Record a hit if allowed. Returns {ok: true} or {ok: false, retryAfterSec, reason}. */
    check(key) {
      const t = now();
      const list = prune(key, t);

      if (dailyMax > 0 && list.length >= dailyMax) {
        return {
          ok: false,
          reason: "daily",
          retryAfterSec: Math.ceil((list[list.length - dailyMax] + DAY - t) / 1000),
        };
      }
      if (windowMax > 0) {
        const inWindow = list.filter((ts) => t - ts < windowMs);
        if (inWindow.length >= windowMax) {
          const oldest = inWindow[inWindow.length - windowMax];
          return {
            ok: false,
            reason: "window",
            retryAfterSec: Math.ceil((oldest + windowMs - t) / 1000),
          };
        }
      }

      list.push(t);
      hits.set(key, list);
      // Keep memory bounded: drop the oldest-inserted keys if we track too many.
      while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
      return { ok: true };
    },
    reset() {
      hits.clear();
    },
  };
}
