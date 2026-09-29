import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import {
  captureRuntimePage,
  DEFAULT_RUNTIME_VIEWPORT,
  RuntimeCaptureError,
  sanitizeRuntimeUrl,
  validateRuntimeUrl,
} from "../src/runtime-capture.js";

const execFileAsync = promisify(execFile);
let server: Server | undefined;
let baseUrl = "";
let requestedPaths: string[] = [];
const artifactDirectories: string[] = [];

beforeEach(async () => {
  requestedPaths = [];
  server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    requestedPaths.push(requestUrl.pathname);
    if (requestUrl.pathname === "/start") {
      response.writeHead(302, { location: "/login" });
      response.end();
      return;
    }
    if (requestUrl.pathname === "/api/tickets") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"tickets":[]}');
      return;
    }
    if (requestUrl.pathname === "/api/heartbeat") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (requestUrl.pathname === "/api/stream") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("open");
      return;
    }
    if (requestUrl.pathname === "/polling") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>Polling Tickets</title>
        <h1>Tickets</h1><button>Create Ticket</button>
        <script>
          console.error('polling console error');
          setTimeout(() => { throw new Error('polling page error'); }, 10);
          setInterval(() => fetch('/api/heartbeat'), 100);
        </script>`);
      return;
    }
    if (requestUrl.pathname === "/long-lived") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>Streaming Tickets</title>
        <h1>Streaming</h1><button>Refresh</button>
        <script>fetch('/api/stream');</script>`);
      return;
    }
    if (requestUrl.pathname === "/candidates") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(candidateFixtureHtml());
      return;
    }
    if (requestUrl.pathname === "/not-found") {
      response.writeHead(404, { "content-type": "text/html" });
      response.end("<!doctype html><title>Missing</title><h1>Not Found</h1>");
      return;
    }
    if (requestUrl.pathname === "/server-error") {
      response.writeHead(500, { "content-type": "text/html" });
      response.end("<!doctype html><title>Error</title><h1>Server Error</h1>");
      return;
    }
    if (requestUrl.pathname === "/login") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Login</title><h1>Login</h1>");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(fixtureHtml());
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((error) => error ? reject(error) : resolve());
  });
  server = undefined;
  await Promise.all(
    artifactDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("validates HTTP and HTTPS URLs and rejects malformed or unsupported targets", () => {
  assert.equal(validateRuntimeUrl("http://localhost:3000/tickets").protocol, "http:");
  assert.equal(validateRuntimeUrl("https://example.test/tickets").protocol, "https:");
  assert.throws(() => validateRuntimeUrl("not a url"), (error) =>
    error instanceof RuntimeCaptureError && error.failure.classification === "invalid-url");
  assert.throws(() => validateRuntimeUrl("file:///tmp/page.html"), (error) =>
    error instanceof RuntimeCaptureError && error.failure.classification === "unsupported-url-scheme");
});

test("redacts sensitive URL query values while preserving routing evidence", () => {
  assert.equal(
    sanitizeRuntimeUrl("https://example.test/login?authorizeContextId=secret&display=page#form"),
    "https://example.test/login?authorizeContextId=%5BREDACTED%5D&display=page#form",
  );
  assert.equal(
    sanitizeRuntimeUrl("https://example.test/#/login?authorizeContextId=secret&display=page"),
    "https://example.test/#/login?authorizeContextId=%5BREDACTED%5D&display=page",
  );
});

test("captures visible UI, accessibility, layout, network, errors, and a viewport PNG", async () => {
  const outputDirectory = artifactDirectory("complete");
  const first = await captureRuntimePage({ url: `${baseUrl}/tickets`, outputDirectory });

  assert.equal(first.requestedUrl, `${baseUrl}/tickets`);
  assert.equal(first.finalUrl, `${baseUrl}/tickets`);
  assert.equal(first.navigation.status, 200);
  assert.equal(first.navigation.redirected, false);
  assert.equal(first.status, "complete");
  assert.equal(first.readiness.status, "ready");
  assert.equal(first.page.title, "Tickets");
  assert.deepEqual(first.viewport, DEFAULT_RUNTIME_VIEWPORT);
  assert.match(first.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.doesNotThrow(() => JSON.stringify(first));

  const headingText = first.text.find((item) => item.text === "Tickets");
  assert.ok(headingText);
  assert.match(first.accessibility.snapshot, /heading "Tickets"/);
  assert.match(first.accessibility.snapshot, /button "Create Ticket"/);
  assert.doesNotMatch(first.accessibility.snapshot, /secret-value/);

  const buttons = first.elements.filter(
    (element) => element.role === "button" && element.accessibleName === "Create Ticket",
  );
  assert.equal(buttons.length, 2);
  assert.equal(new Set(buttons.map((button) => button.id)).size, 2);
  assert.ok(buttons.every((button) => button.boundingBox.width > 0));
  assert.ok(buttons.every((button) => button.boundingBox.x >= 0 && button.boundingBox.x < 1440));

  const search = first.elements.find((element) => element.inputType === "search");
  assert.equal(search?.role, "searchbox");
  assert.equal(search?.accessibleName, "Search");
  assert.equal(search?.placeholder, "Search tickets...");
  assert.equal(search?.required, true);
  assert.equal(search?.readonly, true);

  const disabled = first.elements.find((element) => element.accessibleName === "Disabled action");
  assert.equal(disabled?.enabled, false);
  assert.equal(disabled?.disabled, true);

  const status = first.elements.find((element) => element.role === "combobox");
  assert.equal(status?.accessibleName, "Status");
  assert.deepEqual(status?.options?.map((option) => option.label), ["Open", "Closed"]);
  assert.equal(status?.selectedOption, "Open");

  const link = first.elements.find((element) => element.role === "link");
  assert.equal(link?.declaredHref, "/tickets/new");
  assert.equal(link?.resolvedHref, `${baseUrl}/tickets/new`);
  assert.equal(first.elements.some((element) => element.accessibleName === "Hidden action"), false);

  const password = first.elements.find((element) => element.inputType === "password");
  assert.ok(password);
  assert.equal(Object.hasOwn(password, "value"), false);

  const navigation = first.network.find((item) => item.url === `${baseUrl}/tickets`);
  const api = first.network.find((item) => item.url === `${baseUrl}/api/tickets`);
  assert.equal(navigation?.method, "GET");
  assert.equal(navigation?.status, 200);
  assert.equal(api?.method, "GET");
  assert.equal(api?.resourceType, "fetch");
  assert.equal(api?.status, 200);
  assert.equal(Object.hasOwn(api ?? {}, "headers"), false);
  assert.equal(Object.hasOwn(api ?? {}, "cookies"), false);
  assert.equal(Object.hasOwn(api ?? {}, "body"), false);

  assert.ok(first.consoleErrors.some((error) => error.message === "fixture console error"));
  assert.ok(first.pageErrors.some((error) => error.message.includes("fixture page error")));
  assert.equal(requestedPaths.includes("/clicked"), false);
  assert.equal(requestedPaths.includes("/submitted"), false);

  const png = await readFile(first.screenshot.path);
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 1440);
  assert.equal(png.readUInt32BE(20), 900);
  assert.equal(path.dirname(first.screenshot.path), outputDirectory);
  assert.equal(first.screenshot.captured, true);

  const second = await captureRuntimePage({ url: `${baseUrl}/tickets`, outputDirectory });
  assert.deepEqual(
    second.elements.map((element) => element.id),
    first.elements.map((element) => element.id),
  );
  assert.notEqual(second.screenshot.path, first.screenshot.path);
});

test("records redirects and does not attempt authentication", async () => {
  const capture = await captureRuntimePage({
    url: `${baseUrl}/start`,
    outputDirectory: artifactDirectory("redirect"),
  });
  assert.equal(capture.requestedUrl, `${baseUrl}/start`);
  assert.equal(capture.finalUrl, `${baseUrl}/login`);
  assert.equal(capture.navigation.redirected, true);
  assert.equal(capture.navigation.status, 200);
  assert.equal(capture.page.title, "Login");
  assert.deepEqual(requestedPaths, ["/start", "/login"]);
});

test("captures rendered 404 and 500 pages as successful browser evidence", async () => {
  const missing = await captureRuntimePage({
    url: `${baseUrl}/not-found`,
    outputDirectory: artifactDirectory("404"),
  });
  const failed = await captureRuntimePage({
    url: `${baseUrl}/server-error`,
    outputDirectory: artifactDirectory("500"),
  });
  assert.equal(missing.navigation.status, 404);
  assert.equal(missing.page.title, "Missing");
  assert.ok(missing.text.some((item) => item.text === "Not Found"));
  assert.equal(failed.navigation.status, 500);
  assert.equal(failed.page.title, "Error");
  assert.ok(failed.text.some((item) => item.text === "Server Error"));
});

test("returns structured navigation failure and can capture again afterward", async () => {
  await assert.rejects(
    captureRuntimePage({
      url: "http://127.0.0.1:1/unreachable",
      outputDirectory: artifactDirectory("failure"),
      timeoutMs: 1_000,
    }),
    (error) => error instanceof RuntimeCaptureError &&
      error.failure.stage === "navigation" &&
      error.failure.classification === "navigation-failed",
  );
  const capture = await captureRuntimePage({
    url: `${baseUrl}/login`,
    outputDirectory: artifactDirectory("after-failure"),
  });
  assert.equal(capture.page.title, "Login");
});

test("captures partial UI, ARIA, screenshot, network, and errors during persistent polling", async () => {
  const capture = await captureRuntimePage({
    url: `${baseUrl}/polling`,
    outputDirectory: artifactDirectory("polling"),
    readinessTimeoutMs: 700,
  });
  assert.equal(capture.status, "partial");
  assert.equal(capture.navigation.success, true);
  assert.equal(capture.readiness.status, "partial");
  assert.equal(capture.readiness.reason, "network-active");
  assert.equal(capture.stages.readiness.status, "partial");
  assert.equal(capture.finalUrl, `${baseUrl}/polling`);
  assert.equal(capture.page.title, "Polling Tickets");
  assert.ok(capture.elements.some((element) => element.accessibleName === "Create Ticket"));
  assert.match(capture.accessibility.snapshot, /heading "Tickets"/);
  assert.match(capture.accessibility.snapshot, /button "Create Ticket"/);
  assert.ok(capture.network.some((item) => item.url.endsWith("/api/heartbeat") && item.status === 200));
  assert.ok(capture.consoleErrors.some((item) => item.message === "polling console error"));
  assert.ok(capture.pageErrors.some((item) => item.message.includes("polling page error")));
  assert.equal(capture.screenshot.captured, true);
  const screenshot = await readFile(capture.screenshot.path);
  assert.equal(screenshot.readUInt32BE(16), 1440);
  assert.equal(screenshot.readUInt32BE(20), 900);
});

test("captures a rendered page while a request remains open", async () => {
  const capture = await captureRuntimePage({
    url: `${baseUrl}/long-lived`,
    outputDirectory: artifactDirectory("long-lived"),
    readinessTimeoutMs: 500,
  });
  assert.equal(capture.status, "partial");
  assert.equal(capture.readiness.reason, "network-active");
  assert.equal(capture.page.title, "Streaming Tickets");
  assert.ok(capture.elements.some((element) => element.accessibleName === "Refresh"));
  assert.ok(capture.network.some((item) => item.url.endsWith("/api/stream")));
  assert.equal(capture.screenshot.captured, true);
});

test("preserves other evidence when screenshot extraction fails", async () => {
  const outputPath = artifactDirectory("blocked-output");
  await writeFile(outputPath, "not a directory", "utf8");
  const capture = await captureRuntimePage({
    url: `${baseUrl}/login`,
    outputDirectory: outputPath,
  });
  assert.equal(capture.status, "partial");
  assert.equal(capture.navigation.success, true);
  assert.equal(capture.finalUrl, `${baseUrl}/login`);
  assert.equal(capture.page.title, "Login");
  assert.match(capture.accessibility.snapshot, /heading "Login"/);
  assert.equal(capture.stages.screenshot.status, "failed");
  assert.equal(capture.screenshot.captured, false);
  assert.deepEqual(capture.issues, [{
    stage: "screenshot",
    classification: "artifact-write-failed",
    message: "Runtime screenshot could not be written",
  }]);
  assert.ok(capture.network.some((item) => item.url === `${baseUrl}/login`));
});

test("detects deterministic non-semantic interaction candidates without interaction", async () => {
  const outputDirectory = artifactDirectory("candidates");
  const first = await captureRuntimePage({ url: `${baseUrl}/candidates`, outputDirectory });
  const second = await captureRuntimePage({ url: `${baseUrl}/candidates`, outputDirectory });

  assert.equal(first.stages.interactionCandidates.status, "complete");
  assert.doesNotThrow(() => JSON.stringify(first.interactionCandidates));
  assert.ok(first.elements.some((element) => element.role === "button" && element.accessibleName === "Save"));
  assert.ok(first.elements.some((element) => element.role === "link" && element.accessibleName === "Settings"));
  assert.ok(first.elements.some((element) => element.role === "button" && element.accessibleName === "ARIA Action"));
  assert.ok(first.elements.some((element) => element.role === "link" && element.accessibleName === "ARIA Link"));
  assert.ok(first.elements.some((element) => element.role === "tab" && element.accessibleName === "ARIA Tab"));
  assert.equal(first.interactionCandidates.some((candidate) => candidate.text === "Save"), false);
  assert.equal(first.interactionCandidates.some((candidate) => candidate.text === "Settings"), false);
  assert.equal(first.interactionCandidates.some((candidate) => candidate.text === "ARIA Action"), false);
  assert.equal(first.interactionCandidates.some(
    (candidate) => candidate.boundingBox.width === 1440 && candidate.boundingBox.height === 900,
  ), false);

  const byText = new Map(first.interactionCandidates.map((candidate) => [candidate.text, candidate]));
  assert.ok(byText.get("Open Details")?.signals.some(
    (signal) => signal.type === "inline-click-handler" && signal.provenance === "dom-attribute",
  ));
  assert.ok(byText.get("Open Details")?.signals.some(
    (signal) => signal.type === "direct-click-listener" &&
      signal.provenance === "browser-event-listener",
  ));
  assert.equal(byText.get("Open Details")?.strength, "strong");
  assert.deepEqual(byText.get("Account")?.signals, [
    { type: "focusable", provenance: "dom-attribute" },
  ]);
  assert.equal(byText.get("Account")?.strength, "supporting");
  assert.deepEqual(byText.get("Login as requester")?.signals, [
    { type: "cursor-pointer", provenance: "computed-style" },
  ]);
  assert.equal(byText.get("Login as requester")?.strength, "weak");
  assert.ok(byText.get("Direct listener")?.signals.some(
    (signal) => signal.type === "direct-click-listener" && signal.provenance === "browser-event-listener",
  ));
  assert.ok(byText.get("Pointer listener")?.signals.some(
    (signal) => signal.type === "pointer-listener" && signal.provenance === "browser-event-listener",
  ));
  assert.equal(byText.get("Login as technician")?.tag, "div");
  assert.ok(byText.get("Login as technician")?.signals.some(
    (signal) => signal.type === "inline-click-handler",
  ));
  assert.ok(byText.get("Login as technician")?.boundingBox.width);
  assert.match(byText.get("Login as technician")?.domPath ?? "", /^html>body/);

  assert.equal(byText.has("Documentation"), false);
  assert.equal(byText.has("Hidden candidate"), false);
  assert.equal(byText.has("Zero candidate"), false);
  assert.equal(byText.has("Semantic child"), false);
  assert.ok(byText.has("Independent parent Semantic child independent"));
  assert.equal(first.interactionCandidates.filter((candidate) => candidate.text === "Duplicate").length, 2);
  assert.equal(new Set(
    first.interactionCandidates.filter((candidate) => candidate.text === "Duplicate").map((candidate) => candidate.id),
  ).size, 2);
  const bounded = first.interactionCandidates.find((candidate) => candidate.text.endsWith("..."));
  assert.equal(bounded?.text.length, 200);

  const navigation = byText.get("Custom route");
  assert.deepEqual(navigation?.destination, {
    kind: "possible-navigation",
    declaredHref: "/custom",
    resolvedHref: `${baseUrl}/custom`,
  });
  assert.equal(byText.get("Login as requester")?.destination, null);
  assert.deepEqual(
    second.interactionCandidates.map((candidate) => candidate.id),
    first.interactionCandidates.map((candidate) => candidate.id),
  );
  assert.equal(requestedPaths.some((item) => item.startsWith("/executed")), false);
});

test("candidate extraction failure preserves all other capture stages", async () => {
  const capture = await captureRuntimePage({
    url: `${baseUrl}/candidates`,
    outputDirectory: artifactDirectory("candidate-failure"),
    candidateTimeoutMs: 0,
  });
  assert.equal(capture.status, "partial");
  assert.equal(capture.stages.interactionCandidates.status, "failed");
  assert.deepEqual(capture.interactionCandidates, []);
  assert.equal(capture.page.title, "Candidates");
  assert.ok(capture.elements.some((element) => element.accessibleName === "Save"));
  assert.match(capture.accessibility.snapshot, /button "Save"/);
  assert.equal(capture.screenshot.captured, true);
  assert.ok(capture.network.some((item) => item.url === `${baseUrl}/candidates`));
  assert.ok(capture.issues.some((issue) => issue.stage === "interaction-candidates"));
});

test("runtime CLI writes a serializable manifest and honors output directory", async () => {
  const outputDirectory = artifactDirectory("cli");
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "capture", `${baseUrl}/login`, "--output", outputDirectory],
    { cwd: process.cwd() },
  );
  assert.equal(stderr, "");
  const manifest = JSON.parse(stdout) as { page: { title: string }; screenshot: { path: string } };
  assert.equal(manifest.page.title, "Login");
  assert.equal(path.dirname(manifest.screenshot.path), outputDirectory);
});

