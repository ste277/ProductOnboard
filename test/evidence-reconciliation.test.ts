import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatReconciliationSummary,
  getAmbiguousEvidence,
  getCorroboratedEvidence,
  getRuntimeOnlyEvidence,
  getStaticOnlyEvidence,
  reconcileProductEvidence,
  validateReconciliationManifest,
  type ReconciliationManifest,
} from "../src/evidence-reconciliation.js";
import type { ProductEvidenceEdge, ProductEvidenceGraph, ProductEvidenceNode } from "../src/product-evidence-graph.js";
import type { RuntimeNavigationDiscoveryGraph, RuntimeStateNode, RuntimeTransitionEdge } from "../src/runtime-discovery.js";
import type { RuntimeNetworkObservation } from "../src/runtime-capture.js";

test("reconciles the integrated tickets acceptance scenario with full provenance", () => {
  const { staticGraph, runtime } = fixture();
  const beforeStatic = JSON.stringify(staticGraph);
  const beforeRuntime = JSON.stringify(runtime);
  const manifest = reconcileProductEvidence({ staticGraph, runtimeDiscovery: runtime });

  assertMatch(manifest, "route", "route-tickets-new", "route-path-exact");
  assertMatch(manifest, "ui", "ui-subject", "accessible-name-exact");
  assertMatch(manifest, "ui", "ui-client", "placeholder-match");
  assertMatch(manifest, "ui", "ui-create", "element-text-exact");
  const http = assertMatch(manifest, "http", "http-create", "http-path-match");
  assert.ok(http.runtime.some((item) => item.networkObservationId === "network-api-create" &&
    item.stateId === "state-tickets-new" && item.sourceId === "capture-state-tickets-new"));
  assert.ok(http.static[0]?.evidence.length);
  assert.equal(JSON.stringify(staticGraph), beforeStatic);
  assert.equal(JSON.stringify(runtime), beforeRuntime);
  assert.doesNotThrow(() => JSON.stringify(manifest));
});

test("supports exact, hash, parameterized, multiple-state, static-only, runtime-only, and dynamic routes", () => {
  const { staticGraph, runtime } = fixture();
  const manifest = reconcileProductEvidence({ staticGraph, runtimeDiscovery: runtime });
  assert.ok(manifest.matches.some((item) => item.domain === "route" && item.reasons.includes("hash-route-match")));
  assert.ok(manifest.matches.some((item) => item.domain === "route" && item.reasons.includes("route-parameter-match")));
  assert.equal(manifest.matches.filter((item) => item.domain === "route" &&
    item.static.some((ref) => ref.nodeId === "route-login")).length, 2);
  assert.ok(manifest.staticOnly.some((item) => item.static.some((ref) => ref.nodeId === "route-hidden")));
  assert.ok(manifest.runtimeOnly.some((item) => item.domain === "route" &&
    item.runtime.some((ref) => ref.stateId === "state-profile")));
  assert.ok(manifest.ambiguous.some((item) => item.static.some((ref) => ref.nodeId === "route-dynamic")));
  assert.equal(manifest.textSummary.includes("ROUTE"), true);
  assert.doesNotMatch(JSON.stringify(manifest), /private-token/);
});

test("matches semantic elements and strong candidates only inside route context and preserves ambiguity", () => {
  const { staticGraph, runtime } = fixture();
  const manifest = reconcileProductEvidence({ staticGraph, runtimeDiscovery: runtime });
  const candidate = assertMatch(manifest, "ui", "ui-login", "interaction-evidence-match");
  assert.ok(candidate.runtime.some((item) => item.candidateId === "candidate-login"));
  assert.ok(manifest.ambiguous.some((item) => item.domain === "ui" && item.reasons.includes("duplicate-label-ambiguous") &&
    item.static.length === 2));
  assert.ok(manifest.staticOnly.some((item) => item.static.some((ref) => ref.nodeId === "ui-hidden")));
  assert.ok(manifest.staticOnly.some((item) => item.static.some((ref) => ref.nodeId === "ui-dynamic")));
  assert.ok(manifest.runtimeOnly.some((item) => item.runtime.some((ref) => ref.candidateId === "candidate-generated")));
});

