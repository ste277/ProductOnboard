import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GroundedAiKnowledgeWriter,
  type GroundedKnowledgeWriterOptions,
} from "./grounded-ai-knowledge-writer.js";
import {
  formatKnowledgeBaseArticle,
  type KnowledgeBaseArticle,
  type KnowledgeEvidencePackage,
} from "./knowledge-base-generator.js";
import { runKnowledgeWriterHarness } from "./knowledge-writer-harness.js";
import type { RuntimeNavigationDiscoveryGraph } from "./runtime-discovery.js";
import type { ScreenshotStepMapping } from "./screenshot-step-mapping.js";
import { assertApprovedExport, exportChecksum, exportFilename, renderApprovedExport, revisionSnapshotChecksum,
  type DocumentExport, type DocumentExportFormat, type DocumentExportRecord, type ExportAvailability } from "./docs-workspace-export.js";

export type DocsWorkspaceObjective = "feature-overview" | "how-to-guide";
export type DocumentGenerationStatus = "generating" | "succeeded" | "failed";
export type DocumentReviewStatus = "draft" | "needs-review" | "approved";
export type RevisionValidationStatus = "needs-validation" | "passed" | "failed";
export type ReviewAction = "generated" | "saved" | "validated" | "changes-requested" | "approved" | "tenant-redacted" | "screenshot-reviewed";

export interface ScreenshotReview {
  stateId: string;
  path: string;
  checksum: string;
  safety: "known-tenant-information" | "unknown";
  tenantSignals: TenantSignal[];
  evidenceRefs: string[];
  disposition: "needs-review" | "accepted-safe" | "excluded";
  reviewer?: string;
  reviewedAt?: string;
}

export interface DocsWorkspaceFeature {
  id: string;
  name: string;
  evidencePackageId: string;
  evidencePackageChecksum: string;
  claimCount: number;
  publishableClaimCount: number;
  screenshotCount: number;
  limitationCount: number;
  evidenceReady: boolean;
  procedureReady: boolean;
  tenantSpecific: boolean;
  tenantSignals: TenantSignal[];
  sourceRevisions: Record<string, string>;
}

export type TenantSignal = "email-address" | "tenant-hostname" | "customer-identifier";

export interface RevisionEvidenceAssociation {
  blockIndex: number;
  text: string;
  claimIds: string[];
  evidenceRefs: string[];
  status: "valid" | "invalid";
}

export interface RevisionValidationIssue {
  type: "unsupported-statement" | "ambiguous-statement" | "uncited-statement";
  blockIndex: number;
  text: string;
  message: string;
}

export interface TenantDataWarning {
  id: string;
  type: TenantSignal;
  blockIndex: number;
  maskedValue: string;
  status: "unresolved" | "redacted";
  placeholder?: string;
}

export interface DocumentRevision {
  id: string;
  number: number;
  createdAt: string;
  reviewer: string;
  title: string;
  markdown: string;
  checksum: string;
  validation: {
    status: RevisionValidationStatus;
    validatedAt?: string;
    supportedStatements: number;
    unsupportedStatements: number;
    issues: RevisionValidationIssue[];
  };
  evidenceAssociations: RevisionEvidenceAssociation[];
  tenantWarnings: TenantDataWarning[];
  screenshotReviews?: ScreenshotReview[];
}

export interface DocumentAuditEntry {
  id: string;
  revisionId: string;
  action: ReviewAction;
  timestamp: string;
  reviewer: string;
  validationStatus: RevisionValidationStatus;
  evidencePackageChecksum: string;
  revisionChecksum?: string;
  revisionSnapshotChecksum?: string;
}

export interface DocsWorkspaceDocument {
  id: string;
  title: string;
  featureId: string;
  featureName: string;
  objective: DocsWorkspaceObjective;
  generationStatus: DocumentGenerationStatus;
  reviewStatus: DocumentReviewStatus;
  createdAt: string;
  updatedAt: string;
  evidencePackageId: string;
  evidencePackageChecksum: string;
  sourceRevisions: Record<string, string>;
  tenantSpecific: boolean;
  tenantSignals: TenantSignal[];
  article?: KnowledgeBaseArticle;
  articleMarkdown?: string;
  screenshotMapping?: ScreenshotStepMapping;
  currentRevisionId?: string;
  revisions?: DocumentRevision[];
  auditTrail?: DocumentAuditEntry[];
  approvedContent?: { revisionId: string; title: string; markdown: string; evidencePackageChecksum: string;
    screenshots: Array<{ stateId: string; path: string; checksum: string }> };
  failure?: { classification: "generation-failed"; message: string };
}

export interface GenerateDocsWorkspaceDocumentInput {
  featureId: string;
  objective: DocsWorkspaceObjective;
}

export interface SaveDocumentRevisionInput {
  expectedRevisionId: string;
  title: string;
  markdown: string;
  reviewer?: string;
}

export interface DocsWorkspaceOptions {
  evidenceRoot: string;
  dataDirectory: string;
  writerFactory: (options: Pick<GroundedKnowledgeWriterOptions, "objective" | "articleMode">) => GroundedAiKnowledgeWriter;
  now?: () => Date;
}

