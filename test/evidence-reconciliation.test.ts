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

test("selects the unique most-specific compatible route and explains suppressed broad matches", () => {
  const input = routeFixture(["/foo/bar", "/foo/:id", "/:section/:id", "/*"],
    ["https://example.test/#/foo/bar?tab=open"]);
  const manifest = reconcileProductEvidence(input);
  const match = manifest.matches.find((item) => item.domain === "route")!;
  assert.equal(match.static[0]?.nodeId, "route-0");
  assert.equal(match.strength, "exact");
  assert.deepEqual(match.reasons, ["hash-route-match", "unique-most-specific-route", "less-specific-compatible-routes-suppressed"]);
  assert.equal(match.route?.runtimeUrl, "https://example.test/#/foo/bar?tab=open");
  assert.equal(match.route?.normalizedApplicationPath, "/foo/bar");
  assert.deepEqual(match.route?.candidates.map((item) => [item.staticRoutePattern, item.selection]), [
    ["/foo/bar", "selected"], ["/foo/:id", "compatible-but-less-specific"],
    ["/:section/:id", "compatible-but-less-specific"], ["/*", "compatible-but-less-specific"],
  ]);
});

test("uses positional structural dominance and preserves equal-specificity ambiguity", () => {
  const specific = reconcileProductEvidence(routeFixture(
    ["/tickets/view/:id", "/tickets/:section/:id", "/:module/:section/:id", "/*"],
    ["https://example.test/tickets/view/123"]));
  assert.equal(specific.matches[0]?.static[0]?.nodeId, "route-0");
  assert.deepEqual(specific.matches[0]?.route?.candidates[0]?.specificity.segmentConstraints,
    ["literal", "literal", "parameter"]);

  const equal = reconcileProductEvidence(routeFixture(["/foo/:id", "/:type/bar", "/*"],
    ["https://example.test/foo/bar"]));
  const ambiguous = equal.ambiguous.find((item) => item.runtime.some((ref) => ref.stateId === "state-0"))!;
  assert.deepEqual(ambiguous.static.map((item) => item.nodeId), ["route-0", "route-1"]);
  assert.deepEqual(ambiguous.route?.candidates.map((item) => item.selection),
    ["equally-specific", "equally-specific", "compatible-but-less-specific"]);
});

test("handles wildcard-only, root, runtime-only, static-only, fragments, trailing slashes, and immutable inputs", () => {
  const input = routeFixture(["/*", "/", "/unseen"], [
    "https://example.test/anything/deep/", "https://example.test/", "https://example.test/page#main",
    "https://example.test/missing",
  ]);
  const before = JSON.stringify(input);
  const first = reconcileProductEvidence(input);
  const second = reconcileProductEvidence(input);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(input), before);
  assert.equal(first.matches.find((item) => item.runtime[0]?.stateId === "state-0")?.static[0]?.nodeId, "route-0");
  assert.equal(first.matches.find((item) => item.runtime[0]?.stateId === "state-1")?.static[0]?.nodeId, "route-1");
  assert.equal(first.matches.find((item) => item.runtime[0]?.stateId === "state-2")?.route?.normalizedApplicationPath, "/page");
  assert.equal(first.matches.find((item) => item.runtime[0]?.stateId === "state-2")?.static[0]?.nodeId, "route-0");
  assert.equal(first.matches.find((item) => item.runtime[0]?.stateId === "state-3")?.static[0]?.nodeId, "route-0");
  assert.ok(first.staticOnly.some((item) => item.static[0]?.nodeId === "route-2"));

  const noWildcard = reconcileProductEvidence(routeFixture(["/known"], ["https://example.test/missing"]));
  assert.equal(noWildcard.runtimeOnly[0]?.route?.normalizedApplicationPath, "/missing");
  assert.equal(noWildcard.staticOnly[0]?.static[0]?.nodeId, "route-0");
});

