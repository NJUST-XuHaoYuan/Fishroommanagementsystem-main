import { spawn } from "node:child_process";

const children = [];

function start(name, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
  children.push(child);
  child.on("exit", (code) => {
    if (code !== 0 && !shuttingDown) {
      console.error(`${name} exited with code ${code}`);
      shutdown(code || 1);
    }
  });
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 200);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("api", "node", ["server/local-server.mjs"], { LOCAL_API_PORT: "8787" });
start("vite", "npx", ["vite", "--host", "127.0.0.1"]);
