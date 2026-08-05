import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const MAX_EXTRACTED_CHARS = 200_000;

function normalizeExtractedText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\u0000/g, "")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_EXTRACTED_CHARS);
}

/** Extract résumé text locally before the original bytes are encrypted. */
export async function extractJobDocumentText(
  bytes: Uint8Array,
  filename: string,
  contentType: string,
): Promise<string> {
  if (contentType === "application/pdf" || /\.pdf$/i.test(filename)) {
    // pdf.js transfers its input ArrayBuffer to a worker and may detach it.
    // Extraction runs before authenticated encryption, so hand pdf.js a copy
    // and preserve the original upload bytes for sealing and storage.
    const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true });
    const pdf = await task.promise;
    const pages: string[] = [];
    try {
      for (let index = 1; index <= Math.min(pdf.numPages, 100); index++) {
        const page = await pdf.getPage(index);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
      }
    } finally {
      await task.destroy();
    }
    return normalizeExtractedText(pages.join("\n\n"));
  }

  if (
    contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.docx$/i.test(filename)
  ) {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return normalizeExtractedText(result.value);
  }

  throw new Error("Only PDF and DOCX documents are supported");
}

function winAnsiSafe(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");
}

function wrapLine(line: string, font: PDFFont, size: number, width: number): string[] {
  if (!line.trim()) return [""];
  const words = line.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}

function addCoverLetterPage(pdf: PDFDocument): PDFPage {
  return pdf.addPage([612, 792]);
}

/** Produce a conservative, ATS-friendly PDF cover letter entirely in memory. */
export async function renderCoverLetterPdf(content: string): Promise<Uint8Array> {
  const safe = winAnsiSafe(content).trim();
  if (safe.length < 80 || safe.length > 20_000) {
    throw new Error("Cover letter content must be between 80 and 20,000 characters");
  }

  const pdf = await PDFDocument.create();
  pdf.setTitle("Cover Letter");
  pdf.setCreator("BrowserPilot");
  pdf.setProducer("BrowserPilot");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontSize = 11;
  const lineHeight = 15;
  const margin = 72;
  const usableWidth = 612 - margin * 2;
  let page = addCoverLetterPage(pdf);
  let y = 792 - margin;

  for (const paragraph of safe.split(/\n/)) {
    for (const line of wrapLine(paragraph, font, fontSize, usableWidth)) {
      if (y < margin + lineHeight) {
        page = addCoverLetterPage(pdf);
        y = 792 - margin;
      }
      if (line) page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0.08, 0.08, 0.08) });
      y -= lineHeight;
    }
    y -= 5;
  }

  const bytes = await pdf.save({ useObjectStreams: false });
  const verification = await PDFDocument.load(bytes);
  if (verification.getPageCount() < 1) throw new Error("Generated cover letter PDF is empty");
  return bytes;
}
