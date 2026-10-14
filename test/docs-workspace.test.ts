import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { chromium } from "playwright";
import { afterEach, test } from "node:test";
import { DocsWorkspace, validateDocument, type DocsWorkspaceDocument } from "../src/docs-workspace.js";
import { startDocsWorkspaceServer } from "../src/docs-workspace-server.js";
import { FakeKnowledgeModelProvider, GroundedAiKnowledgeWriter,
  type GroundedKnowledgeWriterOutput } from "../src/grounded-ai-knowledge-writer.js";
import type { KnowledgeEvidencePackage } from "../src/knowledge-base-generator.js";
import type { RuntimeNavigationDiscoveryGraph } from "../src/runtime-discovery.js";
import { assertApprovedExport, exportChecksum, exportFilename, renderApprovedExport, revisionSnapshotChecksum,
  type DocumentExportRecord } from "../src/docs-workspace-export.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

test("serves syntactically valid browser JavaScript with escaped newline block controls", async () => {
  const fixture = await workspaceFixture();
  const running = await startDocsWorkspaceServer({ workspace: fixture.workspace });
  try {
    const response = await fetch(new URL("/workspace.js", running.url));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /javascript/);
    const javascript = await response.text();
    assert.doesNotThrow(() => new Script(javascript, { filename: "/workspace.js" }));
    assert.ok(javascript.includes("insertText(markdown,'\\n\\n')"));
  } finally { await running.close(); }
});

test("lists analyzed features, readiness, objectives, and an empty document state", async () => {
  const fixture = await workspaceFixture();
  assert.deepEqual(await fixture.workspace.listDocuments(), []);
  const features = await fixture.workspace.listFeatures();
  assert.equal(features.length, 1);
  assert.equal(features[0]?.name, "Domain and Email");
  assert.equal(features[0]?.evidenceReady, true);
  assert.equal(features[0]?.procedureReady, true);
  assert.equal(features[0]?.tenantSpecific, true);
  assert.deepEqual(features[0]?.tenantSignals, ["email-address", "tenant-hostname"]);
  assert.equal(features[0]?.sourceRevisions.sourceRevision, "source-revision");
});

test("generates and persists a reviewable document from a frozen evidence package", async () => {
  const fixture = await workspaceFixture();
  const document = await fixture.workspace.generateDocument({ featureId: "feature-mail", objective: "how-to-guide" });
  assert.equal(document.generationStatus, "succeeded");
  assert.equal(document.reviewStatus, "needs-review");
  assert.equal(document.article?.grounding.unsupportedStatements, 0);
  assert.equal(document.screenshotMapping?.summary.mapped, 1);
  assert.equal(document.revisions?.length, 1);
  assert.equal(document.revisions?.[0]?.validation.status, "passed");
  assert.equal(document.auditTrail?.[0]?.action, "generated");
  assert.match(document.evidencePackageChecksum, /^[a-f0-9]{64}$/);
  const persisted = await fixture.workspace.getDocument(document.id);
  assert.deepEqual(persisted, document);
  const frozen = JSON.parse(await readFile(path.join(fixture.data, "documents", document.id,
    "evidence", "evidence-package.json"), "utf8"));
  assert.equal(frozen.id, "package-mail");
  assert.equal(await fixture.workspace.resolveScreenshot(document.id, "state-mail"), fixture.screenshot);
  assert.equal(await fixture.workspace.resolveScreenshot(document.id, "state-other"), undefined);
});

test("rejects unsupported how-to generation and stores safe provider failures", async () => {
  const fixture = await workspaceFixture({ procedureReady: false });
  await assert.rejects(fixture.workspace.generateDocument({ featureId: "feature-mail", objective: "how-to-guide" }),
    /requires evidence for an observed procedure/);
  const failedFixture = await workspaceFixture({ failWriter: true });
  const failed = await failedFixture.workspace.generateDocument({ featureId: "feature-mail", objective: "feature-overview" });
  assert.equal(failed.generationStatus, "failed");
  assert.equal(failed.reviewStatus, "draft");
  assert.equal(failed.failure?.message.includes("secret"), false);
  assert.equal((await failedFixture.workspace.listDocuments()).length, 1);
});