interface CatalogEntry {
  feature: DocsWorkspaceFeature;
  packagePath: string;
  runtimePath?: string;
  evidencePackage: KnowledgeEvidencePackage;
}

export class DocsWorkspace {
  private readonly now: () => Date;

  constructor(private readonly options: DocsWorkspaceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async listFeatures(): Promise<DocsWorkspaceFeature[]> {
    return (await this.catalog()).map((item) => structuredClone(item.feature));
  }

  async listDocuments(): Promise<DocsWorkspaceDocument[]> {
    const directory = this.documentsDirectory();
    await mkdir(directory, { recursive: true });
    const entries = await readdir(directory, { withFileTypes: true });
    const documents: DocsWorkspaceDocument[] = [];
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      try { documents.push(await this.readDocument(entry.name)); } catch { continue; }
    }
    return documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  async getDocument(id: string): Promise<DocsWorkspaceDocument | undefined> {
    if (!validDocumentId(id)) return undefined;
    try { return await this.readDocument(id); } catch { return undefined; }
  }

  async generateDocument(input: GenerateDocsWorkspaceDocumentInput): Promise<DocsWorkspaceDocument> {
    const catalog = await this.catalog();
    const selected = catalog.find((item) => item.feature.id === input.featureId);
    if (!selected) throw new Error("Selected feature is unavailable");
    if (!selected.feature.evidenceReady) throw new Error("Selected feature does not have generation-ready evidence");
    if (input.objective === "how-to-guide" && !selected.feature.procedureReady) {
      throw new Error("How-to guide requires evidence for an observed procedure");
    }
    const id = `document-${randomUUID()}`;
    const timestamp = this.now().toISOString();
    const document: DocsWorkspaceDocument = {
      id, title: `${selected.feature.name} ${input.objective === "feature-overview" ? "overview" : "guide"}`,
      featureId: selected.feature.id, featureName: selected.feature.name, objective: input.objective,
      generationStatus: "generating", reviewStatus: "draft", createdAt: timestamp, updatedAt: timestamp,
      evidencePackageId: selected.feature.evidencePackageId,
      evidencePackageChecksum: selected.feature.evidencePackageChecksum,
      sourceRevisions: structuredClone(selected.feature.sourceRevisions), tenantSpecific: selected.feature.tenantSpecific,
      tenantSignals: [...selected.feature.tenantSignals],
    };
    await this.persistDocument(document);
    await this.freezeEvidence(document.id, selected);
    try {
      const checksum = checksumText(await readFile(selected.packagePath, "utf8"));
      if (checksum !== document.evidencePackageChecksum) throw new Error("Evidence package changed during generation");
      const runtime = selected.runtimePath
        ? JSON.parse(await readFile(selected.runtimePath, "utf8")) as RuntimeNavigationDiscoveryGraph
        : undefined;
      const writer = this.options.writerFactory({ objective: objectiveText(input.objective, selected.feature.name),
        articleMode: input.objective === "feature-overview" ? "overview" : "procedure" });
      const result = await runKnowledgeWriterHarness({ evidencePackage: selected.evidencePackage, writer,
        outputDirectory: path.join(this.documentDirectory(document.id), "generation"),
        generatedAt: timestamp, ...(runtime ? { runtimeDiscovery: runtime } : {}) });
      document.title = result.article.title;
      document.generationStatus = "succeeded";
      document.reviewStatus = "needs-review";
      document.article = result.article;
      document.articleMarkdown = formatKnowledgeBaseArticle(result.article, false);
      if (result.screenshotMapping) document.screenshotMapping = result.screenshotMapping;
      const revision = initialRevision(document.articleMarkdown, document.title, timestamp, "AI generation", result.article);
      revision.screenshotReviews = await screenshotReviews(selected.evidencePackage);
      document.currentRevisionId = revision.id;
      document.revisions = [revision];
      document.auditTrail = [auditEntry(document, revision, "generated", timestamp, "AI generation")];
      await this.persistRevision(document.id, revision);
    } catch (error) {
      document.generationStatus = "failed";
      document.reviewStatus = "draft";
      document.failure = { classification: "generation-failed",
        message: safeFailureMessage(error) };
    }
    document.updatedAt = this.now().toISOString();
    await this.persistDocument(document);
    return structuredClone(document);
  }

  async resolveScreenshot(documentId: string, stateId: string): Promise<string | undefined> {
    const document = await this.getDocument(documentId);
    if (!document?.article || !document.screenshotMapping) return undefined;
    const screenshot = document.article.screenshots.find((item) => item.runtimeStateId === stateId);
    if (!screenshot) return undefined;
    const mappingAllows = document.screenshotMapping.annotationSets.some((item) =>
      item.stateId === stateId && item.screenshotPath === screenshot.path);
    if (!mappingAllows) return undefined;
    try { return (await stat(screenshot.path)).isFile() ? screenshot.path : undefined; } catch { return undefined; }
  }

  async saveRevision(documentId: string, input: SaveDocumentRevisionInput): Promise<DocsWorkspaceDocument> {
    const document = await this.requireDocument(documentId);
    assertCurrentRevision(document, input.expectedRevisionId);
    const markdown = normalizeMarkdown(input.markdown);
    const title = input.title.trim();
    if (!title || !markdown) throw new Error("Title and Markdown content are required");
    const previous = currentRevision(document);
    if (previous.title === title && previous.markdown === markdown) return document;
    const timestamp = this.now().toISOString();
    const reviewer = safeReviewer(input.reviewer);
    const revision: DocumentRevision = {
      id: `revision-${randomUUID()}`, number: previous.number + 1, createdAt: timestamp, reviewer, title, markdown,
      checksum: checksumText(`${title}\n${markdown}`),
      validation: { status: "needs-validation", supportedStatements: 0, unsupportedStatements: 0, issues: [] },
      evidenceAssociations: [], tenantWarnings: detectTenantWarnings(markdown),
      screenshotReviews: structuredClone(previous.screenshotReviews ?? []).map((item) =>
        item.disposition === "excluded" && markdown.includes(item.path)
          ? { ...item, disposition: "needs-review" } : item),
    };
    document.title = title;
    document.articleMarkdown = markdown;
    document.reviewStatus = "draft";
    delete document.approvedContent;
    document.updatedAt = timestamp;
    document.currentRevisionId = revision.id;
    document.revisions = [...(document.revisions ?? []), revision];
    document.auditTrail = [...(document.auditTrail ?? []), auditEntry(document, revision, "saved", timestamp, reviewer)];
    await this.persistRevision(document.id, revision);
    await this.persistDocument(document);
    return structuredClone(document);
  }

  async validateRevision(documentId: string, expectedRevisionId: string, reviewer?: string): Promise<DocsWorkspaceDocument> {
    const document = await this.requireDocument(documentId);
    assertCurrentRevision(document, expectedRevisionId);
    const revision = currentRevision(document);
    const package_ = await this.readFrozenEvidence(document);
    const result = revalidateMarkdown(revision.markdown, document.article, package_);
    const timestamp = this.now().toISOString();
    revision.validation = { status: result.issues.length ? "failed" : "passed", validatedAt: timestamp,
      supportedStatements: result.supportedStatements, unsupportedStatements: result.issues.length, issues: result.issues };
    revision.evidenceAssociations = result.associations;
    revision.tenantWarnings = mergeTenantWarnings(revision.tenantWarnings, detectTenantWarnings(revision.markdown));
    document.reviewStatus = "needs-review";
    document.updatedAt = timestamp;
    const actor = safeReviewer(reviewer);
    document.auditTrail = [...(document.auditTrail ?? []), auditEntry(document, revision, "validated", timestamp, actor)];
    await this.persistRevision(document.id, revision);
    await this.persistDocument(document);
    return structuredClone(document);
  }

  async redactTenantWarning(documentId: string, expectedRevisionId: string, warningId: string,
    placeholder: string, reviewer?: string): Promise<DocsWorkspaceDocument> {
    const document = await this.requireDocument(documentId);
    assertCurrentRevision(document, expectedRevisionId);
    const previous = currentRevision(document);
    const warning = previous.tenantWarnings.find((item) => item.id === warningId && item.status === "unresolved");
    if (!warning) throw new Error("Tenant information warning is unavailable");
    if (!/^\[[a-zA-Z][a-zA-Z0-9 -]{2,80}\]$/.test(placeholder)) {
      throw new Error("Use an explicit bracketed placeholder without tenant-specific values");
    }
    const sensitive = sensitiveValues(previous.markdown).find((item) => warningIdFor(item.type, item.value, item.blockIndex) === warning.id);
    if (!sensitive) throw new Error("Tenant information warning no longer matches the document");
    const markdown = replaceOccurrenceInBlock(previous.markdown, sensitive.blockIndex, sensitive.value, placeholder);
    const updated = await this.saveRevision(documentId, { expectedRevisionId, title: previous.title, markdown,
      reviewer: safeReviewer(reviewer) });
    const revision = currentRevision(updated);
    revision.tenantWarnings = [...revision.tenantWarnings, { ...warning, status: "redacted", placeholder }];
    const timestamp = this.now().toISOString();
    updated.auditTrail = [...(updated.auditTrail ?? []), auditEntry(updated, revision, "tenant-redacted", timestamp,
      safeReviewer(reviewer))];
    await this.persistRevision(updated.id, revision);
    await this.persistDocument(updated);
    return structuredClone(updated);
  }

  async reviewDocument(documentId: string, expectedRevisionId: string, action: "request-changes" | "approve",
    confirmed: boolean, reviewer?: string): Promise<DocsWorkspaceDocument> {
    const document = await this.requireDocument(documentId);
    assertCurrentRevision(document, expectedRevisionId);
    const revision = currentRevision(document);
    const timestamp = this.now().toISOString();
    const actor = safeReviewer(reviewer);
    if (action === "approve") {
      if (!confirmed) throw new Error("Explicit approval confirmation is required");
      if (revision.validation.status !== "passed" || revision.validation.issues.length) {
        throw new Error("Approval requires a passing grounding validation");
      }
      if (revision.tenantWarnings.some((item) => item.status === "unresolved")) {
        throw new Error("Approval requires all tenant information warnings to be resolved");
      }
      if (!revision.evidenceAssociations.length || revision.evidenceAssociations.some((item) => item.status !== "valid")) {
        throw new Error("Approval requires valid evidence references");
      }
      await this.readFrozenEvidence(document);
      if ((revision.screenshotReviews ?? []).some((item) => item.disposition !== "excluded" &&
        (item.disposition !== "accepted-safe" || item.safety === "known-tenant-information" || item.checksum === "unavailable"))) {
        throw new Error("Approval requires screenshot review; known tenant information must be excluded");
      }
      document.reviewStatus = "approved";
      document.approvedContent = { revisionId: revision.id, title: revision.title, markdown: revision.markdown,
        evidencePackageChecksum: document.evidencePackageChecksum,
        screenshots: (revision.screenshotReviews ?? []).filter((item) => item.disposition === "accepted-safe")
          .map(({ stateId, path: imagePath, checksum }) => ({ stateId, path: imagePath, checksum })) };
      document.auditTrail = [...(document.auditTrail ?? []), auditEntry(document, revision, "approved", timestamp, actor)];
    } else {
      document.reviewStatus = "draft";
      delete document.approvedContent;
      document.auditTrail = [...(document.auditTrail ?? []), auditEntry(document, revision, "changes-requested", timestamp, actor)];
    }
    document.updatedAt = timestamp;
    await this.persistDocument(document);
    return structuredClone(document);
  }

  async reviewScreenshot(documentId: string, expectedRevisionId: string, stateId: string,
    disposition: "accepted-safe" | "excluded", reviewer?: string): Promise<DocsWorkspaceDocument> {
    const document = await this.requireDocument(documentId);
    assertCurrentRevision(document, expectedRevisionId);
    const previous = currentRevision(document);
    const image = previous.screenshotReviews?.find((item) => item.stateId === stateId);
    if (!image) throw new Error("Screenshot is not part of the frozen evidence");
    if (disposition === "accepted-safe" && (image.safety === "known-tenant-information" || image.checksum === "unavailable")) {
      throw new Error("Known tenant information or unavailable screenshots cannot be accepted as safe; exclude the screenshot");
    }
    const timestamp = this.now().toISOString();
    const actor = safeReviewer(reviewer);
    const revision = structuredClone(previous);
    revision.id = `revision-${randomUUID()}`;
    revision.number += 1;
    revision.createdAt = timestamp;
    revision.reviewer = actor;
    revision.screenshotReviews = (revision.screenshotReviews ?? []).map((item) => item.stateId === stateId
      ? { ...item, disposition, reviewer: actor, reviewedAt: timestamp } : item);
    if (disposition === "excluded") {
      revision.markdown = normalizeMarkdown(revision.markdown.split("\n").filter((line) =>
        ![image.path, `- ${image.path}`].includes(line.trim())).join("\n"));
      const result = revalidateMarkdown(revision.markdown, document.article, await this.readFrozenEvidence(document));
      revision.validation = { status: result.issues.length ? "failed" : "passed", validatedAt: timestamp,
        supportedStatements: result.supportedStatements, unsupportedStatements: result.issues.length, issues: result.issues };
      revision.evidenceAssociations = result.associations;
      revision.tenantWarnings = mergeTenantWarnings(revision.tenantWarnings, detectTenantWarnings(revision.markdown));
    }
    revision.checksum = checksumText(JSON.stringify({ title: revision.title, markdown: revision.markdown,
      screenshots: revision.screenshotReviews }));
    document.currentRevisionId = revision.id;
    document.revisions = [...(document.revisions ?? []), revision];
    document.articleMarkdown = revision.markdown;
    document.reviewStatus = "needs-review";
    document.updatedAt = timestamp;
    delete document.approvedContent;
    document.auditTrail = [...(document.auditTrail ?? []), auditEntry(document, revision, "screenshot-reviewed", timestamp, actor)];
    await this.persistRevision(document.id, revision);
    await this.persistDocument(document);
    return structuredClone(document);
  }

  async exportAvailability(documentId: string): Promise<ExportAvailability> {
    const availability: ExportAvailability = { markdown: { available: false }, html: { available: false } };
    for (const format of ["markdown", "html"] as const) {
      try {
        const document = await this.requireDocument(documentId);
        await this.prepareExport(documentId, document.currentRevisionId ?? "", format);
        availability[format] = { available: true };
      } catch (error) {
        availability[format] = { available: false, reason: error instanceof Error ? error.message : "Export is unavailable" };
      }
    }
    return availability;
  }

  async exportDocument(documentId: string, revisionId: string, format: DocumentExportFormat): Promise<DocumentExport> {
    const prepared = await this.prepareExport(documentId, revisionId, format);
    const record: DocumentExportRecord = { id: `export-${randomUUID()}`, documentId, revisionId,
      revisionChecksum: prepared.revision.checksum, evidencePackageChecksum: prepared.document.evidencePackageChecksum,
      format, exportedAt: this.now().toISOString(), resultChecksum: exportChecksum(prepared.body) };
    const directory = path.join(this.documentDirectory(documentId), "exports");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `${record.id}.json`);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    return { filename: exportFilename(prepared.revision.title, format), body: prepared.body, record,
      contentType: format === "markdown" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8" };
  }

  private async prepareExport(documentId: string, revisionId: string, format: DocumentExportFormat) {
    if (!validDocumentId(documentId)) throw new Error("Document not found");
    if (format !== "markdown" && format !== "html") throw new Error("Unsupported export format");
    const document = await this.readDocument(documentId);
    const revision = assertApprovedExport(document, revisionId);
    const package_ = await this.readFrozenEvidence(document);
    const grounding = revalidateMarkdown(revision.markdown, document.article, package_);
    if (grounding.issues.length || detectTenantWarnings(revision.markdown).length) {
      throw new Error("Approved content requires grounding or tenant-data review");
    }
    return { document, revision, body: await renderApprovedExport(revision, format) };
  }

  private async catalog(): Promise<CatalogEntry[]> {
    const packagePaths = await findNamedFiles(path.resolve(this.options.evidenceRoot), "evidence-package.json");
    const entries: CatalogEntry[] = [];
    for (const packagePath of packagePaths) {
      let source: string; let evidencePackage: KnowledgeEvidencePackage;
      try { source = await readFile(packagePath, "utf8"); evidencePackage = JSON.parse(source) as KnowledgeEvidencePackage; }
      catch { continue; }
      const directory = path.dirname(packagePath);
      const runtimePath = path.join(directory, "runtime-discovery.json");
      const baselinePath = path.join(directory, "..", "baseline.json");
      const sourceRevisions = await readSourceRevisions(baselinePath);
      const publishable = evidencePackage.claims.filter((item) => item.publishable && item.customerVisible);
      const procedureReady = supportsProcedure(publishable);
      const tenantSignals = detectTenantSignals(evidencePackage);
      entries.push({ packagePath, ...(await fileExists(runtimePath) ? { runtimePath } : {}), evidencePackage,
        feature: { id: evidencePackage.feature.id, name: evidencePackage.feature.name,
          evidencePackageId: evidencePackage.id, evidencePackageChecksum: checksumText(source),
          claimCount: evidencePackage.claims.length, publishableClaimCount: publishable.length,
          screenshotCount: evidencePackage.screenshots.length, limitationCount: evidencePackage.limitations.length,
          evidenceReady: publishable.length > 0 && Object.keys(sourceRevisions).length > 0,
          procedureReady, tenantSpecific: tenantSignals.length > 0,
          tenantSignals, sourceRevisions } });
    }
    const unique = new Map<string, CatalogEntry>();
    for (const entry of entries.sort((a, b) => a.packagePath.localeCompare(b.packagePath))) {
      unique.set(`${entry.feature.id}|${entry.feature.evidencePackageId}`, entry);
    }
    return [...unique.values()].sort((a, b) => a.feature.name.localeCompare(b.feature.name) ||
      a.feature.evidencePackageId.localeCompare(b.feature.evidencePackageId));
  }

  private async freezeEvidence(documentId: string, entry: CatalogEntry): Promise<void> {
    const directory = path.join(this.documentDirectory(documentId), "evidence");
    await mkdir(directory, { recursive: true });
    const source = await readFile(entry.packagePath, "utf8");
    if (checksumText(source) !== entry.feature.evidencePackageChecksum) throw new Error("Evidence package checksum mismatch");
    await writeFile(path.join(directory, "evidence-package.json"), source, { encoding: "utf8", mode: 0o600 });
  }

  private async persistDocument(document: DocsWorkspaceDocument): Promise<void> {
    validateDocument(document);
    const directory = this.documentDirectory(document.id);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, "document.json");
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  private async persistRevision(documentId: string, revision: DocumentRevision): Promise<void> {
    const directory = path.join(this.documentDirectory(documentId), "revisions");
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, `${revision.id}.json`);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(revision, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  private async requireDocument(id: string): Promise<DocsWorkspaceDocument> {
    const document = await this.getDocument(id);
    if (!document) throw new Error("Document not found");
    if (document.generationStatus !== "succeeded") throw new Error("Document is not reviewable");
    return document;
  }

  private async readFrozenEvidence(document: DocsWorkspaceDocument): Promise<KnowledgeEvidencePackage> {
    const source = await readFile(path.join(this.documentDirectory(document.id), "evidence", "evidence-package.json"), "utf8");
    if (checksumText(source) !== document.evidencePackageChecksum) throw new Error("Frozen evidence package checksum mismatch");
    return JSON.parse(source) as KnowledgeEvidencePackage;
  }

  private async readDocument(id: string): Promise<DocsWorkspaceDocument> {
    const document = JSON.parse(await readFile(path.join(this.documentDirectory(id), "document.json"), "utf8")) as DocsWorkspaceDocument;
    hydrateLegacyRevision(document);
    if (document.revisions?.length) {
      const images = await screenshotReviews(await this.readFrozenEvidence(document));
      const revision = currentRevision(document);
      revision.screenshotReviews = images.map((item) => {
        const previous = revision.screenshotReviews?.find((entry) => entry.stateId === item.stateId);
        return previous?.checksum === item.checksum && previous.safety === item.safety ? previous : item;
      });
      if (document.reviewStatus === "approved" && currentRevision(document).screenshotReviews?.some((item) =>
        item.disposition === "needs-review" || (item.disposition === "accepted-safe" && item.safety === "known-tenant-information"))) {
        document.reviewStatus = "needs-review";
        delete document.approvedContent;
      }
    }
    validateDocument(document); return document;
  }

  private documentsDirectory(): string { return path.resolve(this.options.dataDirectory, "documents"); }
  private documentDirectory(id: string): string { return path.join(this.documentsDirectory(), id); }
}

export function validateDocument(document: DocsWorkspaceDocument): void {
  if (!validDocumentId(document.id)) throw new Error("Invalid document ID");
  if (!(["generating", "succeeded", "failed"] as const).includes(document.generationStatus)) throw new Error("Invalid generation status");
  if (!(["draft", "needs-review", "approved"] as const).includes(document.reviewStatus)) throw new Error("Invalid review status");
  if (document.generationStatus === "succeeded" && !document.article) throw new Error("Generated documents require an article");
  if (document.currentRevisionId && !document.revisions?.some((item) => item.id === document.currentRevisionId)) {
    throw new Error("Current revision is unavailable");
  }
  if (document.generationStatus === "failed" && !document.failure) throw new Error("Failed documents require a diagnostic");
  if (!/^[a-f0-9]{64}$/.test(document.evidencePackageChecksum)) throw new Error("Invalid evidence checksum");
}

export function detectTenantSignals(package_: KnowledgeEvidencePackage): TenantSignal[] {
  const text = package_.claims.filter((item) => item.customerVisible).map((item) => item.text).join("\n");
  const signals: TenantSignal[] = [];
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) signals.push("email-address");
  if (/https?:\/\/(?!example\.(?:com|test)|localhost)[^\s/]+/i.test(text) || /\b[a-z0-9-]+\.superops\.ai\b/i.test(text)) {
    signals.push("tenant-hostname");
  }
  if (/\b(?:customer|client|tenant)\s+(?:id|name)\b/i.test(text)) signals.push("customer-identifier");
  return signals;
}

function supportsProcedure(claims: KnowledgeEvidencePackage["claims"]): boolean {
  const actions = claims.filter((item) => item.kind === "user-action" && item.instruction &&
    item.support.runtimeTransitionIds.length > 0);
  const outcomes = claims.filter((item) => item.kind === "visible-outcome" || item.kind === "validation-message" ||
    item.kind === "navigation-outcome");
  return actions.length > 0 && outcomes.length > 0;
}

function objectiveText(objective: DocsWorkspaceObjective, feature: string): string {
  return objective === "feature-overview"
    ? `Write a customer-facing overview of ${feature} using only the frozen evidence.`
    : `Write a customer-facing how-to guide for ${feature} using only the observed procedure in the frozen evidence.`;
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof Error && /evidence package changed|checksum/i.test(error.message)) return error.message;
  return "Document generation did not complete. Review the provider and grounding diagnostics, then retry.";
}

