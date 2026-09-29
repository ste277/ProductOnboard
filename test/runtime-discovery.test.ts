import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import {
  DEFAULT_RUNTIME_DISCOVERY_LIMITS,
  discoverRuntimeNavigation,
  fingerprintRuntimeState,
} from "../src/runtime-discovery.js";
import { captureRuntimePage, type RuntimeCaptureManifest } from "../src/runtime-capture.js";

const execFileAsync = promisify(execFile);
let server: Server | undefined;
let boundaryServer: Server | undefined;
let baseUrl = "";
let boundaryUrl = "";
let requests: Array<{ method: string; path: string; cookie?: string }> = [];
const directories: string[] = [];

beforeEach(async () => {
  requests = [];
  boundaryServer = createServer((request, response) => {
    requests.push({ method: request.method ?? "GET", path: `boundary:${request.url ?? "/"}`,
      ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}) });
    if (request.url === "/auth-boundary") return html(response,
      "<!doctype html><title>External Auth</title><h1>External Auth</h1><a href='/external-next'>Continue</a>");
    return html(response, "<!doctype html><title>External Next</title><h1>External Next</h1>");
  });
  await listen(boundaryServer);
  boundaryUrl = serverUrl(boundaryServer);
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push({ method: request.method ?? "GET", path: url.pathname,
      ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}) });
    if (url.pathname === "/api/surprise") { response.writeHead(204); response.end(); return; }
    if (url.pathname === "/api/config") {
      response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); return;
    }
    if (url.pathname === "/dashboard") return html(response,
      "<!doctype html><title>Dashboard</title><h1>Dashboard</h1><a href='/'>Home</a>");
    if (url.pathname === "/tickets") return html(response,
      "<!doctype html><title>Tickets</title><h1>Tickets</h1><a href='/tickets/open'>Open Tickets</a><a href='/dashboard'>Dashboard</a><button>Save Filter</button>");
    if (url.pathname === "/tickets/open") return html(response,
      "<!doctype html><title>Open Tickets</title><h1>Open Tickets</h1>");
    if (url.pathname === "/settings") return html(response,
      "<!doctype html><title>Settings</title><h1>Settings</h1><a href='/settings/profile'>Profile</a><a href='/'>Home</a>");
    if (url.pathname === "/settings/profile") return html(response,
      "<!doctype html><title>Profile</title><h1>Profile</h1>");
    if (url.pathname === "/mutation") return html(response,
      "<!doctype html><title>Mutation State</title><h1>Mutation State</h1><a href='/dashboard'>Should Not Expand</a>");
    return html(response, homeFixture(boundaryUrl));
  });
  await listen(server);
  baseUrl = serverUrl(server);
});