test("validates lifecycle states without automatically approving generation", () => {
  const document = documentFixture();
  assert.doesNotThrow(() => validateDocument(document));
  assert.equal(document.reviewStatus, "draft");
  assert.throws(() => validateDocument({ ...document, generationStatus: "succeeded" }), /require an article/);
});

test("saves immutable revisions and invalidates grounding after substantive edits", async () => {
  const fixture = await workspaceFixture();
  const generated = await fixture.workspace.generateDocument({ featureId: "feature-mail", objective: "how-to-guide" });
  const first = generated.revisions![0]!;
  const saved = await fixture.workspace.saveRevision(generated.id, { expectedRevisionId: first.id,
    title: "Edited Domain and Email", markdown: `${first.markdown}\nThis capability automatically configures every mailbox.\n` });
  assert.equal(saved.revisions?.length, 2);
  assert.equal(saved.revisions?.[0]?.markdown, first.markdown);
  assert.equal(saved.revisions?.[1]?.validation.status, "needs-validation");
  assert.equal(saved.reviewStatus, "draft");
  const validated = await fixture.workspace.validateRevision(saved.id, saved.currentRevisionId!);
  assert.equal(validated.revisions?.[1]?.validation.status, "failed");
  assert.match(validated.revisions?.[1]?.validation.issues[0]?.message ?? "", /not associated/);
  await assert.rejects(fixture.workspace.reviewDocument(validated.id, validated.currentRevisionId!, "approve", true),
    /passing grounding validation/);
});

test("redacts tenant information, revalidates evidence, approves explicitly, and records audit history", async () => {
  const fixture = await workspaceFixture();
  const generated = await fixture.workspace.generateDocument({ featureId: "feature-mail", objective: "how-to-guide" });
  const warning = generated.revisions?.[0]?.tenantWarnings[0]; assert.ok(warning);
  const redacted = await fixture.workspace.redactTenantWarning(generated.id, generated.currentRevisionId!, warning.id,
    "[your support email address]");
  assert.match(redacted.revisions?.at(-1)?.markdown ?? "", /\[your support email address\]/);
  assert.equal(redacted.revisions?.at(-1)?.tenantWarnings.some((item) => item.status === "unresolved"), false);
  const validated = await fixture.workspace.validateRevision(redacted.id, redacted.currentRevisionId!);
  assert.equal(validated.revisions?.at(-1)?.validation.status, "passed");
  await assert.rejects(fixture.workspace.reviewDocument(validated.id, validated.currentRevisionId!, "approve", false),
    /confirmation/);
  await assert.rejects(fixture.workspace.reviewDocument(validated.id, validated.currentRevisionId!, "approve", true),
    /screenshot review/);
  const excluded = await fixture.workspace.reviewScreenshot(validated.id, validated.currentRevisionId!, "state-mail", "excluded");
  const approved = await fixture.workspace.reviewDocument(excluded.id, excluded.currentRevisionId!, "approve", true,
    "Local reviewer");
  assert.equal(approved.reviewStatus, "approved");
  assert.equal(approved.auditTrail?.at(-1)?.action, "approved");
  assert.equal(approved.auditTrail?.at(-1)?.evidencePackageChecksum, approved.evidencePackageChecksum);
  const requested = await fixture.workspace.reviewDocument(approved.id, approved.currentRevisionId!, "request-changes", false);
  assert.equal(requested.reviewStatus, "draft");
});

test("known tenant screenshots require exclusion and preserve image bytes and previous revisions", async () => {
  const fixture = await workspaceFixture();
  const generated = await fixture.workspace.generateDocument({ featureId: "feature-mail", objective: "feature-overview" });
  const before = await readFile(fixture.screenshot);
  assert.equal(generated.revisions?.[0]?.screenshotReviews?.[0]?.safety, "known-tenant-information");
  await assert.rejects(fixture.workspace.reviewScreenshot(generated.id, generated.currentRevisionId!, "state-mail", "accepted-safe"),
    /cannot be accepted as safe/);
  const excluded = await fixture.workspace.reviewScreenshot(generated.id, generated.currentRevisionId!, "state-mail", "excluded");
  assert.equal(excluded.revisions?.at(-1)?.screenshotReviews?.[0]?.disposition, "excluded");
  assert.equal(excluded.revisions?.[0]?.screenshotReviews?.[0]?.disposition, "needs-review");
  assert.equal(excluded.articleMarkdown?.includes(fixture.screenshot), false);
  assert.deepEqual(await readFile(fixture.screenshot), before);
  const redacted = await fixture.workspace.redactTenantWarning(excluded.id, excluded.currentRevisionId!,
    excluded.revisions!.at(-1)!.tenantWarnings[0]!.id, "[your support email address]");
  const validated = await fixture.workspace.validateRevision(redacted.id, redacted.currentRevisionId!);
  const approved = await fixture.workspace.reviewDocument(validated.id, validated.currentRevisionId!, "approve", true);
  assert.deepEqual(approved.approvedContent?.screenshots, []);
});

