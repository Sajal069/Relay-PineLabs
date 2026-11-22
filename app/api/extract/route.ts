import { extractDocument, extractionAvailability, requireExtraction } from "@/lib/extraction";
import { checkRequestOrigin, requireSession } from "@/lib/auth";
import { maxPageBytes, maxPages } from "@/lib/onboarding";
import { checkKind, WorkflowError } from "@/lib/validation";

export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };
const maxBody = maxPageBytes * maxPages + 32_768;

export function GET(request: Request) {
  try {
    requireSession(request, "merchant");
    return Response.json(extractionAvailability(), { headers });
  } catch (error) {
    if (error instanceof WorkflowError) return Response.json({ error: error.message }, { status: error.status, headers });
    return Response.json({ error: "Document extraction is unavailable." }, { status: 500, headers });
  }
}

async function uploadBody(request: Request) {
  const type = request.headers.get("content-type");
  if (!type?.startsWith("multipart/form-data;") || !request.body) {
    throw new WorkflowError("Attach a document to read.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBody) {
      await reader.cancel();
      throw new WorkflowError("This document is too large. Use a smaller image or PDF.", 413);
    }
    chunks.push(value);
  }
  try {
    checkRequestOrigin(request);
    requireSession(request, "merchant");
    return await new Response(Buffer.concat(chunks, size), { headers: { "content-type": type } }).formData();
  } catch {
    throw new WorkflowError("The document upload could not be read. Select it again.");
  }
}

async function imagePayload(value: FormDataEntryValue) {
  if (typeof value === "string" || value.size === 0 || value.size > maxPageBytes) {
    throw new WorkflowError("Each document image must be smaller than 3 MB.", 413);
  }
  const bytes = Buffer.from(await value.arrayBuffer());
  const validPng = value.type === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const validJpeg = value.type === "image/jpeg" && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (!validPng && !validJpeg) throw new WorkflowError("Choose a valid PNG, JPEG or PDF document.");
  return { data: bytes.toString("base64"), mimeType: validPng ? "image/png" as const : "image/jpeg" as const };
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("x-relay-extraction") !== "1") {
      throw new WorkflowError("Open New application to extract a document.", 403);
    }
    const config = requireExtraction();
    if (Number(request.headers.get("content-length")) > maxBody) throw new WorkflowError("This document is too large.", 413);
    const form = await uploadBody(request);
    const kind = checkKind(form.get("kind"));
    const entries = form.getAll("pages");
    if (!entries.length || entries.length > maxPages) throw new WorkflowError("Upload one document with up to two pages.");
    const images = await Promise.all(entries.map(imagePayload));
    return Response.json(await extractDocument(kind, images, request.signal, config), { headers });
  } catch (error) {
    if (error instanceof WorkflowError) {
      const errorHeaders = error.retryAfterSeconds === undefined
        ? headers : { ...headers, "Retry-After": String(error.retryAfterSeconds) };
      return Response.json({ error: error.message }, { status: error.status, headers: errorHeaders });
    }
    return Response.json({ error: "Document extraction was interrupted. Please try again." }, { status: 500, headers });
  }
}
