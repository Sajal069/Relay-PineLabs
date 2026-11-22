import { sampleForm, type CheckKind } from "@/lib/model";
import { maxDocumentBytes, maxPageBytes, maxPages, type ExtractedDocument } from "@/lib/onboarding";

const maxDimension = 2000;

export class DocumentReadError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(Math.round(width), 1);
  canvas.height = Math.max(Math.round(height), 1);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not prepare the document image.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, context };
}

async function jpeg(canvas: HTMLCanvasElement) {
  const image = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!image || image.size > maxPageBytes) throw new Error("The image is too large after processing. Try a smaller document.");
  return image;
}

async function pdfPages(file: File) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const task = pdfjs.getDocument({ data: await file.arrayBuffer(), useSystemFonts: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > maxPages) throw new Error("Use a PDF with up to two pages. Export the pages with the required information.");
    const images: Blob[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(maxDimension / Math.max(original.width, original.height), 4);
      const viewport = page.getViewport({ scale });
      const { canvas } = makeCanvas(viewport.width, viewport.height);
      await page.render({ canvas, viewport }).promise;
      images.push(await jpeg(canvas));
    }
    return images;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Use a PDF")) throw error;
    throw new Error("This PDF could not be read. Try an unlocked PDF or upload a PNG or JPEG.");
  } finally {
    await task.destroy().catch(() => {});
  }
}

async function imagePages(file: File) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("This image could not be read. Try a different PNG or JPEG.");
  try {
    const scale = Math.min(maxDimension / Math.max(bitmap.width, bitmap.height), 1);
    const { canvas, context } = makeCanvas(bitmap.width * scale, bitmap.height * scale);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return [await jpeg(canvas)];
  } finally {
    bitmap.close();
  }
}

export async function readDocument(file: File, kind: CheckKind, signal: AbortSignal): Promise<ExtractedDocument> {
  if (!file.size || file.size > maxDocumentBytes) throw new Error("Choose a document smaller than 8 MB.");
  signal.throwIfAborted();
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isImage = ["image/jpeg", "image/png"].includes(file.type) || /\.(jpe?g|png)$/i.test(file.name);
  if (!isPdf && !isImage) throw new Error("Choose a PNG, JPEG or PDF document.");
  const pages = await (isPdf ? pdfPages(file) : imagePages(file));
  signal.throwIfAborted();

  const form = new FormData();
  form.set("kind", kind);
  pages.forEach((page, index) => form.append("pages", page, `page-${index + 1}.jpg`));
  const response = await fetch("/api/extract", { method: "POST", headers: { "X-Relay-Extraction": "1" }, body: form, signal });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    throw new DocumentReadError(body?.error ?? "Document reading was interrupted. Try again.", response.status);
  }
  return body as ExtractedDocument;
}

const samples = {
  pan: { title: "Permanent Account Number card", fields: [["Name", sampleForm.signatory], ["Permanent Account Number", sampleForm.pan]] },
  gst: { title: "GST registration certificate", fields: [["GSTIN", sampleForm.gstin], ["Legal name", sampleForm.documents.gst.value], ["Principal place of business", `${sampleForm.city}, Maharashtra`]] },
  bank: { title: "Bank account confirmation", fields: [["Account holder", sampleForm.documents.gst.value], ["Account number", sampleForm.account], ["IFSC", sampleForm.ifsc]] },
};

export async function makeSampleDocument(kind: CheckKind) {
  const sample = samples[kind];
  const { canvas, context } = makeCanvas(1180, 270 + sample.fields.length * 120);
  context.fillStyle = "#172b47";
  context.fillRect(0, 0, canvas.width, 160);
  context.fillStyle = "#c6dbf7";
  context.font = "600 23px Arial";
  context.fillText("RELAY SANDBOX  /  FICTIONAL DOCUMENT", 52, 52);
  context.fillStyle = "#ffffff";
  context.font = "700 46px Arial";
  context.fillText(sample.title, 52, 121);
  sample.fields.forEach(([label, value], index) => {
    const y = 206 + index * 120;
    context.fillStyle = "#4e617a";
    context.font = "600 26px Arial";
    context.fillText(label, 52, y);
    context.fillStyle = "#172b47";
    context.font = "600 37px Arial";
    context.fillText(value, 52, y + 47);
  });
  context.fillStyle = "#536783";
  context.font = "600 22px Arial";
  context.fillText("For Relay demonstrations only. Contains synthetic data.", 52, canvas.height - 30);
  const image = await jpeg(canvas);
  return new File([image], `fictional-${kind}.jpg`, { type: "image/jpeg" });
}
