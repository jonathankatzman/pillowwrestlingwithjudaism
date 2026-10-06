import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { SAGES, SAGE_IDS, buildSystemPrompt } from "./sages.js";
import { runAgent } from "./lib/agent.js";
import { validateAskBody } from "./lib/validate.js";
import { createRateLimiter, rateLimitConfigFromEnv, clientIp } from "./lib/rateLimit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader (no dependency; local dev only — Vercel injects env vars) ---
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

export function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Invalid or missing Anthropic API key — set ANTHROPIC_API_KEY and restart.";
  }
  if (/resolve authentication method/i.test(String(err?.message))) {
    return "No Anthropic API key configured — copy .env.example to .env (or set ANTHROPIC_API_KEY in your host's env vars), add your key, and restart.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "We're being rate limited. Take a breath and try again in a moment.";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Couldn't reach Claude just now. Please try again in a moment.";
  }
  if (err instanceof Anthropic.APIError) {
    return `API error (${err.status}): ${err.message}`;
  }
  return "Something went wrong in the study house. Please try again.";
}

/**
 * Build the Express app. Dependencies are injectable for tests.
 * @param {object} [deps]
 * @param {() => Anthropic} [deps.getClient]
 * @param {ReturnType<typeof createRateLimiter>} [deps.rateLimiter]
 * @param {typeof runAgent} [deps.agent]
 */
export function createApp({
  getClient = defaultClientFactory(),
  rateLimiter = createRateLimiter(rateLimitConfigFromEnv()),
  agent = runAgent,
} = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // Locally Express serves the UI; on Vercel public/ is served from the CDN and this is ignored.
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/sages", (_req, res) => {
    res.json(
      SAGES.map(({ id, name, hebrew, years, era, emoji, blurb, color, mention }) => ({
        id, name, hebrew, years, era, emoji, blurb, color, mention,
      }))
    );
  });

  app.post("/api/ask", async (req, res) => {
    const parsed = validateAskBody(req.body, { sageIds: SAGE_IDS });
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }

    // Rate limit before any SSE / model work (see lib/rateLimit.js for caveats).
    const limit = rateLimiter.check(clientIp(req));
    if (!limit.ok) {
      res.setHeader("Retry-After", String(limit.retryAfterSec));
      return res.status(429).json({
        error:
          limit.reason === "daily"
            ? "You've asked a lot of questions today. The study house reopens tomorrow."
            : "Slow down a little — too many questions in a short time. Try again in a few minutes.",
        retryAfterSec: limit.retryAfterSec,
      });
    }

    // SSE response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // Abort the Anthropic stream / Sefaria fetches if the client goes away.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    const send = (event, data) => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    try {
      await agent({
        client: getClient(),
        system: buildSystemPrompt(parsed.sage),
        messages: parsed.messages,
        emit: send,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted || err instanceof Anthropic.APIUserAbortError) {
        // Client disconnected; nothing to report.
      } else {
        console.error("ask error:", err);
        send("error", { message: friendlyError(err) });
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  return app;
}

function defaultClientFactory() {
  let client;
  // Lazily constructed so a missing key surfaces as a friendly SSE error, not a crash.
  return () => (client ??= new Anthropic()); // reads ANTHROPIC_API_KEY from env
}

const app = createApp();
export default app;

// Vercel imports the default export and serves it; only listen when running locally.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!process.env.VERCEL && isMain) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🛏️  Pillow Wrestling with Judaism → http://localhost:${PORT}`);
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      console.warn("⚠️  No ANTHROPIC_API_KEY in env — questions will only work if an `ant auth login` profile is configured. Otherwise add a key to .env.");
    }
  });
}
