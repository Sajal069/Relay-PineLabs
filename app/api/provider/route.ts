import { callback, claimCallback } from "@/lib/workflow";
import { record, WorkflowError } from "@/lib/validation";

export const runtime = "nodejs";

function authorized(request: Request) {
  const token = process.env.RELAY_PROVIDER_TOKEN;
  return token && request.headers.get("authorization") === `Bearer ${token}`;
}

export function GET(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 401 });
  return new Response(null, { status: 405 });
}

export async function POST(request: Request) {
  if (!authorized(request)) return new Response(null, { status: 401 });
  try {
    const body = record(await request.json());
    if (body.action === "claim") return Response.json({ job: claimCallback() });
    const disposition = callback(body);
    return Response.json({ disposition }, { status: disposition === "transport_failure" ? 503 : 200 });
  } catch (error) {
    if (error instanceof WorkflowError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return new Response(null, { status: 400 });
    console.error("Simulator callback failed", error instanceof Error ? error.name : "UnknownError");
    return new Response(null, { status: 500 });
  }
}
