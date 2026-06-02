import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import * as kv from "./kv_store.tsx";

const app = new Hono();

app.use("*", logger(console.log));

app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

app.get("/make-server-4a2d1321/health", (c) => {
  return c.json({ status: "ok" });
});

// Top-level state keys persisted individually (no "user")
const STATE_KEYS = [
  "speciesCategories",
  "productOrigins",
  "customerSources",
  "species",
  "products",
  "tankGroups",
  "batches",
  "stock",
  "logs",
  "checks",
  "bioRecords",
  "orders",
  "shipments",
  "customers",
];

const kvKey = (k: string) => `fr2_${k}`;

// ── GET /state — load full app state ──────────────────────────────
app.get("/make-server-4a2d1321/state", async (c) => {
  try {
    const state: Record<string, unknown> = {};
    let hasAny = false;

    // Parallel reads are safe (reads don't exhaust the connection pool)
    const results = await Promise.allSettled(
      STATE_KEYS.map((k) => kv.get(kvKey(k)).then((val) => ({ k, val })))
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { k, val } = result.value;
        if (val !== null && val !== undefined) {
          state[k] = val;
          hasAny = true;
        }
      } else {
        console.log(`Error loading a state key:`, result.reason);
      }
    }

    if (!hasAny) {
      // Fallback: migrate from old single-blob format if it exists
      try {
        const legacy = await kv.get("fishroom_state");
        if (legacy && typeof legacy === "object") {
          console.log("Migrating from legacy single-blob format…");
          const legacyObj = legacy as Record<string, unknown>;
          for (const k of STATE_KEYS) {
            if (legacyObj[k] !== undefined) {
              try {
                await kv.set(kvKey(k), legacyObj[k]);
              } catch (e) {
                console.log(`Error migrating key "${k}":`, e);
              }
            }
          }
          return c.json({ data: legacy });
        }
      } catch (e) {
        console.log("Error checking legacy state:", e);
      }
      return c.json({ data: null });
    }

    return c.json({ data: state });
  } catch (e) {
    console.log("Error in GET /state:", e);
    return c.json({ error: String(e) }, 500);
  }
});

// ── POST /state — save full app state ─────────────────────────────
app.post("/make-server-4a2d1321/state", async (c) => {
  try {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch (e) {
      console.log("Error parsing POST /state body:", e);
      return c.json({ error: "Invalid or unreadable JSON body" }, 400);
    }

    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid body" }, 400);
    }

    const failed: string[] = [];

    // Sequential writes to avoid connection-pool exhaustion
    for (const k of STATE_KEYS) {
      const val = body[k];
      if (val !== undefined) {
        try {
          await kv.set(kvKey(k), val);
        } catch (e) {
          console.log(`Error saving key "${k}":`, e);
          failed.push(k);
        }
      }
    }

    if (failed.length > 0) {
      if (failed.length === STATE_KEYS.length) {
        return c.json({ error: `All saves failed. First key: ${failed[0]}` }, 500);
      }
      console.log(`Partial save — failed keys: ${failed.join(", ")}`);
    }

    return c.json({ ok: true });
  } catch (e) {
    console.log("Error in POST /state:", e);
    return c.json({ error: String(e) }, 500);
  }
});

// Gracefully handle aborted / dropped connections so Deno doesn't log
// uncaught "Http: connection closed before message completed" errors.
Deno.serve({
  handler: app.fetch,
  onError: (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("connection closed") && !msg.includes("broken pipe")) {
      console.log("Deno.serve unhandled error:", msg);
    }
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  },
});