function initialRevision(markdown: string, title: string, timestamp: string, reviewer: string,
  article: KnowledgeBaseArticle): DocumentRevision {
  const associations = article.evidence.map((item, blockIndex) => ({ blockIndex, text: item.text,
    claimIds: [...item.claimIds], evidenceRefs: [...item.evidenceRefs], status: "valid" as const }));
  return { id: `revision-${randomUUID()}`, number: 1, createdAt: timestamp, reviewer, title, markdown,
    checksum: checksumText(`${title}\n${markdown}`), validation: { status: article.grounding.unsupportedStatements
      ? "failed" : "passed", validatedAt: timestamp, supportedStatements: article.grounding.supportedStatements,
    unsupportedStatements: article.grounding.unsupportedStatements,
    issues: article.grounding.issues.map((item) => ({ type: "unsupported-statement" as const, blockIndex: item.index,
      text: "", message: item.message })) }, evidenceAssociations: associations, tenantWarnings: detectTenantWarnings(markdown) };
}

function auditEntry(document: DocsWorkspaceDocument, revision: DocumentRevision, action: ReviewAction,
  timestamp: string, reviewer: string): DocumentAuditEntry {
  return { id: `audit-${randomUUID()}`, revisionId: revision.id, action, timestamp, reviewer,
    validationStatus: revision.validation.status, evidencePackageChecksum: document.evidencePackageChecksum,
    ...(action === "approved" ? { revisionChecksum: revision.checksum,
      revisionSnapshotChecksum: revisionSnapshotChecksum(revision) } : {}) };
}