afterEach(async () => {
  await close(server); await close(boundaryServer);
  server = undefined; boundaryServer = undefined;
  await Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

test("discovers a deterministic bounded graph with links, cycles, duplicate paths, and same-URL state", async () => {
  const graph = await discover({ maxDepth: 2, maxStates: 12, maxTransitions: 20, maxTargetsPerState: 12 });
  assert.equal(graph.nodes[0]?.depth, 0);
  assert.equal(graph.nodes[0]?.url, `${baseUrl}/`);
  assert.ok(graph.nodes.some((node) => node.url === `${baseUrl}/dashboard`));
  assert.ok(graph.nodes.some((node) => node.url === `${baseUrl}/tickets`));
  assert.ok(graph.nodes.some((node) => node.url === `${baseUrl}/#/tickets`));
  const loginStates = graph.nodes.filter((node) => node.url === `${baseUrl}/`);
  assert.ok(loginStates.length >= 2);
  assert.ok(loginStates.some((node) => node.semanticElements.some((item) => item.accessibleName === "Email")));
  assert.equal(new Set(graph.nodes.map((node) => node.fingerprint)).size, graph.nodes.length);
  const dashboard = graph.nodes.find((node) => node.url === `${baseUrl}/dashboard`);
  assert.ok(dashboard);
  assert.ok(graph.transitions.some((edge) => edge.to === dashboard.id && edge.from !== graph.nodes[0]?.id));
  assert.ok(graph.nodes.some((node) => node.stopReasons.includes("form-state")));
  assert.ok(graph.nodes.every((node) => node.screenshot.path && node.accessibility.snapshot !== undefined));
  assert.ok(graph.summary.statesDiscovered > 1);
});

test("skips unknown, blocked, form, submit, and external-link targets without activating them", async () => {
  const graph = await discover({ maxDepth: 1, maxStates: 10, maxTransitions: 10, maxTargetsPerState: 20 });
  assert.ok(graph.skippedTargets.some((item) => item.text === "Delete Account" && item.decision === "blocked"));
  assert.ok(graph.skippedTargets.some((item) => item.text === "Ordinary Action" && item.decision === "unknown"));
  assert.ok(graph.skippedTargets.some((item) => item.text === "Search" && item.reasons.includes("form-control")));
  assert.ok(graph.skippedTargets.some((item) => item.text === "Submit Search" && item.decision === "blocked"));
  assert.ok(graph.skippedTargets.some((item) => item.text === "External Docs" && item.decision === "blocked"));
  assert.equal(requests.some((item) => item.path === "/deleted" || item.path === "/submitted"), false);
});

test("records an authentication-origin boundary and only expands it when explicitly allowed", async () => {
  const bounded = await discover({ maxDepth: 2, maxStates: 10, maxTransitions: 10, maxTargetsPerState: 20 });
  const boundary = bounded.nodes.find((node) => node.url === `${boundaryUrl}/auth-boundary`);
  assert.ok(boundary);
  assert.equal(boundary.boundary, true);
  assert.ok(boundary.stopReasons.includes("origin-boundary"));
  assert.equal(bounded.nodes.some((node) => node.url === `${boundaryUrl}/external-next`), false);

  const allowed = await discoverRuntimeNavigation({ startUrl: `${baseUrl}/`, allowedOrigins: [boundaryUrl],
    outputDirectory: artifacts("allowed-origin"),
    limits: { maxDepth: 2, maxStates: 30, maxTransitions: 40, maxTargetsPerState: 20 },
    settleTimeoutMs: 300, readinessTimeoutMs: 500 });
  assert.ok(allowed.nodes.some((node) => node.url === `${boundaryUrl}/external-next`));
});

test("enforces depth, state, transition, and per-state target limits deterministically", async () => {
  const depthZero = await discover({ maxDepth: 0, maxStates: 20, maxTransitions: 20, maxTargetsPerState: 20 });
  assert.equal(depthZero.transitions.length, 0);
  assert.deepEqual(depthZero.stopReasons, ["max-depth"]);
  const stateLimited = await discover({ maxDepth: 2, maxStates: 2, maxTransitions: 20, maxTargetsPerState: 20 });
  assert.equal(stateLimited.nodes.length, 2);
  assert.ok(stateLimited.stopReasons.includes("max-states"));
  const transitionLimited = await discover({ maxDepth: 2, maxStates: 20, maxTransitions: 1, maxTargetsPerState: 20 });
  assert.equal(transitionLimited.transitions.length, 1);
  assert.ok(transitionLimited.stopReasons.includes("max-transitions"));
  const targetLimited = await discover({ maxDepth: 1, maxStates: 20, maxTransitions: 20, maxTargetsPerState: 1 });
  assert.ok(targetLimited.skippedTargets.some((item) => item.reasons.includes("target-limit")));
});

test("mutation traffic records warnings, baseline evidence, and stops branch expansion", async () => {
  const graph = await discover({ maxDepth: 2, maxStates: 12, maxTransitions: 20, maxTargetsPerState: 20 });
  const edge = graph.transitions.find((item) => item.target && targetText(item.target) === "Explore Reports");
  assert.ok(edge);
  assert.deepEqual(edge.mutationMethods, ["POST"]);
  assert.ok(edge.stopReasons.includes("mutation-observed"));
  const child = graph.nodes.find((node) => node.id === edge.to);
  assert.ok(child?.stopReasons.includes("mutation-observed"));
  assert.equal(graph.transitions.some((item) => item.from === child?.id), false);
});

test("preserves supplied storage state across isolated sibling probes", async () => {
  const statePath = path.join(artifacts("auth-state"), "state.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({ cookies: [{ name: "session", value: "present", domain: "127.0.0.1",
    path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }), "utf8");
  await discoverRuntimeNavigation({ startUrl: `${baseUrl}/`, storageStatePath: statePath,
    outputDirectory: artifacts("authenticated"), limits: { maxDepth: 1, maxStates: 8, maxTransitions: 5, maxTargetsPerState: 5 } });
  const siblingRequests = requests.filter((item) => ["/dashboard", "/tickets", "/settings"].includes(item.path));
  assert.ok(siblingRequests.length >= 2);
  assert.ok(siblingRequests.every((item) => item.cookie?.includes("session=present")));
});