test("screenshots without tenant signals remain unknown and require explicit review; changes invalidate the disposition", async () => {
  // Use a separate fixture with no tenant values; absence of matches must not imply image safety.
  const cleanFixture = await workspaceFixture({ tenantText: "A support mailbox is visible." });
  const clean = await cleanFixture.workspace.generateDocument({ featureId: "feature-mail", objective: "feature-overview" });
  assert.equal(clean.revisions?.[0]?.screenshotReviews?.[0]?.safety, "unknown");
  await assert.rejects(cleanFixture.workspace.reviewDocument(clean.id, clean.currentRevisionId!, "approve", true), /screenshot review/);
  const accepted = await cleanFixture.workspace.reviewScreenshot(clean.id, clean.currentRevisionId!, "state-mail", "accepted-safe");
  const approved = await cleanFixture.workspace.reviewDocument(accepted.id, accepted.currentRevisionId!, "approve", true);
  assert.equal(approved.approvedContent?.screenshots.length, 1);
  await writeFile(cleanFixture.screenshot, Buffer.from("changed-image"));
  const changed = await cleanFixture.workspace.getDocument(clean.id);
  assert.equal(changed?.reviewStatus, "needs-review");
  assert.equal(changed?.revisions?.at(-1)?.screenshotReviews?.[0]?.disposition, "needs-review");
});

test("reviewer can cite an eligible frozen tenant claim absent from the original article, redact it, and revalidate", async () => {
  const fixture = await workspaceFixture({ writerTenantText: "A support mailbox is visible." });
  const generated = await fixture.workspace.generateDocument({ featureId: "feature-mail", objective: "feature-overview" });
  const edited = await fixture.workspace.saveRevision(generated.id, { expectedRevisionId: generated.currentRevisionId!,
    title: generated.title, markdown: `${generated.articleMarkdown}\n\n- support@tenant.superops.ai is visible.\n` });
  const validated = await fixture.workspace.validateRevision(edited.id, edited.currentRevisionId!);
  assert.equal(validated.revisions?.at(-1)?.validation.status, "passed");
  assert.equal(validated.revisions?.at(-1)?.tenantWarnings.length, 1);
  const redacted = await fixture.workspace.redactTenantWarning(validated.id, validated.currentRevisionId!,
    validated.revisions!.at(-1)!.tenantWarnings[0]!.id, "[your support email address]");
  const revalidated = await fixture.workspace.validateRevision(redacted.id, redacted.currentRevisionId!);
  assert.equal(revalidated.revisions?.at(-1)?.validation.status, "passed");
});

test("browser editor exposes save states, preserves failed edits, and fits a 390 x 844 viewport", async () => {
  const fixture = await workspaceFixture();
  const generated = await fixture.workspace.generateDocument({ featureId: "feature-mail", objective: "feature-overview" });
  const running = await startDocsWorkspaceServer({ workspace: fixture.workspace });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(new URL(`/docs/${generated.id}`, running.url).href);
    await page.locator("#save-status").waitFor();
    assert.equal(await page.locator("#save-status").innerText(), "Saved");
    await page.locator("#markdown").fill(`${generated.articleMarkdown}\n## ${"LongHeading".repeat(60)}\n`);
    assert.equal(await page.locator("#save-status").innerText(), "Unsaved changes");
    const measure = () => page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.deepEqual(await measure(), { width: 390, scrollWidth: 390 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/revisions", async (route) => { await gate; await route.continue(); });
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    assert.equal(await page.locator("#save-status").innerText(), "Saving");
    release();
    await page.waitForFunction(() => document.querySelector("#save-status")?.textContent === "Saved");
    await page.unroute("**/revisions");
    await page.getByLabel("Title", { exact: true }).fill("");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#save-status")?.textContent === "Save failed");
    assert.match(await page.locator("#save-error").innerText(), /Title and Markdown/);
    assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), "");
    assert.equal(await page.getByRole("button", { name: "Approve", exact: true }).isEnabled(), false);
    assert.deepEqual(await measure(), { width: 390, scrollWidth: 390 });
    for (const name of ["Save draft", "Request changes", "Revalidate", "Approve"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
    }
  } finally { await browser.close(); await running.close(); }
});