function currentRevision(document: DocsWorkspaceDocument): DocumentRevision {
  const revision = document.revisions?.find((item) => item.id === document.currentRevisionId);
  if (!revision) throw new Error("Current revision is unavailable");
  return revision;
}

function assertCurrentRevision(document: DocsWorkspaceDocument, expected: string): void {
  if (!expected || expected !== document.currentRevisionId) {
    const error = new Error("Document has a newer revision; reload before saving");
    error.name = "StaleRevisionError";
    throw error;
  }
}

function safeReviewer(value?: string): string {
  const reviewer = value?.trim();
  return reviewer && /^[\w .@-]{1,80}$/.test(reviewer) ? reviewer : "Local reviewer";
}

interface MarkdownBlock { index: number; kind: "heading" | "paragraph" | "list-item"; text: string }

function markdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []; let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) { blocks.push({ index: blocks.length, kind: "paragraph",
    text: paragraph.join(" ").trim() }); paragraph = []; } };
  for (const line of markdown.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) { flush(); continue; }
    const heading = /^#{1,6}\s+(.+)$/.exec(value);
    const list = /^(?:[-*+] |\d+[.)] )(.+)$/.exec(value);
    if (heading) { flush(); blocks.push({ index: blocks.length, kind: "heading", text: heading[1]!.trim() }); }
    else if (list) { flush(); blocks.push({ index: blocks.length, kind: "list-item", text: list[1]!.trim() }); }
    else paragraph.push(value);
  }
  flush(); return blocks;
}

