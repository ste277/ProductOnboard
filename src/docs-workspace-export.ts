import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import MarkdownIt from "markdown-it";
import type { DocsWorkspaceDocument, DocumentRevision } from "./docs-workspace.js";

export type DocumentExportFormat = "markdown" | "html";
export interface DocumentExportRecord {
  id: string;
  documentId: string;
  revisionId: string;
  revisionChecksum: string;
  evidencePackageChecksum: string;
  format: DocumentExportFormat;
  exportedAt: string;
  resultChecksum: string;
}
export interface DocumentExport {
  filename: string;
  contentType: string;
  body: string;
  record: DocumentExportRecord;
}
export interface ExportAvailability {
  markdown: { available: boolean; reason?: string };
  html: { available: boolean; reason?: string };
}

export function revisionSnapshotChecksum(revision: DocumentRevision): string {
  return exportChecksum(JSON.stringify(revision));
}

export function assertApprovedExport(document: DocsWorkspaceDocument, requestedRevisionId: string): DocumentRevision {
  if (document.reviewStatus !== "approved") throw new Error("Export requires an approved document");
  const revision = document.revisions?.find((item) => item.id === requestedRevisionId);
  if (!revision || document.currentRevisionId !== requestedRevisionId || document.approvedContent?.revisionId !== requestedRevisionId) {
    throw new Error("The requested revision is not the current explicitly approved revision");
  }
  const audit = document.auditTrail?.slice().reverse().find((item) => item.action === "approved" && item.revisionId === requestedRevisionId);
  if (!audit?.revisionChecksum || !audit.revisionSnapshotChecksum) {
    throw new Error("Approve this revision again to record its export integrity checks");
  }
  const contentChecksum = exportChecksum(`${revision.title}\n${revision.markdown}`);
  const imageChecksum = exportChecksum(JSON.stringify({ title: revision.title, markdown: revision.markdown,
    screenshots: revision.screenshotReviews }));
  if (![contentChecksum, imageChecksum].includes(revision.checksum) || revision.checksum !== audit.revisionChecksum ||
    revisionSnapshotChecksum(revision) !== audit.revisionSnapshotChecksum) {
    throw new Error("Approved revision integrity check failed");
  }
  if (audit.evidencePackageChecksum !== document.evidencePackageChecksum ||
    document.approvedContent.evidencePackageChecksum !== document.evidencePackageChecksum) {
    throw new Error("Approved evidence checksum does not match");
  }
  if (revision.validation.status !== "passed" || revision.validation.unsupportedStatements !== 0 ||
    revision.validation.issues.length || !revision.evidenceAssociations.length ||
    revision.evidenceAssociations.some((item) => item.status !== "valid")) {
    throw new Error("Export requires passing grounding for the approved revision");
  }
  if (revision.tenantWarnings.some((item) => item.status === "unresolved")) throw new Error("Tenant information still requires review");
  if (!revision.screenshotReviews || revision.screenshotReviews.some((item) => item.disposition !== "excluded" &&
    (item.disposition !== "accepted-safe" || item.safety === "known-tenant-information" || item.checksum === "unavailable"))) {
    throw new Error("Included screenshots have unresolved or unsafe review dispositions");
  }
  const included = revision.screenshotReviews.filter((item) => item.disposition === "accepted-safe")
    .map(({ stateId, path, checksum }) => ({ stateId, path, checksum }));
  if (document.approvedContent.title !== revision.title || document.approvedContent.markdown !== revision.markdown ||
    JSON.stringify(document.approvedContent.screenshots) !== JSON.stringify(included)) {
    throw new Error("Approved content does not match the recorded revision");
  }
  return revision;
}

export async function renderApprovedExport(revision: DocumentRevision, format: DocumentExportFormat): Promise<string> {
  const included = (revision.screenshotReviews ?? []).filter((item) => item.disposition === "accepted-safe");
  if (format === "markdown" && included.length) {
    throw new Error("Portable Markdown image packaging is unavailable in V1; download HTML for included screenshots");
  }
  let markdown = revision.markdown;
  const images = new Map<string, string>();
  for (const [index, image] of included.entries()) {
    if (image.safety === "known-tenant-information") throw new Error("Unsafe screenshots cannot be exported");
    const bytes = await readFile(image.path);
    if (exportChecksum(bytes) !== image.checksum) throw new Error("Reviewed screenshot checksum changed");
    const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? "image/jpeg" : undefined;
    if (!type) throw new Error("Only reviewed PNG and JPEG screenshots can be embedded");
    const reference = `approved-screenshot-${index + 1}`;
    images.set(reference, `data:${type};base64,${bytes.toString("base64")}`);
    const imageMarkdown = `![Screenshot ${index + 1}](${reference})`;
    const literal = `- ${image.path}`;
    if (markdown.split("\n").some((line) => line.trim() === literal)) {
      markdown = markdown.split("\n").map((line) => line.trim() === literal ? imageMarkdown : line).join("\n");
    } else {
      markdown = `${markdown.trimEnd()}\n\n${imageMarkdown}\n`;
    }
  }
  if (/(?:file:\/\/|\/(?:Users|home|private|tmp|etc|var|Volumes)\/|[A-Za-z]:\\)/i.test(markdown)) {
    throw new Error("Approved content contains a local filesystem path; review the article before export");
  }
  const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
  parser.validateLink = (url) => images.has(url) || /^(?:https?:\/\/|mailto:|#)/i.test(url);
  const tokens = parser.parse(markdown, {});
  const checkTokens = (items: typeof tokens): void => {
    for (const token of items) {
      if (token.type === "image" && !images.has(String(token.attrGet("src") ?? ""))) {
        throw new Error("Only explicitly reviewed screenshots can appear in an export");
      }
      if (token.children) checkTokens(token.children);
    }
  };
  checkTokens(tokens);
  if (format === "markdown") return revision.markdown;
  parser.renderer.rules.image = (items, index) => {
    const token = items[index]!;
    const source = images.get(String(token.attrGet("src") ?? ""));
    if (!source) throw new Error("Unreviewed image reference");
    return `<img src="${source}" alt="${escapeHtml(token.content)}">`;
  };
  const article = parser.renderer.render(tokens, parser.options, {});
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">\n<meta name="referrer" content="no-referrer"><title>${escapeHtml(revision.title)}</title>\n<style>body{margin:0;color:#17202a;background:#fff;font:16px/1.65 system-ui,sans-serif}article{max-width:760px;margin:auto;padding:32px 24px;overflow-wrap:anywhere}h1,h2,h3{line-height:1.25}h1{font-size:30px}h2{font-size:23px}img{display:block;max-width:100%;height:auto}pre{overflow:auto;padding:12px;background:#f4f6f8}a{color:#1769aa}blockquote{border-left:3px solid #d9dee7;margin-left:0;padding-left:16px}@media(max-width:480px){article{padding:20px 16px}}</style></head><body><article>\n${article}</article></body></html>\n`;
}

export function exportFilename(title: string, format: DocumentExportFormat): string {
  const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "") || "document";
  const safe = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug) ? `document-${slug}` : slug;
  return `${safe}.${format === "markdown" ? "md" : "html"}`;
}

export function exportChecksum(body: string | Buffer): string { return createHash("sha256").update(body).digest("hex"); }
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
