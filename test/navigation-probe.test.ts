import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import {
  classifyRuntimeProbeTarget,
  probeRuntimeNavigation,
  type RuntimeProbeTarget,
  type RuntimeProbeTargetContext,
} from "../src/navigation-probe.js";
import { captureRuntimePage } from "../src/runtime-capture.js";

const execFileAsync = promisify(execFile);
let server: Server | undefined;
let baseUrl = "";
let requests: Array<{ method: string; path: string }> = [];
const artifactDirectories: string[] = [];

beforeEach(async () => {
  requests = [];
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push({ method: request.method ?? "GET", path: url.pathname });
    if (url.pathname === "/probe") return html(response, probeFixture());
    if (url.pathname === "/dashboard") return html(response, "<!doctype html><title>Dashboard</title><h1>Dashboard</h1>");
    if (url.pathname === "/popup") return html(response, "<!doctype html><title>Popup</title><h1>Child Page</h1>");
    if (url.pathname.startsWith("/api/unexpected")) {
      response.writeHead(204); response.end(); return;
    }
    html(response, "<!doctype html><title>Other</title><h1>Other</h1>");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  server = undefined;
  await Promise.all(artifactDirectories.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

test("requires an explicit target ID and returns structured missing-target evidence", async () => {
  await assert.rejects(
    probeRuntimeNavigation({ url: `${baseUrl}/probe`, targetId: "" }),
    /target ID is required/,
  );
  const result = await probeRuntimeNavigation({
    url: `${baseUrl}/probe`, targetId: "runtime-element:missing", outputDirectory: artifacts("missing"),
  });
  assert.equal(result.resolution.status, "missing");
  assert.equal(result.safety.decision, "unknown");
  assert.equal(result.interaction.performed, false);
  assert.equal(result.after, null);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("revalidates and clicks one semantic same-origin link exactly once", async () => {
  const targetId = await semanticId("Dashboard");
  const result = await probe(targetId, "native");
  assert.equal(result.target?.source, "semantic-element");
  assert.equal(result.resolution.status, "resolved");
  assert.equal(result.safety.decision, "allowed");
  assert.deepEqual(result.safety.reasons, ["safe-same-origin-navigation", "no-destructive-signal", "not-form-submit"]);
  assert.deepEqual(result.interaction, { type: "click", performed: true, count: 1, provenance: "browser-interaction" });
  assert.equal(result.before.finalUrl, `${baseUrl}/probe`);
  assert.equal(result.after?.finalUrl, `${baseUrl}/dashboard`);
  assert.equal(result.transition?.kind, "same-origin-url-change");
  assert.equal(result.transition?.urlChanged, true);
  assert.equal(requests.filter((item) => item.path === "/dashboard").length, 1);
  assert.equal(result.before.screenshot.captured, true);
  assert.equal(result.after?.screenshot.captured, true);
});

test("detects hash and same-URL dialog transitions", async () => {
  const hash = await probe(await semanticId("Tickets"), "hash");
  assert.equal(hash.safety.decision, "allowed");
  assert.equal(hash.transition?.kind, "hash-change");
  assert.equal(hash.after?.finalUrl, `${baseUrl}/probe#/tickets`);

  const dialog = await probe(await semanticId("Open Dialog"), "dialog");
  assert.equal(dialog.safety.decision, "allowed");
  assert.equal(dialog.transition?.kind, "same-url");
  assert.equal(dialog.transition?.dialogAppeared, true);
  assert.match(dialog.after?.accessibility.snapshot ?? "", /dialog "Details"/);
});

test("allows a strong authentication-entry candidate and captures same-page UI state", async () => {
  const capture = await inventory();
  const candidate = capture.interactionCandidates.find((item) => item.text === "Login as requester");
  assert.ok(candidate);
  const result = await probe(candidate.id, "auth-entry");
  assert.equal(result.target?.source, "interaction-candidate");
  assert.equal(result.safety.decision, "allowed");
  assert.ok(result.safety.reasons.includes("authentication-entry"));
  assert.equal(result.interaction.count, 1);
  assert.equal(result.transition?.kind, "hash-change");
  assert.ok(result.after?.elements.some((item) => item.accessibleName === "Username"));
  assert.ok(result.after?.elements.some((item) => item.accessibleName === "Sign In"));
  assert.match(result.after?.accessibility.snapshot ?? "", /textbox "Username"/);
});

test("blocks destructive, mutation, submit, cross-origin, and unsafe-scheme controls", async () => {
  const names = ["Delete Account", "Save Changes", "Sign In", "External Docs", "JavaScript Link",
    "Data Link", "Mail Link", "Telephone Link"];
  for (const name of names) {
    const result = await probe(await semanticId(name), `blocked-${name.replaceAll(" ", "-")}`);
    assert.equal(result.safety.decision, "blocked", name);
    assert.equal(result.interaction.performed, false, name);
    assert.equal(result.after, null, name);
  }
  assert.equal(requests.some((item) => item.path === "/deleted" || item.path === "/saved" || item.path === "/signin"), false);
});

test("ordinary, weak, and strong controls without navigation evidence remain unknown", async () => {
  const ordinary = await probe(await semanticId("View Details"), "ordinary");
  assert.equal(ordinary.safety.decision, "unknown");
  const capture = await inventory();
  for (const text of ["Weak Card", "Strong Card"]) {
    const target = capture.interactionCandidates.find((item) => item.text === text);
    assert.ok(target);
    const result = await probe(target.id, `unknown-${text}`);
    assert.equal(result.safety.decision, "unknown");
    assert.equal(result.interaction.performed, false);
  }
});

test("allows strong structural custom navigation while preserving destructive safety", async () => {
  const capture = await inventory();
  const assets = capture.interactionCandidates.find((item) => item.text === "Assets");
  const destructive = capture.interactionCandidates.find((item) => item.text === "Delete account");
  assert.equal(assets?.navigation?.classification, "custom-navigation");
  assert.ok(assets?.navigation?.evidence.includes("repeated-clickable-sibling-group"));
  assert.ok(assets);
  const result = await probe(assets.id, "custom-navigation");
  assert.equal(result.safety.decision, "allowed");
  assert.ok(result.safety.reasons.includes("structural-navigation-context"));
  assert.equal(result.interaction.count, 1);
  assert.equal(result.transition?.kind, "hash-change");
  assert.match(result.after?.accessibility.snapshot ?? "", /heading "Assets"/);

  assert.ok(destructive);
  const blocked = await probe(destructive.id, "custom-navigation-destructive");
  assert.equal(blocked.safety.decision, "blocked");
  assert.equal(blocked.interaction.performed, false);
  assert.equal(requests.some((item) => item.path === "/deleted-custom"), false);
});

test("captures a same-origin popup once without a second interaction", async () => {
  const result = await probe(await semanticId("Open Popup"), "popup");
  assert.equal(result.safety.decision, "allowed");
  assert.equal(result.interaction.count, 1);
  assert.equal(result.transition?.popupAppeared, true);
  assert.equal(result.transition?.kind, "popup");
  assert.equal(result.after?.page.title, "Popup");
  assert.ok(result.after?.text.some((item) => item.text === "Child Page"));
  assert.equal(requests.filter((item) => item.path === "/popup").length, 1);
});

test("flags unexpected mutation network methods without persisting sensitive request data", async () => {
  const cases = [["POST", "Explore Alpha"], ["PUT", "Explore Beta"], ["PATCH", "Explore Gamma"],
    ["DELETE", "Explore Delta"]] as const;
  for (const [method, label] of cases) {
    const result = await probe(await semanticId(label), `mutation-${method}`);
    assert.equal(result.safety.decision, "allowed");
    assert.equal(result.transition?.highSeveritySafetyIssue, true);
    assert.deepEqual(result.transition?.mutationMethods, [method]);
    const observation = result.after?.network.find((item) => item.url.endsWith(`/api/unexpected-${method.toLowerCase()}`));
    assert.equal(observation?.method, method);
    assert.equal(Object.hasOwn(observation ?? {}, "body"), false);
    assert.equal(Object.hasOwn(observation ?? {}, "headers"), false);
    assert.equal(Object.hasOwn(observation ?? {}, "cookies"), false);
  }
});

test("supports authenticated storage state and anonymous contexts", async () => {
  const anonymous = await probe(await semanticId("Dashboard"), "anonymous");
  assert.equal(anonymous.interaction.performed, true);
  const statePath = path.join(artifacts("state"), "state.json");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({ cookies: [], origins: [] }), "utf8");
  const authenticated = await probeRuntimeNavigation({
    url: `${baseUrl}/probe`, targetId: await semanticId("Dashboard"), storageStatePath: statePath,
    outputDirectory: artifacts("authenticated"),
  });
  assert.equal(authenticated.interaction.performed, true);
  assert.equal(Object.hasOwn(authenticated, "storageState"), false);
});

test("classifies supported and blocked schemes and explicit mutation terms deterministically", () => {
  const target = semanticTarget("Action");
  for (const term of ["remove", "create", "update", "install", "restart", "reboot", "send", "publish",
    "approve", "reject", "purchase", "pay"]) {
    const result = classifyRuntimeProbeTarget({ ...target, accessibleName: term }, targetContext(), `${baseUrl}/probe`);
    assert.equal(result.decision, "blocked", term);
  }
  for (const href of ["file:///tmp/a", "tel:123", "mailto:a@example.test", "data:text/plain,a", "javascript:void(0)"]) {
    const result = classifyRuntimeProbeTarget({ ...target, declaredHref: href, resolvedHref: href },
      { ...targetContext(), declaredHref: href, resolvedHref: href }, `${baseUrl}/probe`);
    assert.equal(result.decision, "blocked", href);
  }
});

test("probe CLI requires --target and emits a serializable transition manifest", async () => {
  const targetId = await semanticId("Dashboard");
  const outputDirectory = artifacts("cli");
  const { stdout, stderr } = await execFileAsync(process.execPath,
    ["--import", "tsx", "src/cli.ts", "probe", `${baseUrl}/probe`, "--target", targetId,
      "--output", outputDirectory], { cwd: process.cwd() });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout) as { interaction: { count: number }; after: { page: { title: string } } };
  assert.equal(result.interaction.count, 1);
  assert.equal(result.after.page.title, "Dashboard");
});

async function inventory() {
  return captureRuntimePage({ url: `${baseUrl}/probe`, outputDirectory: artifacts("inventory") });
}

async function semanticId(name: string): Promise<string> {
  const capture = await inventory();
  const target = capture.elements.find((item) => item.accessibleName === name);
  assert.ok(target, `Missing semantic fixture target: ${name}`);
  return target.id;
}

async function probe(targetId: string, name: string) {
  return probeRuntimeNavigation({ url: `${baseUrl}/probe`, targetId, outputDirectory: artifacts(name), settleTimeoutMs: 700 });
}

function artifacts(name: string): string {
  const directory = path.join(tmpdir(), `runtime-probe-${name}-${process.pid}-${artifactDirectories.length}`);
  artifactDirectories.push(directory);
  return directory;
}

function html(response: import("node:http").ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html" }); response.end(body);
}

function probeFixture(): string {
  return `<!doctype html><title>Probe Fixture</title>
    <a href="/dashboard">Dashboard</a>
    <a href="#/tickets">Tickets</a>
    <a href="https://example.test/docs">External Docs</a>
    <a href="javascript:void(0)">JavaScript Link</a>
    <a href="data:text/plain,no">Data Link</a>
    <a href="mailto:docs@example.test">Mail Link</a>
    <a href="tel:123">Telephone Link</a>
    <a href="/popup" target="_blank">Open Popup</a>
    <a href="/probe" id="dialog-link">Open Dialog</a>
    <a href="#post" id="mutation-post">Explore Alpha</a>
    <a href="#put" id="mutation-put">Explore Beta</a>
    <a href="#patch" id="mutation-patch">Explore Gamma</a>
    <a href="#delete" id="mutation-delete">Explore Delta</a>
    <button id="details">View Details</button>
    <button onclick="fetch('/deleted')">Delete Account</button>
    <button onclick="fetch('/saved')">Save Changes</button>
    <form action="/signin"><label>Username <input name="username"></label><button type="submit">Sign In</button></form>
    <div id="login" style="cursor:pointer">Login as requester</div>
    <div id="weak" style="cursor:pointer">Weak Card</div>
    <div id="strong">Strong Card</div>
    <div id="product-nav">
      <div id="assets" style="cursor:pointer">Assets</div>
      <div id="tickets-custom" style="cursor:pointer">Tickets workspace</div>
      <div id="delete-custom" style="cursor:pointer">Delete account</div>
    </div>
    <script>
      document.querySelector('#login').addEventListener('click', () => {
        location.hash = '/login/requester';
        document.body.insertAdjacentHTML('beforeend', '<section><label>Username <input aria-label="Username"></label><label>Password <input type="password" aria-label="Password"></label><button>Sign In</button></section>');
      });
      document.querySelector('#strong').addEventListener('click', () => {});
      document.querySelector('#assets').addEventListener('click', () => {
        location.hash = '/assets';
        document.body.insertAdjacentHTML('beforeend', '<section><h1>Assets</h1></section>');
      });
      document.querySelector('#tickets-custom').addEventListener('click', () => { location.hash = '/tickets'; });
      document.querySelector('#delete-custom').addEventListener('click', () => fetch('/deleted-custom', { method: 'DELETE' }));
      document.querySelector('#details').addEventListener('click', () => {
        document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-label="Details"><h2>Details</h2></div>');
      });
      document.querySelector('#dialog-link').addEventListener('click', (event) => {
        event.preventDefault();
        document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-label="Details"><h2>Details</h2></div>');
      });
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        document.querySelector('#mutation-' + method.toLowerCase()).addEventListener('click', () =>
          fetch('/api/unexpected-' + method.toLowerCase(), { method, body: 'private' }));
      }
    </script>`;
}

function semanticTarget(name: string): Extract<RuntimeProbeTarget, { source: "semantic-element" }> {
  return { source: "semantic-element", id: "runtime-element:test", type: "a", role: "link",
    accessibleName: name, visibleText: name, domPath: "html>body>a:nth-of-type(1)", visible: true,
    enabled: true, boundingBox: { x: 0, y: 0, width: 10, height: 10 }, provenance: ["dom", "accessibility"] };
}

function targetContext(): RuntimeProbeTargetContext {
  return { tag: "a", role: "link", text: "Action", accessibleName: "", inputType: null,
    declaredHref: null, resolvedHref: null, insideForm: false, associatedForm: false,
    couldSubmitForm: false, disabled: false, nearbyText: "" };
}