function revalidateMarkdown(markdown: string, article: KnowledgeBaseArticle | undefined,
  package_: KnowledgeEvidencePackage): { supportedStatements: number; issues: RevisionValidationIssue[];
    associations: RevisionEvidenceAssociation[] } {
  if (!article) return { supportedStatements: 0, issues: [{ type: "uncited-statement", blockIndex: 0, text: "",
    message: "The generated evidence ledger is unavailable" }], associations: [] };
  const claims = new Map(package_.claims.map((item) => [item.id, item]));
  const ledger = article.evidence;
  const issues: RevisionValidationIssue[] = []; const associations: RevisionEvidenceAssociation[] = [];
  let supportedStatements = 0;
  for (const block of markdownBlocks(markdown)) {
    if (block.kind === "heading") continue;
    const match = ledger.find((item) => equivalentSupportedText(block.text, item.text));
    if (!match) {
      const eligibleClaim = package_.claims.find((item) => item.publishable && item.customerVisible &&
        item.status !== "ambiguous" && item.status !== "conflicting" && equivalentSupportedText(block.text, item.text));
      if (eligibleClaim) {
        supportedStatements += 1;
        associations.push({ blockIndex: block.index, text: block.text, claimIds: [eligibleClaim.id],
          evidenceRefs: [...eligibleClaim.support.runtimeStateIds, ...eligibleClaim.support.staticNodeIds,
            ...eligibleClaim.support.reconciliationIds], status: "valid" });
        continue;
      }
      const limitation = package_.limitations.find((item) => equivalentSupportedText(block.text, item.message));
      const screenshot = package_.screenshots.find((item) => block.text === item.path);
      if (limitation || screenshot) {
        supportedStatements += 1;
        associations.push({ blockIndex: block.index, text: block.text, claimIds: [],
          evidenceRefs: [...(limitation?.evidenceRefs ?? screenshot?.evidenceRefs ?? [])], status: "valid" });
        continue;
      }
      issues.push({ type: "unsupported-statement", blockIndex: block.index, text: block.text,
        message: "This edited statement is not associated with frozen product evidence." });
      associations.push({ blockIndex: block.index, text: block.text, claimIds: [], evidenceRefs: [], status: "invalid" });
      continue;
    }
    const claimItems = match.claimIds.map((id) => claims.get(id));
    if (claimItems.some((item) => item?.status === "ambiguous" || item?.status === "conflicting")) {
      issues.push({ type: "ambiguous-statement", blockIndex: block.index, text: block.text,
        message: "The associated evidence is ambiguous and requires review." });
      associations.push({ blockIndex: block.index, text: block.text, claimIds: [...match.claimIds],
        evidenceRefs: [...match.evidenceRefs], status: "invalid" });
      continue;
    }
    supportedStatements += 1;
    associations.push({ blockIndex: block.index, text: block.text, claimIds: [...match.claimIds],
      evidenceRefs: [...match.evidenceRefs], status: "valid" });
  }
  if (associations.length === 0) issues.push({ type: "uncited-statement", blockIndex: 0, text: "",
    message: "The document must retain at least one association with frozen evidence." });
  return { supportedStatements, issues, associations };
}