test("state fingerprint excludes temporal artifacts and distinguishes structural UI changes", async () => {
  const capture = await captureRuntimePage({ url: `${baseUrl}/`, outputDirectory: artifacts("fingerprint") });
  const changedTemporal: RuntimeCaptureManifest = JSON.parse(JSON.stringify(capture));
  changedTemporal.capturedAt = "2099-01-01T00:00:00.000Z";
  changedTemporal.screenshot.path = "/different/screenshot.png";
  changedTemporal.network.reverse();
  changedTemporal.id = "different-runtime-id";
  assert.equal(fingerprintRuntimeState(changedTemporal), fingerprintRuntimeState(capture));
  const changedUi: RuntimeCaptureManifest = JSON.parse(JSON.stringify(capture));
  changedUi.elements.push({ id: "new", type: "button", role: "button", accessibleName: "New State",
    domPath: "html>body>button:nth-of-type(99)", visible: true, enabled: true,
    boundingBox: { x: 0, y: 0, width: 1, height: 1 }, provenance: ["dom", "accessibility"] });
  assert.notEqual(fingerprintRuntimeState(changedUi), fingerprintRuntimeState(capture));
});

test("retains privacy-safe state and transition network evidence with source provenance", async () => {
  const graph = await discover({ maxDepth: 1, maxStates: 4, maxTransitions: 1, maxTargetsPerState: 1 });
  const root = graph.nodes[0];
  const edge = graph.transitions[0];
  assert.ok(root);
  assert.ok(edge);
  assert.equal(root.runtimeCaptureId, root.networkObservations[0]?.sourceId);
  assert.equal(root.networkObservations[0]?.sourceType, "runtime-capture");
  assert.ok(root.network.some((item) => item.method === "GET" && item.resourceType === "document" && item.status === 200));
  const config = root.network.find((item) => item.url.includes("/api/config"));
  assert.ok(config?.url.includes("token=%5BREDACTED%5D"));
  assert.equal(edge.runtimeProbeId.startsWith("runtime-probe:"), true);
  assert.ok(edge.network.some((item) => item.method === "GET" && item.resourceType === "document"));
  for (const observation of [...root.network, ...edge.network]) {
    assert.ok(observation.id);
    assert.equal(Object.hasOwn(observation, "body"), false);
    assert.equal(Object.hasOwn(observation, "responseBody"), false);
    assert.equal(Object.hasOwn(observation, "headers"), false);
    assert.equal(Object.hasOwn(observation, "authorization"), false);
    assert.equal(Object.hasOwn(observation, "cookies"), false);
    assert.equal(typeof observation.status === "number" || observation.status === null, true);
  }
  assert.doesNotThrow(() => JSON.stringify(graph));
});

test("deduplicated states retain separate network observation sets without changing identity", async () => {
  const graph = await discover({ maxDepth: 2, maxStates: 12, maxTransitions: 20, maxTargetsPerState: 12 });
  const home = graph.nodes.find((node) => node.url === `${baseUrl}/` && node.depth === 0);
  assert.ok(home);
  assert.ok(home.networkObservations.length >= 2);
  assert.equal(new Set(home.networkObservations.map((item) => item.sourceId)).size, home.networkObservations.length);
  const before = home.fingerprint;
  home.networkObservations.push({ sourceId: "synthetic-observation", sourceType: "runtime-probe-after", network: [] });
  assert.equal(home.fingerprint, before);
});