test("reconciles navigation destinations and labels while retaining same-URL transitions", () => {
  const { staticGraph, runtime } = fixture();
  const manifest = reconcileProductEvidence({ staticGraph, runtimeDiscovery: runtime });
  const navigation = assertMatch(manifest, "navigation", "navigation-new-ticket", "navigation-destination-match");
  assert.ok(navigation.reasons.includes("navigation-label-match"));
  assert.ok(manifest.runtimeOnly.some((item) => item.domain === "navigation" &&
    item.reasons.includes("same-url-transition-no-static-navigation")));
});

test("reconciles HTTP method and path while preserving method mismatches, telemetry, and resource filtering", () => {
  const { staticGraph, runtime } = fixture();
  const manifest = reconcileProductEvidence({ staticGraph, runtimeDiscovery: runtime });
  assertMatch(manifest, "http", "http-create", "http-method-match");
  assert.ok(manifest.staticOnly.some((item) => item.static.some((ref) => ref.nodeId === "http-hidden")));
  assert.ok(manifest.ambiguous.some((item) => item.static.some((ref) => ref.nodeId === "http-dynamic")));
  assert.ok(manifest.runtimeOnly.some((item) => item.domain === "http" &&
    item.runtime.some((ref) => ref.networkObservationId === "network-telemetry")));
  assert.equal(allResults(manifest).some((item) => item.runtime.some((ref) => ref.networkObservationId === "network-script")), false);
  assert.equal(manifest.matches.some((item) => item.static.some((ref) => ref.nodeId === "http-wrong-method")), false);
});

test("corroborates GraphQL transport without claiming a named operation", () => {
  const { staticGraph, runtime } = fixture();
  const manifest = reconcileProductEvidence({ staticGraph, runtimeDiscovery: runtime });
  const transport = manifest.matches.find((item) => item.domain === "graphql");
  assert.ok(transport);
  assert.equal(transport.static.length, 2);
  assert.ok(transport.reasons.includes("graphql-endpoint-match"));
  assert.ok(transport.reasons.includes("named-operation-not-proven"));
  assert.equal(transport.strength, "strong");
  assert.ok(manifest.staticOnly.some((item) => item.domain === "graphql" &&
    item.static.some((ref) => ref.nodeId === "graphql-execution-unresolved")));
});

test("retains bounded coverage, readiness, branch stops, provenance, and deterministic query helpers", () => {
  const { staticGraph, runtime } = fixture();
  const first = reconcileProductEvidence({ staticGraph, runtimeDiscovery: runtime });
  const second = reconcileProductEvidence({ staticGraph, runtimeDiscovery: runtime });
  assert.deepEqual(second, first);
  assert.equal(first.coverage.bounded, true);
  assert.equal(first.coverage.statesObserved, runtime.nodes.length);
  assert.equal(first.coverage.partialStates.length, 1);
  assert.equal(first.coverage.mutationStops, 1);
  assert.equal(first.coverage.originBoundaries, 1);
  assert.deepEqual(getCorroboratedEvidence(first), first.matches);
  assert.deepEqual(getStaticOnlyEvidence(first), first.staticOnly);
  assert.deepEqual(getRuntimeOnlyEvidence(first), first.runtimeOnly);
  assert.deepEqual(getAmbiguousEvidence(first), first.ambiguous);
  assert.equal(formatReconciliationSummary(first), first.textSummary);
  assert.equal(Object.hasOwn(first.matches[0] ?? {}, "confidence"), false);
});

test("validation rejects duplicate IDs, missing references, and impossible status combinations", () => {
  const { staticGraph, runtime } = fixture();
  const manifest = reconcileProductEvidence({ staticGraph, runtimeDiscovery: runtime });
  const duplicate: ReconciliationManifest = structuredClone(manifest);
  duplicate.staticOnly.push(structuredClone(duplicate.staticOnly[0]!));
  assert.throws(() => validateReconciliationManifest(duplicate, staticGraph, runtime), /Duplicate reconciliation result ID/);
  const missing: ReconciliationManifest = structuredClone(manifest);
  missing.matches[0]!.static[0]!.nodeId = "missing-static";
  assert.throws(() => validateReconciliationManifest(missing, staticGraph, runtime), /Missing static reference/);
  const impossible: ReconciliationManifest = structuredClone(manifest);
  impossible.staticOnly[0]!.runtime.push({ stateId: "state-home" });
  assert.throws(() => validateReconciliationManifest(impossible, staticGraph, runtime), /invalid references/);
});