function equivalentSupportedText(edited: string, original: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/\[[a-z][a-z0-9 -]{2,80}\]/gi, "[tenant-value]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[tenant-value]")
    .replace(/https?:\/\/[^\s)]+/gi, "[tenant-value]").replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
  return normalize(edited) === normalize(original);
}

function normalizeMarkdown(value: string): string { return `${value.replace(/\r\n/g, "\n").trim()}\n`; }

interface SensitiveValue { type: TenantSignal; value: string; blockIndex: number }

function sensitiveValues(markdown: string): SensitiveValue[] {
  const output: SensitiveValue[] = [];
  for (const block of markdownBlocks(markdown)) {
    for (const match of block.text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
      output.push({ type: "email-address", value: match[0], blockIndex: block.index });
    }
    for (const match of block.text.matchAll(/\b(?:https?:\/\/)?([a-z0-9-]+\.superops\.ai)\b/gi)) {
      if (!output.some((item) => item.value.includes(match[1]!))) {
        output.push({ type: "tenant-hostname", value: match[0], blockIndex: block.index });
      }
    }
    for (const match of block.text.matchAll(/\b(?:customer|client|tenant)\s+(?:id|name)\s*[:=-]\s*([^,.;\n]+)/gi)) {
      output.push({ type: "customer-identifier", value: match[1]!.trim(), blockIndex: block.index });
    }
  }
  return output;
}

