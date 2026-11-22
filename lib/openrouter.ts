import { setTimeout as delay } from "node:timers/promises";
import { WorkflowError } from "./validation";

export const freeVisionModels = ["nvidia/nemotron-3.5-super-vl:free", "google/gemma-4-31b-it:free"] as const;

export type InferenceResponse = {
  status: number;
  headers: Headers;
  body: {
    error?: {
      code?: number;
      metadata?: { limit_source?: string; headers?: Record<string, string> };
    };
    message?: { content?: string };
    choices?: { message?: { content?: string } }[];
  } | null;
};

const defaultCooldownMs = 45_000;
const maxWaitMs = 5_000;
const modelAvailableAt = new Map<string, number>();

function retryDelay(response: InferenceResponse) {
  const upstreamHeaders = response.body?.error?.metadata?.headers;
  const retryAfter = response.headers.get("retry-after") ?? upstreamHeaders?.["Retry-After"];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  }
  const reset = Number(response.headers.get("x-ratelimit-reset") ?? upstreamHeaders?.["X-RateLimit-Reset"]);
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset - Date.now());
}

function rateLimitError(message: string, waitMs?: number) {
  if (waitMs === undefined) return new WorkflowError(message + " Try again later or continue manually.", 429);
  const seconds = Math.max(1, Math.ceil(waitMs / 1_000));
  const wait = seconds < 60 ? seconds + " seconds" : Math.ceil(seconds / 60) + " minutes";
  return new WorkflowError(message + " Try again in about " + wait + " or continue manually.", 429, seconds);
}

export async function requestFreeVision(
  send: (model: string) => Promise<InferenceResponse>, signal: AbortSignal,
) {
  let retried = false;
  for (const model of freeVisionModels) {
    if ((modelAvailableAt.get(model) ?? 0) > Date.now()) continue;
    for (;;) {
      signal.throwIfAborted();
      const response = await send(model);
      if (response.status !== 429) return { response, model };

      const source = response.body?.error?.metadata?.limit_source;
      const wait = retryDelay(response);
      if (source === "upstream_provider_shared_pool") {
        modelAvailableAt.set(model, Date.now() + Math.max(defaultCooldownMs, wait ?? 0));
        break;
      }
      if (source === "openrouter_free_tier_daily") {
        throw rateLimitError("OpenRouter’s daily free-model quota is exhausted.", wait);
      }
      if (!retried && wait !== undefined && wait + 250 <= maxWaitMs) {
        retried = true;
        await delay(wait + 250, undefined, { signal });
        continue;
      }
      throw rateLimitError("OpenRouter is rate-limiting free-model requests.", wait);
    }
  }

  const nextAvailableAt = Math.min(...freeVisionModels.map(model => modelAvailableAt.get(model) ?? Date.now()));
  throw rateLimitError("The free vision models are temporarily busy.", nextAvailableAt - Date.now());
}