function artifactDirectory(name: string): string {
  const directory = path.join(
    tmpdir(),
    `runtime-capture-${name}-${process.pid}-${artifactDirectories.length}`,
  );
  artifactDirectories.push(directory);
  return directory;
}

function fixtureHtml(): string {
  return `<!doctype html>
<html>
  <head><title>Tickets</title></head>
  <body>
    <h1>Tickets</h1>
    <a href="/tickets/new">Create Ticket</a>
    <label>Search <input type="search" placeholder="Search tickets..." required readonly></label>
    <select aria-label="Status"><option selected>Open</option><option>Closed</option></select>
    <button aria-label="Create Ticket" onclick="fetch('/clicked')">+</button>
    <button>Create Ticket</button>
    <button aria-label="Disabled action" disabled>Disabled</button>
    <button aria-label="Hidden action" style="display:none">Hidden</button>
    <label>Password <input type="password" value="secret-value"></label>
    <form action="/submitted"><button type="submit">Submit</button></form>
    <p>Ticket #1001</p><p>Printer offline</p>
    <script>
      fetch('/api/tickets', { headers: { Authorization: 'Bearer secret' } });
      console.error('fixture console error');
      setTimeout(() => { throw new Error('fixture page error'); }, 10);
    </script>
  </body>
</html>`;
}

