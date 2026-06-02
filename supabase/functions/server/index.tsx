import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";

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

// The Supabase KV state API is retired. The local PostgreSQL server under
// /api is the only supported state backend; keeping this route writable would
// create an unauthenticated bypass if the old function is deployed.
app.get("/make-server-4a2d1321/state", (c) =>
  c.json({ error: "Legacy Supabase state API is disabled. Use the authenticated /api backend." }, 410)
);

app.post("/make-server-4a2d1321/state", (c) =>
  c.json({ error: "Legacy Supabase state API is disabled. Use the authenticated /api backend." }, 410)
);

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
