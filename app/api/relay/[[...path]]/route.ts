import { workspaceHome } from "@/lib/access";
import { checkRequestOrigin, requireSession, revokeSession, sessionCookieHeader, signIn, signUp, tokenFromRequest } from "@/lib/auth";
import { demo, listApplications, listInbox, loadApplication, operate, submit } from "@/lib/workflow";
import { record, WorkflowError } from "@/lib/validation";

export const runtime = "nodejs";
type Context = { params: Promise<{ path?: string[] }> };
const privateHeaders = { "Cache-Control": "private, no-store" };

function json(data: unknown, status = 200, extra?: Record<string, string>) {
  return Response.json(data, { status, headers: { ...privateHeaders, ...extra } });
}

function relayError(error: unknown) {
  if (error instanceof WorkflowError) {
    const retry = error.retryAfterSeconds === undefined ? undefined : { "Retry-After": String(error.retryAfterSeconds) };
    return json({ error: error.message }, error.status, retry);
  }
  if (error instanceof SyntaxError) return json({ error: "The request could not be read. Try again." }, 400);
  console.error("Relay request failed", error instanceof Error ? error.name : "UnknownError");
  return json({ error: "Something interrupted this request. Please try again." }, 500);
}

export async function GET(request: Request, { params }: Context) {
  try {
    const user = requireSession(request);
    const [id, ...rest] = (await params).path ?? [];
    if (rest.length) throw new WorkflowError("This endpoint could not be found.", 404);
    if (id === "inbox") return json(listInbox(user));
    return json(id ? loadApplication(id, user) : listApplications(user));
  } catch (error) {
    return relayError(error);
  }
}

async function session(request: Request) {
  const data = record(await request.json());
  const previous = tokenFromRequest(request);
  if (data.action === "signOut") {
    revokeSession(previous);
    return json({ home: "/" }, 200, { "Set-Cookie": sessionCookieHeader(request) });
  }
  if (data.action !== "signIn" && data.action !== "signUp") throw new WorkflowError("Choose a sign-in action.");
  const result = data.action === "signUp" ? await signUp(data, previous) : await signIn(data, previous);
  return json({ home: workspaceHome(result.user.role) }, data.action === "signUp" ? 201 : 200,
    { "Set-Cookie": sessionCookieHeader(request, result.token) });
}

export async function POST(request: Request, { params }: Context) {
  try {
    checkRequestOrigin(request);
    const [id, endpoint, ...rest] = (await params).path ?? [];
    if (id === "session" && !endpoint) return await session(request);
    const user = requireSession(request);
    const body: unknown = await request.json();
    if (!id) return json({ id: submit(body, user) }, 201);
    if (rest.length || (endpoint && endpoint !== "demo")) throw new WorkflowError("This endpoint could not be found.", 404);
    if (endpoint === "demo") return json({ message: demo(id, body, user), application: loadApplication(id, user) });
    return json(operate(id, body, user));
  } catch (error) {
    return relayError(error);
  }
}