function candidateFixtureHtml(): string {
  return `<!doctype html><title>Candidates</title>
    <button>Save</button>
    <a href="/settings">Settings</a>
    <div role="button">ARIA Action</div>
    <div role="link">ARIA Link</div>
    <div role="tab">ARIA Tab</div>
    <div onclick="fetch('/executed-inline')">Open   Details</div>
    <div tabindex="0" onfocus="fetch('/executed-focus')">Account</div>
    <div style="cursor:pointer">Login as requester</div>
    <div>Documentation</div>
    <div style="display:none;cursor:pointer">Hidden candidate</div>
    <div style="width:0;height:0;overflow:hidden;cursor:pointer">Zero candidate</div>
    <div onclick="fetch('/executed-nested')"><img alt=""><h3>Login as technician</h3></div>
    <div style="cursor:pointer"><span style="cursor:inherit">Pointer parent</span></div>
    <div style="cursor:pointer"><button>Semantic child</button></div>
    <div onclick="fetch('/executed-independent')">Independent parent <button>Semantic child independent</button></div>
    <div style="cursor:pointer">Duplicate</div><div style="cursor:pointer">Duplicate</div>
    <div href="/custom" style="cursor:pointer">Custom route</div>
    <div style="cursor:pointer">${"Long candidate text ".repeat(20)}</div>
    <div id="direct">Direct listener</div><div id="pointer">Pointer listener</div>
    <div id="delegated" style="position:fixed;inset:0;pointer-events:none"></div>
    <script>
      document.querySelector('#direct').addEventListener('click', () => fetch('/executed-direct'));
      document.querySelector('#pointer').addEventListener('pointerdown', () => fetch('/executed-pointer'));
      document.querySelector('#delegated').addEventListener('click', () => {});
    </script>`;
}