test("structural discovery graph is reproducible and CLI/API support anonymous discovery", async () => {
  const limits = { maxDepth: 1, maxStates: 8, maxTransitions: 8, maxTargetsPerState: 8 };
  const first = await discover(limits);
  const second = await discover(limits);
  assert.deepEqual(structure(second), structure(first));
  const outputDirectory = artifacts("cli");
  const { stdout, stderr } = await execFileAsync(process.execPath,
    ["--import", "tsx", "src/cli.ts", "discover", `${baseUrl}/`, "--output", outputDirectory,
      "--max-depth", "0"], { cwd: process.cwd() });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout) as { nodes: unknown[]; transitions: unknown[] };
  assert.equal(result.nodes.length, 1);
  assert.equal(result.transitions.length, 0);
  assert.deepEqual(DEFAULT_RUNTIME_DISCOVERY_LIMITS, { maxDepth: 2, maxStates: 20,
    maxTransitions: 40, maxTargetsPerState: 10 });
});

test("root capture failure returns a deterministic stopped graph", async () => {
  const graph = await discoverRuntimeNavigation({ startUrl: "http://127.0.0.1:1/unreachable",
    outputDirectory: artifacts("root-failure"), timeoutMs: 500 });
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.stopReasons, ["root-capture-failed"]);
  assert.equal(graph.summary.statesDiscovered, 0);
});

async function discover(limits: { maxDepth: number; maxStates: number; maxTransitions: number; maxTargetsPerState: number }) {
  return discoverRuntimeNavigation({ startUrl: `${baseUrl}/`, outputDirectory: artifacts("discovery"), limits,
    settleTimeoutMs: 300, readinessTimeoutMs: 500 });
}

function structure(graph: Awaited<ReturnType<typeof discoverRuntimeNavigation>>) {
  return {
    nodes: graph.nodes.map((node) => ({ id: node.id, url: node.url, depth: node.depth,
      boundary: node.boundary, expandable: node.expandable, stops: node.stopReasons })),
    transitions: graph.transitions.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to,
      target: edge.target?.id, status: edge.status, stops: edge.stopReasons })),
    skipped: graph.skippedTargets.map((item) => ({ id: item.id, target: item.targetId,
      decision: item.decision, reasons: item.reasons })),
    stopReasons: graph.stopReasons,
    summary: graph.summary,
  };
}

function targetText(target: NonNullable<Awaited<ReturnType<typeof discoverRuntimeNavigation>>["transitions"][number]["target"]>): string {
  return target.source === "semantic-element" ? target.accessibleName : target.text;
}

function homeFixture(external: string): string {
  return `<!doctype html><title>Home</title><h1>Home</h1>
    <a href="/dashboard">Dashboard</a><a href="/tickets">Tickets</a><a href="/settings">Settings</a>
    <a href="/settings">Settings Duplicate</a><a href="#/tickets">Hash Tickets</a>
    <a href="https://example.test/docs">External Docs</a><a href="/mutation" id="reports">Explore Reports</a>
    <label>Search <input type="search"></label><form action="/submitted"><button type="submit">Submit Search</button></form>
    <button onclick="fetch('/deleted')">Delete Account</button><button>Ordinary Action</button>
    <div id="requester" style="cursor:pointer">Login as requester</div>
    <div id="technician" style="cursor:pointer">Login as technician</div>
    <script>
      fetch('/api/config?token=private');
      document.querySelector('#requester').addEventListener('click', () => {
        document.body.innerHTML = '<h1>Email Login</h1><label>Email <input aria-label="Email"></label><button>Next</button>';
      });
      document.querySelector('#technician').addEventListener('click', () => location.href = ${JSON.stringify(`${external}/auth-boundary`)});
      document.querySelector('#reports').addEventListener('click', () => fetch('/api/surprise', { method: 'POST', body: 'private' }));
    </script>`;
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html" }); response.end(body);
}
async function listen(item: Server): Promise<void> {
  await new Promise<void>((resolve) => item.listen(0, "127.0.0.1", resolve));
}
async function close(item: Server | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => item?.close((error) => error ? reject(error) : resolve()) ?? resolve());
}
function serverUrl(item: Server): string {
  const address = item.address(); if (!address || typeof address === "string") throw new Error("No server address");
  return `http://127.0.0.1:${address.port}`;
}
function artifacts(name: string): string {
  const directory = path.join(tmpdir(), `runtime-discovery-${name}-${process.pid}-${directories.length}`);
  directories.push(directory); return directory;
}