test("rejects stale revision updates deterministically", async () => {
  const fixture = await workspaceFixture();
  const generated = await fixture.workspace.generateDocument({ featureId: "feature-mail", objective: "feature-overview" });
  const stale = generated.currentRevisionId!;
  await fixture.workspace.saveRevision(generated.id, { expectedRevisionId: stale, title: generated.title,
    markdown: `${generated.articleMarkdown}\n## Reviewer note\n` });
  await assert.rejects(fixture.workspace.saveRevision(generated.id, { expectedRevisionId: stale, title: generated.title,
    markdown: generated.articleMarkdown! }), /newer revision/);
});

test("serves workspace routes, protects APIs, persists generation, and allowlists screenshots", async () => {
  const fixture = await workspaceFixture();
  const running = await startDocsWorkspaceServer({ workspace: fixture.workspace });
  try {
    assert.equal((await fetch(`${running.url.replace("/docs", "")}/api/features`)).status, 401);
    const page = await fetch(running.url);
    assert.equal(page.status, 200);
    const html = await page.text(); assert.match(html, /Docs Workspace/);
    const cookie = page.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie);
    const csrf = /name="docs-workspace-csrf" content="([a-f0-9]+)"/.exec(html)?.[1]; assert.ok(csrf);
    const headers = { cookie, "content-type": "application/json", "x-docs-csrf": csrf };
    const features = await fetch(`${running.url.replace("/docs", "")}/api/features`, { headers });
    assert.equal((await features.json() as unknown[]).length, 1);
    const created = await fetch(`${running.url.replace("/docs", "")}/api/documents/generate`, {
      method: "POST", headers, body: JSON.stringify({ featureId: "feature-mail", objective: "feature-overview" }),
    });
    assert.equal(created.status, 201);
    const document = await created.json() as DocsWorkspaceDocument;
    const screenshot = await fetch(`${running.url.replace("/docs", "")}/api/documents/${document.id}/screenshots/state-mail`,
      { headers });
    assert.equal(screenshot.status, 200);
    assert.equal(screenshot.headers.get("content-type"), "image/png");
    assert.equal((await fetch(`${running.url.replace("/docs", "")}/api/documents/${document.id}/screenshots/state-other`,
      { headers })).status, 404);
    const noCsrf = await fetch(`${running.url.replace("/docs", "")}/api/documents/${document.id}/validate`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevisionId: document.currentRevisionId }),
    });
    assert.equal(noCsrf.status, 403);
    const crossSite = await fetch(`${running.url.replace("/docs", "")}/api/documents/${document.id}/validate`, {
      method: "POST", headers: { ...headers, origin: "https://attacker.example" },
      body: JSON.stringify({ expectedRevisionId: document.currentRevisionId }),
    });
    assert.equal(crossSite.status, 403);
  } finally { await running.close(); }
});

