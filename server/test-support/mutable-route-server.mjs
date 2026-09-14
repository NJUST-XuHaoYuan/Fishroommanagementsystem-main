import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Real HTTP/router/domain code; PG adapter deliberately models only app_state transactions. */
export async function startMutableRouteServer(fixture, { port: requestedPort = 0 } = {}) {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(requestedPort, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  const uploadDir = await mkdtemp(join(tmpdir(), "fishroom-pricing-route-"));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--no-warnings", "--experimental-loader",
    fileURLToPath(new URL("./pg-stub-loader.mjs", import.meta.url)),
    fileURLToPath(new URL("../local-server.mjs", import.meta.url)),
  ], {
    env: { ...process.env, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port),
      AUTH_SESSION_SECRET: "replace_with_stock_pricing_integration_secret", UPLOAD_DIR: uploadDir,
      TRANSCODE_VIDEO_UPLOADS: "false", FISHROOM_TEST_PERSIST_WRITES: "1",
      FISHROOM_TEST_DATABASE_FIXTURE_JSON: JSON.stringify(fixture) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      child.kill("SIGTERM"); await exited; clearTimeout(timer);
    }
    await rm(uploadDir, { recursive: true, force: true });
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Server did not start: ${output}`)), 10_000);
      const finish = (error) => { clearTimeout(timer); child.stdout.off("data", check); child.off("exit", earlyExit); error ? reject(error) : resolve(); };
      const check = () => { if (output.includes("Local Fishroom API/static server:")) finish(); };
      const earlyExit = () => finish(new Error(`Server exited before listening: ${output}`));
      child.stdout.on("data", check); child.once("exit", earlyExit); check();
    });
  } catch (error) { await stop(); throw error; }
  const request = async (path, { token, body, method = body === undefined ? "GET" : "POST" } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, body: await response.json() };
  };
  const login = async (username, password) => {
    const result = await request("/api/auth/login", { body: { username, password } });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return result.body.token;
  };
  let readId = 0;
  const readPersistedState = () => new Promise((resolve, reject) => {
    const requestId = ++readId;
    const timer = setTimeout(() => { child.off("message", receive); reject(new Error("Test store read timed out")); }, 2_000);
    const receive = (message) => {
      if (message?.type !== "fishroom-test-state" || message.requestId !== requestId) return;
      clearTimeout(timer); child.off("message", receive); resolve(message.state);
    };
    child.on("message", receive); child.send({ type: "fishroom-test-state-read", requestId });
  });
  return { child, baseUrl, uploadDir, stop, request, login, readPersistedState, get output() { return output; } };
}