function assertMatch(manifest: ReconciliationManifest, domain: string, staticId: string, reason: string) {
  const item = manifest.matches.find((candidate) => candidate.domain === domain &&
    candidate.static.some((ref) => ref.nodeId === staticId));
  assert.ok(item, `Missing ${domain} match for ${staticId}`);
  assert.ok(item.reasons.includes(reason));
  assert.ok(item.strength);
  assert.ok(item.static.length && item.runtime.length);
  return item;
}

function fixture(): { staticGraph: ProductEvidenceGraph; runtime: RuntimeNavigationDiscoveryGraph } {
  const nodes: ProductEvidenceNode[] = [
    staticNode("route-home", "route", "/", { path: { kind: "static", value: "/" } }),
    staticNode("route-tickets-new", "route", "/tickets/new", { path: { kind: "static", value: "/tickets/new" } }),
    staticNode("route-ticket-id", "route", "/tickets/:id", { path: { kind: "static", value: "/tickets/:id" } }),
    staticNode("route-login", "route", "/login", { path: { kind: "static", value: "/login" } }),
    staticNode("route-hidden", "route", "/hidden", { path: { kind: "static", value: "/hidden" } }),
    staticNode("route-dynamic", "route", "dynamic", { path: { kind: "dynamic", expression: "routePath" } }),
    staticNode("component-ticket", "component", "TicketCreate", {}),
    staticNode("component-home", "component", "Home", {}),
    staticNode("ui-subject", "ui-element", "input", { component: "TicketCreate", name: "input",
      props: [prop("aria-label", "Subject"), prop("type", "text")] }),
    staticNode("ui-client", "ui-element", "input", { component: "TicketCreate", name: "input",
      props: [prop("placeholder", "Client"), prop("type", "text")] }),
    staticNode("ui-create", "ui-element", 'button "Create Ticket"', { component: "TicketCreate", name: "button", props: [] }),
    staticNode("ui-save-1", "ui-element", 'button "Save"', { component: "TicketCreate", name: "button", props: [] }),
    staticNode("ui-save-2", "ui-element", 'button "Save"', { component: "TicketCreate", name: "button", props: [] }),
    staticNode("ui-hidden", "ui-element", 'button "Hidden"', { component: "TicketCreate", name: "button", props: [] }),
    staticNode("ui-dynamic", "ui-element", "button", { component: "TicketCreate", name: "button", props: [] }),
    staticNode("ui-login", "ui-element", 'div "Login as requester"', { component: "Home", name: "div", props: [] }),
    staticNode("event-login", "ui-event", "onClick", {}),
    staticNode("navigation-new-ticket", "navigation", "New Ticket", {
      label: { kind: "static", value: "New Ticket" }, destination: { kind: "static", value: "/tickets/new" },
    }),
    staticNode("http-create", "http-request", "POST /api/tickets", {
      method: { kind: "static", value: "POST" }, url: { kind: "static", value: "/api/tickets" },
    }),
    staticNode("http-hidden", "http-request", "GET /api/hidden", {
      method: { kind: "static", value: "GET" }, url: { kind: "static", value: "/api/hidden" },
    }),
    staticNode("http-wrong-method", "http-request", "GET /api/tickets", {
      method: { kind: "static", value: "GET" }, url: { kind: "static", value: "/api/tickets" },
    }),
    staticNode("http-dynamic", "http-request", "GET dynamic", {
      method: { kind: "static", value: "GET" }, url: { kind: "dynamic", expression: "endpoint" },
    }),
    staticNode("graphql-execution-query", "graphql-execution", "client.query", { transport: transport("/graphql") }),
    staticNode("graphql-execution-mutation", "graphql-execution", "client.mutate", { transport: transport("/graphql") }),
    staticNode("graphql-execution-unresolved", "graphql-execution", "other.query", {}),
  ];
  const edges: ProductEvidenceEdge[] = [
    edge("route-ticket-component", "ROUTE_RENDERS_COMPONENT", "route-tickets-new", "component-ticket"),
    edge("route-home-component", "ROUTE_RENDERS_COMPONENT", "route-home", "component-home"),
    ...["ui-subject", "ui-client", "ui-create", "ui-save-1", "ui-save-2", "ui-hidden", "ui-dynamic"]
      .map((id) => edge(`contains-${id}`, "CONTAINS_ELEMENT", "component-ticket", id)),
    edge("contains-login", "CONTAINS_ELEMENT", "component-home", "ui-login"),
    edge("has-login-event", "HAS_EVENT", "ui-login", "event-login"),
    edge("navigation-route", "NAVIGATES_TO", "navigation-new-ticket", "route-tickets-new"),
  ];
  const staticGraph: ProductEvidenceGraph = { root: "/fixture", nodes, edges, unresolved: [] };

  const home = state("state-home", "https://app.test/", "Home", 0, [], [], [
    candidate("candidate-login", "Login as requester", "div", "strong"),
    candidate("candidate-generated", "Generated Control", "div", "strong"),
  ], [network("network-home", "GET", "https://app.test/", "document", 200)]);
  const ticket = state("state-tickets-new", "https://app.test/tickets/new?token=%5BREDACTED%5D", "New Ticket", 1,
    [element("element-subject", "input", "textbox", "Subject", "", "text", ""),
      element("element-client", "input", "textbox", "Client", "", "text", "Client"),
      element("element-create", "button", "button", "Create Ticket", "Create Ticket"),
      element("element-save", "button", "button", "Save", "Save")], [], [],
    [network("network-api-create", "POST", "https://app.test/api/tickets", "fetch", 201),
      network("network-telemetry", "POST", "https://telemetry.test/collect", "fetch", 204),
      network("network-script", "GET", "https://app.test/app.js", "script", 200),
      network("network-graphql", "POST", "https://app.test/graphql", "fetch", 200)], true, ["mutation-observed"]);
  const ticketStateTwo = state("state-ticket-123", "https://app.test/tickets/123", "Ticket", 1, [], [], [], []);
  const loginOne = state("state-login-one", "https://app.test/#/login", "Login", 1, [], [], [], []);
  const loginTwo = state("state-login-two", "https://app.test/#/login", "Login Email", 1, [], [], [], []);
  const profile = state("state-profile", "https://auth.test/profile", "Profile", 1, [], [], [], [], false, ["origin-boundary"]);
  const transitions = [
    transition("transition-ticket", home.id, ticket.id, "New Ticket", "same-origin-url-change"),
    transition("transition-login", home.id, loginOne.id, "Login as requester", "same-url"),
  ];
  return { staticGraph, runtime: {
    startUrl: "https://app.test/", startOrigin: "https://app.test", allowedOrigins: ["https://app.test"],
    limits: { maxDepth: 2, maxStates: 20, maxTransitions: 40, maxTargetsPerState: 10 },
    nodes: [home, ticket, ticketStateTwo, loginOne, loginTwo, profile], transitions, skippedTargets: [],
    stopReasons: ["completed"], summary: { statesDiscovered: 6, transitionsObserved: 2,
      failedTransitions: 0, targetsSkipped: 0, blocked: 0, unknown: 0, boundaryStates: 1,
      mutationStopBranches: 1, maxDepthReached: 1 },
  } };
}