test("exports the exact approved Markdown and standalone HTML with separate provenance and unchanged source files", async () => {
  const fixture = await approvedWorkspaceFixture();
  const file = path.join(fixture.data, "documents", fixture.document.id, "document.json");
  const before = await readFile(file, "utf8");
  const evidencePath = path.join(fixture.data, "documents", fixture.document.id, "evidence", "evidence-package.json");
  const evidenceBefore = await readFile(evidencePath, "utf8");
  const markdown = await fixture.workspace.exportDocument(fixture.document.id, fixture.document.currentRevisionId!, "markdown");
  const html = await fixture.workspace.exportDocument(fixture.document.id, fixture.document.currentRevisionId!, "html");
  assert.equal(markdown.body, fixture.document.revisions!.at(-1)!.markdown);
  assert.match(markdown.body, /\[your support email address\]/);
  assert.doesNotMatch(markdown.body, /support@tenant|\.png|\/Users\//);
  assert.match(html.body, /<!doctype html>/);
  assert.match(html.body, /<article>/);
  assert.match(html.body, /<h1>Domain and Email<\/h1>/);
  assert.doesNotMatch(html.body, /<script|<img|\/Users\/|Workspace|runtime-state:/);
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal(await readFile(evidencePath, "utf8"), evidenceBefore);
  const directory = path.join(fixture.data, "documents", fixture.document.id, "exports");
  const records = await Promise.all((await readdir(directory)).map(async (name) =>
    JSON.parse(await readFile(path.join(directory, name), "utf8")) as DocumentExportRecord));
  assert.equal(records.length, 2);
  assert.equal(markdown.record.documentId, fixture.document.id);
  assert.equal(markdown.record.revisionId, fixture.document.currentRevisionId);
  assert.equal(markdown.record.resultChecksum, exportChecksum(markdown.body));
  assert.equal(html.record.resultChecksum, exportChecksum(html.body));
  assert.equal(markdown.record.evidencePackageChecksum, fixture.document.evidencePackageChecksum);
  assert.equal(markdown.record.revisionChecksum, fixture.document.revisions!.at(-1)!.checksum);
  assert.equal(markdown.record.exportedAt, "2026-10-13T10:00:00.000Z");
  assert.deepEqual(await fixture.workspace.exportAvailability(fixture.document.id),
    { markdown: { available: true }, html: { available: true } });
  const repeated = await fixture.workspace.exportDocument(fixture.document.id, fixture.document.currentRevisionId!, "html");
  assert.equal(repeated.body, html.body);
  assert.equal(repeated.record.resultChecksum, html.record.resultChecksum);
  assert.notEqual(repeated.record.id, html.record.id);
});

test("rejects draft, revalidation-required, unsupported, tenant-warning, and unapproved revision exports", async () => {
  const fixture = await approvedWorkspaceFixture();
  await assert.rejects(fixture.workspace.exportDocument(fixture.document.id, fixture.document.revisions![0]!.id, "markdown"),
    /requested revision/);
  const document = fixture.document;
  const revision = document.revisions!.at(-1)!;
  const invalid = (change: (copy: DocsWorkspaceDocument) => void) => {
    const copy = structuredClone(document);
    change(copy);
    return copy;
  };
  assert.throws(() => assertApprovedExport(invalid((copy) => { copy.reviewStatus = "draft"; }), revision.id), /approved document/);
  for (const mutation of [
    (copy: DocsWorkspaceDocument) => { copy.revisions!.at(-1)!.validation.status = "needs-validation"; },
    (copy: DocsWorkspaceDocument) => { copy.revisions!.at(-1)!.validation.unsupportedStatements = 1; },
    (copy: DocsWorkspaceDocument) => { copy.revisions!.at(-1)!.tenantWarnings.push({ id: "warning", type: "email-address",
      blockIndex: 0, maskedValue: "s***@***.test", status: "unresolved" }); },
  ]) {
    const copy = invalid(mutation);
    // Even when a fixture pins the altered snapshot, each independent eligibility gate must reject it.
    copy.auditTrail!.at(-1)!.revisionSnapshotChecksum = revisionSnapshotChecksum(copy.revisions!.at(-1)!);
    assert.throws(() => assertApprovedExport(copy, revision.id), /grounding|Tenant information/);
  }
  const saved = await fixture.workspace.saveRevision(document.id, { expectedRevisionId: revision.id, title: document.title,
    markdown: `${revision.markdown}\nSuperOps configures all DNS records automatically.\n` });
  await assert.rejects(fixture.workspace.exportDocument(saved.id, saved.currentRevisionId!, "html"), /approved document/);
  const validated = await fixture.workspace.validateRevision(saved.id, saved.currentRevisionId!);
  assert.equal(validated.revisions!.at(-1)!.validation.status, "failed");
  await assert.rejects(fixture.workspace.exportDocument(saved.id, revision.id, "html"), /approved document/);
});

test("rejects changed approval integrity, frozen evidence, and legacy approval without export checks", async () => {
  const fixture = await approvedWorkspaceFixture();
  const document = fixture.document;
  const revision = document.revisions!.at(-1)!;
  const altered = structuredClone(document);
  altered.revisions!.at(-1)!.markdown += "\nInjected behavior.\n";
  assert.throws(() => assertApprovedExport(altered, revision.id), /integrity/);
  const legacy = structuredClone(document);
  delete legacy.auditTrail!.at(-1)!.revisionChecksum;
  assert.throws(() => assertApprovedExport(legacy, revision.id), /Approve this revision again/);
  const evidencePath = path.join(fixture.data, "documents", document.id, "evidence", "evidence-package.json");
  await writeFile(evidencePath, "{}\n");
  await assert.rejects(fixture.workspace.exportDocument(document.id, revision.id, "markdown"), /checksum mismatch/);
});

test("embeds only safely reviewed PNG images in HTML and reports Markdown packaging limitation", async () => {
  const fixture = await approvedWorkspaceFixture(true);
  const html = await fixture.workspace.exportDocument(fixture.document.id, fixture.document.currentRevisionId!, "html");
  assert.match(html.body, /<img src="data:image\/png;base64,/);
  assert.doesNotMatch(html.body, /<img[^>]+src="https?:|file:\/\/|\/tmp\//);
  await assert.rejects(fixture.workspace.exportDocument(fixture.document.id, fixture.document.currentRevisionId!, "markdown"),
    /Portable Markdown image packaging/);
  const availability = await fixture.workspace.exportAvailability(fixture.document.id);
  assert.equal(availability.html.available, true);
  assert.equal(availability.markdown.available, false);
  assert.match(availability.markdown.reason ?? "", /download HTML/);
  const unsafe = structuredClone(fixture.document);
  unsafe.revisions!.at(-1)!.screenshotReviews![0]!.safety = "known-tenant-information";
  unsafe.revisions!.at(-1)!.checksum = exportChecksum(JSON.stringify({ title: unsafe.revisions!.at(-1)!.title,
    markdown: unsafe.revisions!.at(-1)!.markdown, screenshots: unsafe.revisions!.at(-1)!.screenshotReviews }));
  unsafe.auditTrail!.at(-1)!.revisionChecksum = unsafe.revisions!.at(-1)!.checksum;
  unsafe.auditTrail!.at(-1)!.revisionSnapshotChecksum = revisionSnapshotChecksum(unsafe.revisions!.at(-1)!);
  assert.throws(() => assertApprovedExport(unsafe, unsafe.currentRevisionId!), /unsafe review/);
});

test("escapes HTML injections, preserves semantic Markdown, and sanitizes export filenames", async () => {
  const fixture = await approvedWorkspaceFixture();
  const revision = structuredClone(fixture.document.revisions!.at(-1)!);
  revision.title = '<script>alert("title")</script>';
  revision.markdown = '# Example\n\n<script>alert("body")</script>\n\n<img src=x onerror=alert(1)>\n\n- First\n- Second\n\n1. One\n2. Two\n\n[Safe link](https://example.test/docs)\n\n[Unsafe link](javascript:alert(1))\n';
  const html = await renderApprovedExport(revision, "html");
  assert.doesNotMatch(html, /<script|<img|href="javascript:|onerror="/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<ul>/);
  assert.match(html, /<ol>/);
  assert.match(html, /href="https:\/\/example.test\/docs"/);
  assert.match(html, /default-src 'none'/);
  revision.markdown = '# Example\n\n![Unreviewed](https://example.test/leak.png)\n';
  await assert.rejects(renderApprovedExport(revision, "html"), /reviewed screenshots/);
  revision.markdown = '# Example\n\n/Users/person/private-note.md\n';
  await assert.rejects(renderApprovedExport(revision, "markdown"), /local filesystem path/);
  assert.equal(exportFilename('../../Domain and Email\r\n"', "markdown"), "domain-and-email.md");
  assert.equal(exportFilename("CON", "html"), "document-con.html");
  assert.equal(exportFilename("...", "html"), "document.html");
});

test("export endpoints require a local session and explicit revision and serve safe attachments", async () => {
  const fixture = await approvedWorkspaceFixture();
  const running = await startDocsWorkspaceServer({ workspace: fixture.workspace });
  try {
    const endpoint = new URL(`/api/documents/${fixture.document.id}/exports/markdown`, running.url);
    endpoint.searchParams.set("revisionId", fixture.document.currentRevisionId!);
    assert.equal((await fetch(endpoint)).status, 401);
    const page = await fetch(running.url);
    const cookie = page.headers.get("set-cookie")!.split(";")[0]!;
    const response = await fetch(endpoint, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="domain-and-email.md"$/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const body = await response.text();
    assert.equal(response.headers.get("x-export-checksum"), exportChecksum(body));
    endpoint.searchParams.delete("revisionId");
    assert.equal((await fetch(endpoint, { headers: { cookie } })).status, 400);
  } finally { await running.close(); }
});

async function approvedWorkspaceFixture(includeImage = false) {
  const fixture = await workspaceFixture(includeImage ? { tenantText: "A support mailbox is visible." } : {});
  let document = await fixture.workspace.generateDocument({ featureId: "feature-mail", objective: "feature-overview" });
  if (!includeImage) {
    document = await fixture.workspace.redactTenantWarning(document.id, document.currentRevisionId!,
      document.revisions!.at(-1)!.tenantWarnings[0]!.id, "[your support email address]");
    document = await fixture.workspace.validateRevision(document.id, document.currentRevisionId!);
  }
  document = await fixture.workspace.reviewScreenshot(document.id, document.currentRevisionId!, "state-mail",
    includeImage ? "accepted-safe" : "excluded");
  document = await fixture.workspace.reviewDocument(document.id, document.currentRevisionId!, "approve", true);
  return { ...fixture, document };
}

async function workspaceFixture(options: { procedureReady?: boolean; failWriter?: boolean; tenantText?: string; writerTenantText?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "docs-workspace-")); directories.push(root);
  const evidence = path.join(root, "acceptance", "run", "evidence"); const data = path.join(root, "data");
  await mkdir(evidence, { recursive: true });
  const screenshot = path.join(root, "mail.png"); await writeFile(screenshot,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhXsAAAAASUVORK5CYII=", "base64"));
  const package_ = evidencePackage(screenshot, options.procedureReady !== false);
  if (options.tenantText) package_.claims.find((item) => item.id === "tenant")!.text = options.tenantText;
  await writeFile(path.join(evidence, "evidence-package.json"), `${JSON.stringify(package_, null, 2)}\n`);
  await writeFile(path.join(evidence, "runtime-discovery.json"), `${JSON.stringify(runtime(screenshot), null, 2)}\n`);
  await writeFile(path.join(root, "acceptance", "run", "baseline.json"),
    JSON.stringify({ sourceRevision: "source-revision", engineRevision: "engine-revision" }));
  const workspace = new DocsWorkspace({ evidenceRoot: path.join(root, "acceptance"), dataDirectory: data,
    now: () => new Date("2026-10-13T10:00:00.000Z"), writerFactory: ({ objective, articleMode }) =>
      new GroundedAiKnowledgeWriter({ objective, ...(articleMode ? { articleMode } : {}),
        provider: new FakeKnowledgeModelProvider("test", "test-model", options.failWriter
          ? [{ secret: "provider-secret" }, { secret: "provider-secret" }]
          : [{ output: writerOutput(options.procedureReady !== false, options.writerTenantText ?? options.tenantText) }]) }) });
  return { root, data, screenshot, workspace };
}

function evidencePackage(screenshot: string, procedureReady: boolean): KnowledgeEvidencePackage {
  const support = (target = false) => ({ featureId: "feature-mail", staticNodeIds: [], runtimeStateIds: ["state-mail"],
    runtimeElementIds: target ? ["element-add"] : [], reconciliationIds: [], contractEvidenceIds: [],
    contractReconciliationIds: [], runtimeTransitionIds: target && procedureReady ? ["transition-add"] : [], visualTargets: target
      ? [{ stateId: "state-mail", targetId: "element-add", targetType: "semantic-element" as const }] : [] });
  const claims: KnowledgeEvidencePackage["claims"] = [
    { id: "name", kind: "feature-name", text: "Domain and Email", status: "corroborated", customerVisible: true,
      publishable: true, support: support() },
    { id: "action", kind: "user-action", text: "Add new mailbox is available.", instruction: "Select Add new mailbox.",
      status: "runtime-only", customerVisible: true, publishable: true, support: support(true) },
    { id: "tenant", kind: "visible-ui", text: "support@tenant.superops.ai is visible.", status: "runtime-only",
      customerVisible: true, publishable: true, support: support() },
  ];
  if (procedureReady) claims.push({ id: "outcome", kind: "visible-outcome", text: "Mailbox options are visible.",
    status: "runtime-only", customerVisible: true, publishable: true, support: support() });
  return { id: "package-mail", feature: { id: "feature-mail", name: "Domain and Email", routes: ["/mail"],
    entryPoints: [{ label: "Domain and Email", destination: "#/mail" }] }, claims, internalEvidence: [],
    screenshots: [{ runtimeStateId: "state-mail", path: screenshot, purpose: "feature-state", evidenceRefs: ["state-mail"] }],
    limitations: [{ id: "limited", type: "bounded-runtime", message: "Runtime evidence is bounded.", evidenceRefs: ["state-mail"] }],
    provenance: ["state-mail"], policy: { allowRuntimeOnly: true, allowStaticOnly: false } };
}

function writerOutput(procedureReady: boolean, tenantText?: string): GroundedKnowledgeWriterOutput {
  const selected = ["name", "action", "tenant", ...(procedureReady ? ["outcome"] : [])];
  return { title: "Domain and Email", titleClaimIds: ["name"], articleType: procedureReady ? "procedure" : "overview",
    summary: { text: "Review Domain and Email mailbox options.", claimIds: ["name"] }, prerequisites: [],
    steps: [{ text: "Select Add new mailbox.", claimIds: ["action"] }],
    ...(procedureReady ? { expectedResult: { text: "Mailbox options are visible.", claimIds: ["outcome"] } } : {}),
    notes: [{ text: tenantText ?? "support@tenant.superops.ai is visible.", claimIds: ["tenant"] }],
    limitations: [{ text: "Runtime evidence is bounded.", claimIds: ["name"] }],
    claimSelection: { selectedClaims: selected.map((claimId) => ({ claimId, relevance: "task-relevant" as const,
      reason: "Supports this document" })), contextClaims: [], excludedClaims: [], duplicatesRemoved: [] },
    articlePlan: { titleClaimIds: ["name"], summaryClaimIds: ["name"], prerequisiteClaimIds: [], navigationClaimIds: [],
      stepGroups: [{ claimIds: ["action"] }], expectedResultClaimIds: procedureReady ? ["outcome"] : [],
      noteClaimIds: ["tenant"], limitationClaimIds: ["name"] },
    screenshotIntents: [{ stepIndex: 0, claimIds: ["action"], reason: "Show the observed action" }] };
}

function runtime(screenshot: string): RuntimeNavigationDiscoveryGraph {
  return { startUrl: "https://example.test", startOrigin: "https://example.test",
    allowedOrigins: ["https://example.test"],
    limits: { maxDepth: 1, maxStates: 1, maxTransitions: 1, maxTargetsPerState: 1 },
    nodes: [{ id: "state-mail", fingerprint: "fingerprint", url: "https://example.test/#/mail", title: "Mail", depth: 0,
      boundary: false, expandable: false, stopReasons: ["max-depth"], screenshot: { path: screenshot, width: 100, height: 100,
        fullPage: false, captured: true, provenance: "screenshot" }, readiness: { status: "ready", reason: "semantic-ui", timeoutMs: 100 },
      semanticElements: [{ id: "element-add", type: "button", role: "button", accessibleName: "Add new mailbox",
        domPath: "button", visible: true, enabled: true, boundingBox: { x: 10, y: 10, width: 20, height: 20 },
        provenance: ["dom", "accessibility"] }], interactionCandidates: [], accessibility: {
        format: "playwright-aria-snapshot-v1", snapshot: "", provenance: "accessibility" },
      visibleText: [{ id: "text-mail", text: "Domain and Email", domPath: "main", provenance: "dom" }],
      runtimeCaptureId: "capture-mail",
      network: [], networkObservations: [], provenance: "runtime-capture" }], transitions: [], skippedTargets: [],
    stopReasons: ["max-depth"], summary: { statesDiscovered: 1, transitionsObserved: 0, failedTransitions: 0,
      targetsSkipped: 0, blocked: 0, unknown: 0, boundaryStates: 0, mutationStopBranches: 0, maxDepthReached: 0 } };
}

function documentFixture(): DocsWorkspaceDocument {
  return { id: "document-00000000-0000-4000-8000-000000000000", title: "Draft", featureId: "feature-mail",
    featureName: "Domain and Email", objective: "feature-overview", generationStatus: "generating", reviewStatus: "draft",
    createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z", evidencePackageId: "package-mail",
    evidencePackageChecksum: "a".repeat(64), sourceRevisions: {}, tenantSpecific: false, tenantSignals: [] };
}
