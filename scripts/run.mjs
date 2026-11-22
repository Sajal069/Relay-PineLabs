import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const [mode, ...args] = process.argv.slice(2);
const portIndex = args.findIndex(arg => arg === "-p" || arg === "--port");
const port = (portIndex >= 0 ? args[portIndex + 1] : args.find(arg => arg.startsWith("--port="))?.slice(7))
  ?? process.env.PORT ?? "3000";
const token = randomUUID();
const base = `http://127.0.0.1:${port}/api/provider`;
const auth = { authorization: `Bearer ${token}` };
const env = { ...process.env, PORT: port, RELAY_PROVIDER_TOKEN: token };
const hasHost = args.some(arg => arg === "-H" || arg === "--hostname" || arg.startsWith("--hostname="));
const host = hasHost ? [] : ["--hostname", "127.0.0.1"];
const child = spawn(process.execPath, [require.resolve("next/dist/bin/next"), mode, ...host, ...args], { stdio: "inherit", env });
const controller = new AbortController();

function providerRequest(payload) {
  return fetch(base, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(7000)]),
  });
}

async function deliver(job) {
  let retryable = true;
  try {
    const result = await providerRequest({ ...job, action: "deliver" });
    if (result.ok) return;
    retryable = result.status === 408 || result.status === 429 || result.status >= 500;
  } catch {
    if (controller.signal.aborted) return;
  }
  await providerRequest({ ...job, action: "fail", retryable });
}

async function dispatch() {
  while (!controller.signal.aborted) {
    try {
      const result = await providerRequest({ action: "claim" });
      if (result.ok) {
        const { job } = await result.json();
        if (job) {
          await deliver(job);
          continue;
        }
      }
    } catch {
      // The HTTP server may still be starting. Jobs stay persisted until acknowledged.
    }
    await delay(500, undefined, { signal: controller.signal }).catch(() => {});
  }
}

child.once("exit", code => {
  controller.abort();
  process.exitCode = code ?? 0;
});
child.once("error", error => {
  controller.abort();
  console.error(error);
  process.exitCode = 1;
});
for (const event of ["SIGINT", "SIGTERM"]) process.on(event, () => {
  controller.abort();
  child.kill();
});
await dispatch();