function detectTenantWarnings(markdown: string): TenantDataWarning[] {
  return sensitiveValues(markdown).map((item) => ({ id: warningIdFor(item.type, item.value, item.blockIndex), type: item.type,
    blockIndex: item.blockIndex, maskedValue: maskSensitive(item.value), status: "unresolved" }));
}

function warningIdFor(type: TenantSignal, value: string, blockIndex: number): string {
  return `tenant-warning-${checksumText(`${type}|${value.toLowerCase()}|${blockIndex}`).slice(0, 16)}`;
}

function maskSensitive(value: string): string {
  if (value.includes("@")) { const [local, domain] = value.split("@"); const suffix = domain?.split(".").at(-1) ?? "domain";
    return `${local?.slice(0, 1) ?? "*"}***@***.${suffix}`; }
  if (value.includes(".")) { const host = value.replace(/^https?:\/\//, ""); return `***.${host.split(".").at(-1)}`; }
  return `${value.slice(0, 1)}***`;
}

function mergeTenantWarnings(existing: TenantDataWarning[], detected: TenantDataWarning[]): TenantDataWarning[] {
  const resolved = existing.filter((item) => item.status === "redacted");
  return [...detected, ...resolved.filter((item) => !detected.some((next) => next.id === item.id))];
}

function replaceOccurrenceInBlock(markdown: string, blockIndex: number, value: string, placeholder: string): string {
  const target = markdownBlocks(markdown)[blockIndex];
  if (!target || !target.text.includes(value)) throw new Error("Tenant information could not be located");
  return normalizeMarkdown(markdown.replace(value, placeholder));
}

function hydrateLegacyRevision(document: DocsWorkspaceDocument): void {
  if (document.generationStatus !== "succeeded" || document.revisions?.length || !document.article || !document.articleMarkdown) return;
  const revision = initialRevision(document.articleMarkdown, document.title, document.updatedAt, "AI generation", document.article);
  revision.id = `revision-legacy-${revision.checksum.slice(0, 24)}`;
  document.currentRevisionId = revision.id;
  document.revisions = [revision];
  document.auditTrail = [{ id: `audit-legacy-${revision.checksum.slice(0, 24)}`, revisionId: revision.id,
    action: "generated", timestamp: document.updatedAt, reviewer: "AI generation",
    validationStatus: revision.validation.status, evidencePackageChecksum: document.evidencePackageChecksum }];
}

async function screenshotReviews(package_: KnowledgeEvidencePackage): Promise<ScreenshotReview[]> {
  return Promise.all(package_.screenshots.map(async (image) => {
    const related = package_.claims.filter((item) => item.customerVisible &&
      item.support.runtimeStateIds.includes(image.runtimeStateId));
    const signals = detectTenantSignals({ ...package_, claims: related });
    let checksum = "unavailable";
    try { checksum = createHash("sha256").update(await readFile(image.path)).digest("hex"); } catch { /* Review requires a readable image. */ }
    return { stateId: image.runtimeStateId, path: image.path, checksum,
      safety: signals.length ? "known-tenant-information" : "unknown", tenantSignals: signals,
      evidenceRefs: [...image.evidenceRefs, ...related.filter((item) => sensitiveValues(item.text).length)
        .map((item) => item.id)], disposition: "needs-review" };
  }));
}

function checksumText(source: string): string { return createHash("sha256").update(source).digest("hex"); }
function validDocumentId(id: string): boolean { return /^document-[0-9a-f-]{36}$/.test(id); }

async function fileExists(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function readSourceRevisions(file: string): Promise<Record<string, string>> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const key of ["sourceRevision", "engineRevision"]) if (typeof value[key] === "string") result[key] = value[key];
    return result;
  } catch { return {}; }
}

async function findNamedFiles(root: string, name: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name === name) output.push(target);
    }
  }
  await visit(root); return output;
}
