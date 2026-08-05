import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { extractJobDocumentText, renderCoverLetterPdf } from "../src/jobs/documents";

async function tinyDocx(text: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array" });
}

describe("private job documents", () => {
  test("extracts searchable text from PDF and DOCX résumés", async () => {
    const cover = await renderCoverLetterPdf("E2E Candidate\n\nDear Hiring Team,\n\nI build reliable browser automation systems and would welcome the opportunity to contribute.\n\nSincerely,\nE2E Candidate");
    expect(await extractJobDocumentText(cover, "resume.pdf", "application/pdf"))
      .toContain("reliable browser automation systems");
    expect(Buffer.from(cover.subarray(0, 5)).toString()).toBe("%PDF-");

    const docx = await tinyDocx("Senior browser automation engineer");
    expect(await extractJobDocumentText(docx, "resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
      .toBe("Senior browser automation engineer");
  }, 30_000);

  test("generates a valid ATS-friendly PDF cover letter", async () => {
    const bytes = await renderCoverLetterPdf("E2E Candidate\nPhoenix, Arizona\n\nDear Hiring Team,\n\nMy experience building secure browser automation aligns with this role. I would be glad to discuss the position.\n\nSincerely,\nE2E Candidate");
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe("Cover Letter");
  });
});