function staticNode(id: string, type: ProductEvidenceNode["type"], label: string, data: Record<string, unknown>): ProductEvidenceNode {
  const location = { path: "src/app.tsx", startLine: 1, endLine: 1 };
  return { id, type, label, location, evidence: [{ source: type === "http-request" ? "http-request" :
    type.startsWith("graphql") ? "graphql-operation" : type === "route" || type === "navigation" ? "route-navigation" :
      type === "ui-event" ? "action-binding" : "ui-structure", strength: "direct", location }], data };
}
function edge(id: string, type: ProductEvidenceEdge["type"], from: string, to: string): ProductEvidenceEdge {
  return { id, type, from, to, evidence: [] };
}
function prop(name: string, value: string) { return { name, valueType: "string", value, location: { path: "src/app.tsx", startLine: 1, endLine: 1 } }; }
function transport(value: string) { return { client: "ApolloClient", configuration: "uri", endpoint: { kind: "static", value },
  location: { path: "src/client.ts", startLine: 2, endLine: 2 } }; }

function state(id: string, url: string, title: string, depth: number,
  semanticElements: RuntimeStateNode["semanticElements"], _unused: never[], interactionCandidates: RuntimeStateNode["interactionCandidates"],
  networkItems: RuntimeNetworkObservation[], partial = false, stopReasons: RuntimeStateNode["stopReasons"] = []): RuntimeStateNode {
  return { id, fingerprint: id.replace("state-", "fingerprint-"), url, title, depth,
    boundary: stopReasons.includes("origin-boundary"), expandable: stopReasons.length === 0, stopReasons,
    screenshot: { path: `/tmp/${id}.png`, width: 1440, height: 900, fullPage: false, captured: true, provenance: "screenshot" },
    readiness: { status: partial ? "partial" : "ready", reason: partial ? "network-active" : "network-idle", timeoutMs: 2000 },
    semanticElements, interactionCandidates, accessibility: { format: "playwright-aria-snapshot-v1", snapshot: title, provenance: "accessibility" },
    visibleText: [], runtimeCaptureId: `capture-${id}`, network: networkItems,
    networkObservations: [{ sourceId: `capture-${id}`, sourceType: "runtime-capture", network: networkItems }], provenance: "runtime-capture" };
}
function element(id: string, type: string, role: string, accessibleName: string, visibleText: string,
  inputType = "", placeholder = ""): RuntimeStateNode["semanticElements"][number] {
  return { id, type, role, accessibleName, ...(visibleText ? { visibleText } : {}), domPath: `html>body>${type}`, visible: true,
    enabled: true, boundingBox: { x: 0, y: 0, width: 100, height: 20 }, provenance: ["dom", "accessibility"],
    ...(inputType ? { inputType } : {}), ...(placeholder ? { placeholder } : {}) };
}
function candidate(id: string, text: string, tag: string, strength: "strong" | "supporting" | "weak"): RuntimeStateNode["interactionCandidates"][number] {
  return { id, tag, text, role: null, accessibleName: null, domPath: `html>body>${tag}`, tabindex: null,
    boundingBox: { x: 0, y: 0, width: 100, height: 20 }, signals: [{ type: "direct-click-listener", provenance: "browser-event-listener" }],
    strength, destination: null, provenance: ["browser-event-listener"] };
}
function network(id: string, method: string, url: string, resourceType: string, status: number | null): RuntimeNetworkObservation {
  return { id, method, url, resourceType, status, provenance: "network" };
}
function transition(id: string, from: string, to: string, label: string,
  kind: NonNullable<RuntimeTransitionEdge["transition"]>["kind"]): RuntimeTransitionEdge {
  return { id, from, to, target: { source: "semantic-element", ...element(`target-${id}`, "a", "link", label, label),
    declaredHref: "/tickets/new", resolvedHref: "https://app.test/tickets/new" },
    safety: { decision: "allowed", reasons: ["safe-same-origin-navigation"], provenance: "safety-rule" },
    interactionPerformed: true, transition: { kind, beforeUrl: "https://app.test/", afterUrl: "https://app.test/tickets/new",
      urlChanged: kind !== "same-url", titleChanged: false, uiChanged: true, semanticElementsChanged: true,
      interactionCandidatesChanged: true, networkObserved: false, dialogAppeared: false, popupAppeared: false,
      mutationMethods: [], highSeveritySafetyIssue: false, network: [], provenance: ["before-runtime", "after-runtime", "network", "accessibility"] },
    status: "observed", stopReasons: [], baselineMutationMethods: [], mutationMethods: [], runtimeProbeId: `probe-${id}`,
    network: [], provenance: "runtime-probe" };
}
function allResults(manifest: ReconciliationManifest) { return [...manifest.matches, ...manifest.staticOnly, ...manifest.runtimeOnly, ...manifest.ambiguous]; }
