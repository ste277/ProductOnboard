import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { DocsWorkspace, type DocsWorkspaceObjective } from "./docs-workspace.js";
import { DOCS_WORKSPACE_CSS, DOCS_WORKSPACE_HTML, DOCS_WORKSPACE_JS } from "./docs-workspace-ui.js";

export interface DocsWorkspaceServerOptions {
  workspace: DocsWorkspace;
  host?: string;
  port?: number;
}

export interface RunningDocsWorkspaceServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function startDocsWorkspaceServer(options: DocsWorkspaceServerOptions): Promise<RunningDocsWorkspaceServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("Docs Workspace V1 can only bind to a loopback address");
  }
  const sessionToken = randomBytes(24).toString("hex");
  const csrfToken = randomBytes(24).toString("hex");
  const server = createServer((request, response) => {
    void routeRequest(request, response, options.workspace, sessionToken, csrfToken).catch((error: unknown) => {
      if (!response.headersSent) {
        const message = error instanceof Error ? error.message : "Workspace request failed";
        const status = error instanceof Error && error.name === "StaleRevisionError" ? 409 : 422;
        json(response, status, { message });
      }
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Workspace server address is unavailable");
  return { server, url: `http://${host}:${address.port}/docs`, close: () => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())) };
}

async function routeRequest(request: IncomingMessage, response: ServerResponse, workspace: DocsWorkspace,
  sessionToken: string, csrfToken: string): Promise<void> {
  const url = new URL(request.url ?? "/", "http://workspace.local");
  securityHeaders(response);
  if (request.method === "GET" && (url.pathname === "/docs" || url.pathname === "/docs/generate" ||
    /^\/docs\/document-[0-9a-f-]{36}$/.test(url.pathname))) {
    response.setHeader("set-cookie", `docs_workspace_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
    return text(response, 200, "text/html; charset=utf-8", DOCS_WORKSPACE_HTML.replace("__CSRF_TOKEN__", csrfToken));
  }
  if (request.method === "GET" && url.pathname === "/workspace.css") {
    return text(response, 200, "text/css; charset=utf-8", DOCS_WORKSPACE_CSS);
  }
  if (request.method === "GET" && url.pathname === "/workspace.js") {
    return text(response, 200, "text/javascript; charset=utf-8", DOCS_WORKSPACE_JS);
  }
  if (url.pathname.startsWith("/api/") && !hasSession(request, sessionToken)) {
    return json(response, 401, { message: "Workspace session required" });
  }
  if (url.pathname.startsWith("/api/") && isMutation(request) && !validMutation(request, csrfToken)) {
    return json(response, 403, { message: "Valid same-origin CSRF token required" });
  }
  if (request.method === "GET" && url.pathname === "/api/features") {
    return json(response, 200, await workspace.listFeatures());
  }
  if (request.method === "GET" && url.pathname === "/api/documents") {
    return json(response, 200, await workspace.listDocuments());
  }
  const documentMatch = /^\/api\/documents\/(document-[0-9a-f-]{36})$/.exec(url.pathname);
  if (request.method === "GET" && documentMatch) {
    const document = await workspace.getDocument(documentMatch[1]!);
    return document ? json(response, 200, document) : json(response, 404, { message: "Document not found" });
  }
  const screenshotMatch = /^\/api\/documents\/(document-[0-9a-f-]{36})\/screenshots\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && screenshotMatch) {
    const screenshot = await workspace.resolveScreenshot(screenshotMatch[1]!, decodeURIComponent(screenshotMatch[2]!));
    if (!screenshot) return json(response, 404, { message: "Screenshot not available" });
    const body = await readFile(screenshot);
    response.writeHead(200, { "content-type": imageContentType(screenshot), "content-length": body.length,
      "cache-control": "private, no-store" }); response.end(body); return;
  }
  if (request.method === "POST" && url.pathname === "/api/documents/generate") {
    const body = await readJsonBody(request);
    if (!isGenerationInput(body)) return json(response, 400, { message: "Feature and objective are required" });
    const document = await workspace.generateDocument(body);
    return json(response, document.generationStatus === "failed" ? 422 : 201, document);
  }
  const revisionMatch = /^\/api\/documents\/(document-[0-9a-f-]{36})\/revisions$/.exec(url.pathname);
  if (request.method === "POST" && revisionMatch) {
    const body = await readJsonBody(request);
    if (!record(body) || typeof body.expectedRevisionId !== "string" || typeof body.title !== "string" ||
      typeof body.markdown !== "string") return json(response, 400, { message: "Revision, title, and Markdown are required" });
    return json(response, 201, await workspace.saveRevision(revisionMatch[1]!, { expectedRevisionId: body.expectedRevisionId,
      title: body.title, markdown: body.markdown, ...(typeof body.reviewer === "string" ? { reviewer: body.reviewer } : {}) }));
  }
  const validateMatch = /^\/api\/documents\/(document-[0-9a-f-]{36})\/validate$/.exec(url.pathname);
  if (request.method === "POST" && validateMatch) {
    const body = await readJsonBody(request);
    if (!record(body) || typeof body.expectedRevisionId !== "string") {
      return json(response, 400, { message: "Current revision is required" });
    }
    return json(response, 200, await workspace.validateRevision(validateMatch[1]!, body.expectedRevisionId,
      typeof body.reviewer === "string" ? body.reviewer : undefined));
  }
  const redactMatch = /^\/api\/documents\/(document-[0-9a-f-]{36})\/tenant-redactions$/.exec(url.pathname);
  if (request.method === "POST" && redactMatch) {
    const body = await readJsonBody(request);
    if (!record(body) || typeof body.expectedRevisionId !== "string" || typeof body.warningId !== "string" ||
      typeof body.placeholder !== "string") return json(response, 400, { message: "Warning and placeholder are required" });
    return json(response, 201, await workspace.redactTenantWarning(redactMatch[1]!, body.expectedRevisionId,
      body.warningId, body.placeholder, typeof body.reviewer === "string" ? body.reviewer : undefined));
  }
  const reviewMatch = /^\/api\/documents\/(document-[0-9a-f-]{36})\/review$/.exec(url.pathname);
  const imageReviewMatch = /^\/api\/documents\/(document-[0-9a-f-]{36})\/screenshot-reviews$/.exec(url.pathname);
  if (request.method === "POST" && imageReviewMatch) {
    const body = await readJsonBody(request);
    if (!record(body) || typeof body.expectedRevisionId !== "string" || typeof body.stateId !== "string" ||
      (body.disposition !== "accepted-safe" && body.disposition !== "excluded")) {
      return json(response, 400, { message: "Screenshot and explicit disposition are required" });
    }
    return json(response, 201, await workspace.reviewScreenshot(imageReviewMatch[1]!, body.expectedRevisionId,
      body.stateId, body.disposition, typeof body.reviewer === "string" ? body.reviewer : undefined));
  }
  if (request.method === "POST" && reviewMatch) {
    const body = await readJsonBody(request);
    if (!record(body) || typeof body.expectedRevisionId !== "string" ||
      (body.action !== "request-changes" && body.action !== "approve") || typeof body.confirmed !== "boolean") {
      return json(response, 400, { message: "A valid review action is required" });
    }
    return json(response, 200, await workspace.reviewDocument(reviewMatch[1]!, body.expectedRevisionId,
      body.action, body.confirmed, typeof body.reviewer === "string" ? body.reviewer : undefined));
  }
  return json(response, 404, { message: "Not found" });
}

function hasSession(request: IncomingMessage, expected: string): boolean {
  return (request.headers.cookie ?? "").split(";").map((item) => item.trim())
    .some((item) => item === `docs_workspace_session=${expected}`);
}

function isMutation(request: IncomingMessage): boolean { return !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET"); }

function validMutation(request: IncomingMessage, expected: string): boolean {
  if (request.headers["x-docs-csrf"] !== expected) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { const url = new URL(origin); return ["127.0.0.1", "localhost", "::1"].includes(url.hostname); }
  catch { return false; }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
    if (size > 32_768) throw new Error("Request body is too large"); chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}

function isGenerationInput(value: unknown): value is { featureId: string; objective: DocsWorkspaceObjective } {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return typeof input.featureId === "string" &&
    (input.objective === "feature-overview" || input.objective === "how-to-guide");
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("cache-control", "private, no-store");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  text(response, status, "application/json; charset=utf-8", `${JSON.stringify(value)}\n`);
}

function text(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(body) }); response.end(body);
}

function imageContentType(file: string): string {
  return path.extname(file).toLowerCase() === ".jpg" || path.extname(file).toLowerCase() === ".jpeg"
    ? "image/jpeg" : "image/png";
}
