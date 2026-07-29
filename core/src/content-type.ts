/**
 * What a downloaded file is, judged by its name.
 *
 * The console shows these inline — a purchase order should open in the viewer
 * rather than land in the downloads tray — and a browser decides that from the
 * Content-Type. Object storage keeps whatever it is told, so the guess is made
 * once here, on the way in.
 *
 * Deliberately narrow. Anything not listed is served as a byte stream, which
 * browsers download rather than render, and that is the safe default for a
 * file that arrived from someone else's website.
 */
const BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
  xml: "application/xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  zip: "application/zip",
};

export const FALLBACK_CONTENT_TYPE = "application/octet-stream";

export function contentTypeFor(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (!extension || extension === filename.toLowerCase()) return FALLBACK_CONTENT_TYPE;
  return BY_EXTENSION[extension] ?? FALLBACK_CONTENT_TYPE;
}

/**
 * Whether the console can show this in the viewer rather than only offer it.
 *
 * SVG is excluded on purpose: it is a document that can carry script, and this
 * one came from a target site.
 */
export function isViewable(filename: string): boolean {
  const type = contentTypeFor(filename);
  return type === "application/pdf" || (type.startsWith("image/") && type !== "image/svg+xml");
}