test("does not use parameter names or runtime identifier values as specificity", () => {
  const manifest = reconcileProductEvidence(routeFixture(["/tickets/:ticketId", "/tickets/:id"], [
    "https://example.test/#/tickets/111", "https://example.test/#/tickets/999",
  ]));
  assert.equal(manifest.matches.filter((item) => item.domain === "route").length, 0);
  assert.equal(manifest.ambiguous.filter((item) => item.runtime.length > 0).length, 2);
  assert.ok(manifest.ambiguous.filter((item) => item.runtime.length > 0)
    .every((item) => item.route?.candidates.every((candidate) => candidate.selection === "equally-specific")));
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

test("scopes exact UI matching to selected routes and retains ambiguity, repetition, and visual provenance", () => {
  const { staticGraph, runtime } = contextualUiFixture();
  const manifest = reconcileProductEvidence({ staticGraph, runtimeDiscovery: runtime });
  const settingsSave = manifest.matches.filter((item) => item.domain === "ui" &&
    item.static[0]?.nodeId === "ui-settings-save");
  assert.equal(settingsSave.length, 2);
  assert.deepEqual(settingsSave.map((item) => item.runtime[0]?.elementId).sort(), ["runtime-save-a", "runtime-save-b"]);
  assert.ok(settingsSave.every((item) => item.uiContext?.staticRouteId === "route-context-settings" &&
    item.uiContext.candidates[0]?.reasons.includes("exact-accessible-name")));
  assert.deepEqual(settingsSave[0]?.uiContext?.candidates[0]?.staticComponentPath, [
    "component-context-settings",
    "component-context-settings-child",
  ]);
  assert.equal(settingsSave.some((item) => item.static.some((ref) => ref.nodeId === "ui-tickets-save")), false);

  const email = assertMatch(manifest, "ui", "ui-settings-email", "exact-label");
  assert.equal(email.runtime[0]?.elementId, "runtime-email");
  assert.equal(email.uiContext?.runtimeTargetId, "runtime-email");
  const cancel = manifest.ambiguous.find((item) => item.domain === "ui" &&
    item.runtime[0]?.elementId === "runtime-cancel")!;
  assert.deepEqual(cancel.static.map((item) => item.nodeId), ["ui-settings-cancel-a", "ui-settings-cancel-b"]);
  assert.ok(cancel.uiContext?.candidates.every((item) => item.selection === "equally-compatible"));
  const placeholder = manifest.ambiguous.find((item) => item.domain === "ui" &&
    item.runtime[0]?.elementId === "runtime-search")!;
  assert.ok(placeholder.uiContext?.candidates.every((item) => item.reasons.includes("exact-placeholder")));

  assert.ok(manifest.runtimeOnly.some((item) => item.runtime[0]?.elementId === "runtime-role-mismatch" &&
    item.reasons.includes("no-compatible-static-ui")));
  assert.ok(manifest.runtimeOnly.some((item) => item.runtime[0]?.elementId === "runtime-no-context" &&
    item.reasons.includes("insufficient-static-ui-context")));
  assert.ok(manifest.runtimeOnly.some((item) => item.runtime[0]?.elementId === "runtime-ambiguous-route" &&
    item.reasons.includes("ambiguous-route-context")));
  assert.ok(manifest.staticOnly.some((item) => item.static[0]?.nodeId === "ui-orphan-save"));
  assert.ok(manifest.uiContextMetrics.runtimeUiWithEligibleStaticContext > 0);
  assert.ok(manifest.uiContextMetrics.runtimeUiWithoutStaticContext > 0);
  assert.equal(manifest.uiContextMetrics.uniqueMatches, 4);
  assert.equal(manifest.uiContextMetrics.ambiguousMatches, 2);
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
  const invalidRoute: ReconciliationManifest = structuredClone(manifest);
  invalidRoute.matches.find((item) => item.domain === "route")!.route!.candidates[0]!.staticRouteId = "missing-route";
  assert.throws(() => validateReconciliationManifest(invalidRoute, staticGraph, runtime), /Missing route candidate/);
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

function routeFixture(patterns: string[], urls: string[]): { staticGraph: ProductEvidenceGraph; runtimeDiscovery: RuntimeNavigationDiscoveryGraph } {
  const nodes = patterns.map((path, index) => staticNode(`route-${index}`, "route", path,
    { path: { kind: "static", value: path } }));
  const states = urls.map((url, index) => state(`state-${index}`, url, `State ${index}`, 0, [], [], [], []));
  return { staticGraph: { root: "/route-fixture", nodes, edges: [], unresolved: [] }, runtimeDiscovery: {
    startUrl: urls[0] ?? "https://example.test/", startOrigin: "https://example.test",
    allowedOrigins: ["https://example.test"], limits: { maxDepth: 1, maxStates: 20, maxTransitions: 20, maxTargetsPerState: 10 },
    nodes: states, transitions: [], skippedTargets: [], stopReasons: ["completed"],
    summary: { statesDiscovered: states.length, transitionsObserved: 0, failedTransitions: 0, targetsSkipped: 0,
      blocked: 0, unknown: 0, boundaryStates: 0, mutationStopBranches: 0, maxDepthReached: 0 },
  } };
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

function contextualUiFixture(): { staticGraph: ProductEvidenceGraph; runtime: RuntimeNavigationDiscoveryGraph } {
  const nodes: ProductEvidenceNode[] = [
    staticNode("route-context-settings", "route", "/settings", { path: { kind: "static", value: "/settings" } }),
    staticNode("route-context-tickets", "route", "/tickets", { path: { kind: "static", value: "/tickets" } }),
    staticNode("route-context-one", "route", "/:one", { path: { kind: "static", value: "/:one" } }),
    staticNode("route-context-two", "route", "/:two", { path: { kind: "static", value: "/:two" } }),
    staticNode("component-context-settings", "component", "Settings", {}),
    staticNode("component-context-settings-child", "component", "SettingsChild", {}),
    staticNode("component-context-tickets", "component", "Tickets", {}),
    staticNode("ui-settings-save", "ui-element", 'button "Save"', { name: "button", props: [] }),
    staticNode("ui-tickets-save", "ui-element", 'button "Save"', { name: "button", props: [] }),
    staticNode("ui-settings-email", "ui-element", "input", { name: "input", props: [prop("label", "Email")] }),
    staticNode("ui-settings-cancel-a", "ui-element", 'button "Cancel"', { name: "button", props: [] }),
    staticNode("ui-settings-cancel-b", "ui-element", 'button "Cancel"', { name: "button", props: [] }),
    staticNode("ui-settings-search-a", "ui-element", "input", { name: "input", props: [prop("placeholder", "Search")] }),
    staticNode("ui-settings-search-b", "ui-element", "input", { name: "input", props: [prop("placeholder", "Search")] }),
    staticNode("ui-settings-mismatch", "ui-element", 'input "Mismatch"', { name: "input", props: [] }),
    staticNode("ui-orphan-save", "ui-element", 'button "Save"', { name: "button", props: [] }),
  ];
  const edges: ProductEvidenceEdge[] = [
    edge("context-render-settings", "ROUTE_RENDERS_COMPONENT", "route-context-settings", "component-context-settings"),
    edge("context-render-settings-child", "COMPONENT_RENDERS_COMPONENT", "component-context-settings",
      "component-context-settings-child"),
    edge("context-render-tickets", "ROUTE_RENDERS_COMPONENT", "route-context-tickets", "component-context-tickets"),
    ...["ui-settings-save", "ui-settings-email", "ui-settings-cancel-a", "ui-settings-cancel-b",
      "ui-settings-search-a", "ui-settings-search-b", "ui-settings-mismatch"]
      .map((id) => edge(`context-contains-${id}`, "CONTAINS_ELEMENT", "component-context-settings-child", id)),
    edge("context-contains-ticket-save", "CONTAINS_ELEMENT", "component-context-tickets", "ui-tickets-save"),
  ];
  const settings = state("state-context-settings", "https://app.test/settings", "Settings", 0, [
    element("runtime-save-a", "button", "button", "Save", "Save"),
    element("runtime-save-b", "button", "button", "Save", "Save"),
    element("runtime-email", "input", "textbox", "Email", ""),
    element("runtime-cancel", "button", "button", "Cancel", "Cancel"),
    element("runtime-search", "input", "textbox", "", "", "", "Search"),
    element("runtime-role-mismatch", "button", "button", "Mismatch", "Mismatch"),
  ], [], [], []);
  const tickets = state("state-context-tickets", "https://app.test/tickets", "Tickets", 0,
    [element("runtime-ticket-save", "button", "button", "Save", "Save")], [], [], []);
  const noContext = state("state-context-none", "https://app.test/no/context", "None", 0,
    [element("runtime-no-context", "button", "button", "Save", "Save")], [], [], []);
  const ambiguous = state("state-context-ambiguous", "https://app.test/dynamic", "Dynamic", 0,
    [element("runtime-ambiguous-route", "button", "button", "Save", "Save")], [], [], []);
  return { staticGraph: { root: "/context", nodes, edges, unresolved: [] }, runtime: {
    startUrl: settings.url, startOrigin: "https://app.test", allowedOrigins: ["https://app.test"],
    limits: { maxDepth: 1, maxStates: 10, maxTransitions: 10, maxTargetsPerState: 10 },
    nodes: [settings, tickets, noContext, ambiguous], transitions: [], skippedTargets: [], stopReasons: ["completed"],
    summary: { statesDiscovered: 4, transitionsObserved: 0, failedTransitions: 0, targetsSkipped: 0, blocked: 0,
      unknown: 0, boundaryStates: 0, mutationStopBranches: 0, maxDepthReached: 0 },
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
