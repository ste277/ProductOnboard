import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFeatureModel,
  formatFeatureModel,
  getFeature,
  getFeaturesByEvidenceStatus,
  getFeaturesByRoute,
  validateFeatureModel,
  type FeatureModel,
} from "../src/feature-model.js";
import { reconcileProductEvidence } from "../src/evidence-reconciliation.js";
import type { ProductEvidenceEdge, ProductEvidenceGraph, ProductEvidenceNode } from "../src/product-evidence-graph.js";
import type { RuntimeNavigationDiscoveryGraph, RuntimeStateNode, RuntimeTransitionEdge } from "../src/runtime-discovery.js";
import type { RuntimeNetworkObservation } from "../src/runtime-capture.js";

test("builds the deterministic Create Ticket feature without mutating inputs", () => {
  const input = fixture();
  const before = JSON.stringify(input);
  const first = buildFeatureModel(input);
  const second = buildFeatureModel(input);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(input), before);
  assert.doesNotThrow(() => JSON.stringify(first));

  const feature = getFeaturesByRoute(first, "/tickets/new")[0]!;
  assert.equal(feature.name, "Create Ticket");
  assert.deepEqual(feature.nameSource, { type: "navigation-label", evidenceId: "nav-create" });
  assert.ok(feature.entryPoints.some((item) => item.label === "Create Ticket" && item.destination === "/tickets/new"));
  assert.ok(feature.routes.some((item) => item.status === "corroborated"));
  assert.ok(feature.ui.some((item) => item.label === "Subject" && item.status === "corroborated"));
  assert.ok(feature.ui.some((item) => item.label === "Client" && item.status === "corroborated"));
  assert.ok(feature.actions.some((item) => item.label === "handleCreate"));
  assert.ok(feature.actions.some((item) => item.label === "createTicket"));
  assert.ok(feature.api.some((item) => item.label === "POST /api/tickets" && item.status === "corroborated"));
  assert.ok(feature.graphql.some((item) => item.label === "CreateTicket"));
  assert.equal(feature.screenshots[0]?.runtimeStateId, "state-create");
  assert.equal(feature.screenshots[0]?.path, "/tmp/create.png");
  assert.deepEqual(getFeature(first, feature.id), feature);
  assert.deepEqual(getFeaturesByEvidenceStatus(first, "static-and-runtime"),
    first.features.filter((item) => item.evidenceStatus.static && item.evidenceStatus.runtime));
});

test("keeps Tickets and Create Ticket distinct with evidenced navigation and runtime relationships", () => {
  const model = buildFeatureModel(fixture());
  const tickets = getFeaturesByRoute(model, "/tickets")[0]!;
  const create = getFeaturesByRoute(model, "/tickets/new")[0]!;
  assert.equal(tickets.name, "Tickets");
  assert.notEqual(tickets.id, create.id);
  assert.ok(model.relationships.some((item) => item.fromFeatureId === tickets.id && item.toFeatureId === create.id &&
    item.type === "runtime-transition-to" && item.runtimeTransitionId === "transition-create"));
  assert.equal(model.relationships.every((item) => ["navigation-to", "runtime-transition-to"].includes(item.type)), true);
});

test("creates conservative static-only and runtime-only features and retains bounded coverage", () => {
  const model = buildFeatureModel(fixture());
  const settings = getFeaturesByRoute(model, "/settings")[0]!;
  assert.equal(settings.name, "Settings");
  assert.equal(settings.evidenceStatus.static, true);
  assert.equal(settings.evidenceStatus.runtime, false);
  const login = model.features.find((item) => item.name === "Login as requester")!;
  assert.ok(login);
  assert.equal(login.evidenceStatus.static, false);
  assert.equal(login.evidenceStatus.runtime, true);
  assert.ok(login.ui.some((item) => item.label === "Email"));
  assert.ok(login.ui.some((item) => item.label === "Next"));
  assert.deepEqual(model.coverage, fixture().reconciliation.coverage);
  assert.ok(getFeaturesByEvidenceStatus(model, "static-only").includes(settings));
  assert.ok(getFeaturesByEvidenceStatus(model, "runtime-only").includes(login));
});

test("uses deterministic naming priority and preserves same-route state identity", () => {
  const input = fixture();
  const route = input.staticGraph.nodes.find((item) => item.id === "route-login")!;
  input.runtimeDiscovery.nodes.push(state("state-login-choice", "https://app.test/login", "Login", [
    element("heading-choice", "h1", "heading", "Login as requester", "Login as requester"),
  ], []), state("state-login-next", "https://app.test/login", "Login", [
    element("heading-email", "h1", "heading", "Email", "Email"), element("next-two", "button", "button", "Next", "Next"),
  ], []));
  input.reconciliation = reconcileProductEvidence({ staticGraph: input.staticGraph, runtimeDiscovery: input.runtimeDiscovery });
  const model = buildFeatureModel(input);
  const loginFeatures = model.features.filter((item) => item.routes.some((entry) =>
    entry.static.some((ref) => ref.nodeId === route.id)));
  assert.equal(loginFeatures.length, 2);
  assert.notEqual(loginFeatures[0]!.id, loginFeatures[1]!.id);
  assert.equal(loginFeatures.every((item) => item.nameSource.type === "runtime-heading"), true);
});

test("derives selected parameterized route identity from literals and stable bindings", () => {
  const input = routeIdentityFixture(["/onboard/:page", "/:section"], [
    ["state-mail", "https://app.test/#/onboard/mailserver"],
    ["state-timesheet", "https://app.test/#/timesheet"],
  ]);
  const before = JSON.stringify(input);
  const first = buildFeatureModel(input);
  const second = buildFeatureModel(input);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(input), before);

  const settings = getFeaturesByRoute(first, "/onboard/:page")[0]!;
  assert.equal(settings.name, "Onboard / Mailserver");
  assert.equal(settings.nameSource.type, "route-bound-value");
  assert.equal(settings.routeIdentity?.staticRoutePattern, "/onboard/:page");
  assert.deepEqual(settings.routeIdentity?.runtimePaths, ["/onboard/mailserver"]);
  assert.deepEqual(settings.routeIdentity?.bindings.map((item) => [item.parameter, item.value, item.classification]),
    [["page", "mailserver", "stable-slug"]]);

  const timesheet = getFeaturesByRoute(first, "/:section")[0]!;
  assert.equal(timesheet.name, "Timesheet");
  assert.equal(timesheet.nameSource.type, "route-bound-value");

  const root = buildFeatureModel(routeIdentityFixture(["/"], [["state-root", "https://app.test/#/"]])).features[0]!;
  assert.equal(root.name, "Root");
  assert.equal(root.nameSource.type, "route-literal");
});

test("uses stable runtime structure while excluding opaque ticket identifiers and grouping instances", () => {
  const input = routeIdentityFixture(["/:type/:id/:page"], [
    ["state-ticket-a", "https://app.test/#/tickets/123456/ticket"],
    ["state-ticket-b", "https://app.test/#/tickets/987654/ticket"],
  ]);
  const model = buildFeatureModel(input);
  const features = getFeaturesByRoute(model, "/:type/:id/:page");
  assert.equal(features.length, 1);
  const feature = features[0]!;
  assert.equal(feature.name, "Tickets / Ticket");
  assert.equal(feature.nameSource.type, "runtime-route-structure");
  assert.equal(feature.runtimeStates.length, 2);
  assert.deepEqual(feature.routeIdentity?.runtimePaths, ["/tickets/[opaque]/ticket"]);
  assert.equal(feature.routeIdentity?.bindings.filter((item) => item.parameter === "id")
    .every((item) => item.classification === "opaque-identifier" && item.value === undefined), true);
  assert.doesNotMatch(feature.id + feature.name + JSON.stringify(feature.routeIdentity), /123456|987654/);
});

test("never names features from numeric, UUID, hash-like, or redacted parameter values", () => {
  const input = routeIdentityFixture(["/tickets/:id"], [
    ["state-number", "https://app.test/#/tickets/123456"],
    ["state-uuid", "https://app.test/#/tickets/550e8400-e29b-41d4-a716-446655440000"],
    ["state-hash", "https://app.test/#/tickets/a4d91f3028c74011bb93"],
    ["state-redacted", "https://app.test/#/tickets/%5Bredacted%5D"],
  ]);
  const feature = getFeaturesByRoute(buildFeatureModel(input), "/tickets/:id")[0]!;
  assert.equal(feature.name, "Tickets");
  assert.equal(feature.nameSource.type, "route-literal");
  assert.equal(feature.runtimeStates.length, 4);
  assert.equal(feature.routeIdentity?.bindings.every((item) => item.value === undefined), true);
  assert.deepEqual([...new Set(feature.routeIdentity?.bindings.map((item) => item.classification))].sort(),
    ["opaque-identifier", "redacted"]);
});

test("preserves ambiguous route ownership and existing runtime heading precedence", () => {
  const input = routeIdentityFixture(["/:page", "/:section"], [
    ["state-ambiguous", "https://app.test/#/timesheet"],
  ], true);
  const model = buildFeatureModel(input);
  const runtime = model.features.find((item) => item.runtimeStates.includes("state-ambiguous"))!;
  assert.equal(runtime.name, "Timesheet");
  assert.equal(runtime.nameSource.type, "runtime-heading");
  assert.equal(runtime.routeIdentity, undefined);
  assert.ok(input.reconciliation.ambiguous.some((item) => item.domain === "route" && item.runtime.length > 0));
  assert.equal(getFeaturesByRoute(model, "/:page")[0]?.evidenceStatus.runtime, false);
  assert.equal(getFeaturesByRoute(model, "/:section")[0]?.evidenceStatus.runtime, false);
});

test("does not create features for helpers or API wrappers and leaves noise and ambiguity unassigned", () => {
  const model = buildFeatureModel(fixture());
  assert.equal(model.features.some((item) => item.name === "orphanHelper" || item.name === "GET /api/orphan"), false);
  assert.ok(model.unassignedEvidence.some((item) => item.evidenceId === "callable-orphan" &&
    item.reason === "internal-evidence-without-feature-root"));
  assert.ok(model.unassignedEvidence.some((item) => item.evidenceId === "http-orphan"));
  assert.ok(model.unassignedEvidence.some((item) => item.kind === "reconciliation" && item.status === "ambiguous" &&
    item.reason === "ambiguous-evidence-not-force-assigned"));
  assert.ok(model.unassignedEvidence.some((item) => item.kind === "reconciliation" && item.evidenceId.includes("reconciliation-result")));
  const create = getFeaturesByRoute(model, "/tickets/new")[0]!;
  assert.equal(create.api.some((item) => item.label.includes("telemetry")), false);
});

test("deduplicates duplicate route declarations and permits an unresolved navigation root", () => {
  const input = fixture();
  input.staticGraph.nodes.push(staticNode("route-create-duplicate", "route", "/tickets/new", { path: value("/tickets/new") }),
    staticNode("nav-help", "navigation", "Help", { label: value("Help"), destination: value("/help") }));
  input.reconciliation = reconcileProductEvidence({ staticGraph: input.staticGraph, runtimeDiscovery: input.runtimeDiscovery });
  const model = buildFeatureModel(input);
  assert.equal(getFeaturesByRoute(model, "/tickets/new").length, 1);
  const help = model.features.find((item) => item.name === "Help")!;
  assert.ok(help);
  assert.equal(help.root.type, "static-navigation");
  assert.equal(help.nameSource.type, "navigation-label");
});

test("attaches GraphQL statically without inventing named runtime execution", () => {
  const model = buildFeatureModel(fixture());
  const feature = getFeaturesByRoute(model, "/tickets/new")[0]!;
  assert.ok(feature.graphql.some((item) => item.label === "CreateTicket"));
  const execution = feature.graphql.find((item) => item.label === "client.mutate")!;
  assert.ok(execution);
  assert.equal(execution.runtime.some((item) => item.networkObservationId === "network-graphql"), true);
  assert.equal(feature.graphql.find((item) => item.label === "CreateTicket")?.runtime.length, 0);
});

test("formatter and ordering are deterministic", () => {
  const model = buildFeatureModel(fixture());
  assert.equal(formatFeatureModel(model), model.textSummary);
  assert.match(model.textSummary, /FEATURE: Create Ticket/);
  assert.match(model.textSummary, /POST \/api\/tickets - corroborated/);
  const ordered = [...model.features].sort((a, b) => {
    const left = `${a.routes[0]?.label ?? "~"}|${a.name}|${a.id}`;
    const right = `${b.routes[0]?.label ?? "~"}|${b.name}|${b.id}`;
    return left.localeCompare(right);
  });
  assert.deepEqual(model.features, ordered);
});

test("validation rejects invalid static, runtime, reconciliation, screenshot, name-source, and duplicate IDs", () => {
  const input = fixture();
  const model = buildFeatureModel(input);
  const invalidStatic: FeatureModel = structuredClone(model);
  invalidStatic.features[0]!.provenance.staticNodeIds.push("missing-static");
  assert.throws(() => validateFeatureModel(invalidStatic, input.staticGraph, input.runtimeDiscovery, input.reconciliation), /Invalid static reference/);
  const invalidRuntime: FeatureModel = structuredClone(model);
  invalidRuntime.features[0]!.runtimeStates.push("missing-runtime");
  assert.throws(() => validateFeatureModel(invalidRuntime, input.staticGraph, input.runtimeDiscovery, input.reconciliation), /Invalid runtime reference/);
  const invalidReconciliation: FeatureModel = structuredClone(model);
  invalidReconciliation.features[0]!.provenance.reconciliationResultIds.push("missing-reconciliation");
  assert.throws(() => validateFeatureModel(invalidReconciliation, input.staticGraph, input.runtimeDiscovery, input.reconciliation), /Invalid reconciliation reference/);
  const invalidScreenshot: FeatureModel = structuredClone(model);
  const withScreenshot = invalidScreenshot.features.find((item) => item.screenshots.length)!;
  withScreenshot.screenshots[0]!.path = "/tmp/wrong.png";
  assert.throws(() => validateFeatureModel(invalidScreenshot, input.staticGraph, input.runtimeDiscovery, input.reconciliation), /Invalid screenshot/);
  const invalidName: FeatureModel = structuredClone(model);
  invalidName.features[0]!.nameSource.evidenceId = "missing-name-source";
  assert.throws(() => validateFeatureModel(invalidName, input.staticGraph, input.runtimeDiscovery, input.reconciliation), /Invalid name source/);
  const duplicate: FeatureModel = structuredClone(model);
  duplicate.features.push(structuredClone(duplicate.features[0]!));
  assert.throws(() => validateFeatureModel(duplicate, input.staticGraph, input.runtimeDiscovery, input.reconciliation), /Duplicate feature ID/);
});

function fixture() {
  const nodes: ProductEvidenceNode[] = [
    staticNode("route-tickets", "route", "/tickets", { path: value("/tickets") }),
    staticNode("component-tickets", "component", "Tickets", {}),
    staticNode("route-create", "route", "/tickets/new", { path: value("/tickets/new") }),
    staticNode("component-create", "component", "TicketCreate", {}),
    staticNode("nav-create", "navigation", "Create Ticket", { label: value("Create Ticket"), destination: value("/tickets/new") }),
    staticNode("ui-subject", "ui-element", "input", { component: "TicketCreate", name: "input", props: [prop("aria-label", "Subject")] }),
    staticNode("ui-client", "ui-element", "input", { component: "TicketCreate", name: "input", props: [prop("placeholder", "Client")] }),
    staticNode("ui-create", "ui-element", 'button "Create Ticket"', { component: "TicketCreate", name: "button", props: [] }),
    staticNode("ui-save-one", "ui-element", 'button "Save"', { component: "TicketCreate", name: "button", props: [] }),
    staticNode("ui-save-two", "ui-element", 'button "Save"', { component: "TicketCreate", name: "button", props: [] }),
    staticNode("event-create", "ui-event", "onClick", {}),
    staticNode("callable-handle", "callable", "handleCreate", {}),
    staticNode("callable-create", "callable", "createTicket", {}),
    staticNode("http-create", "http-request", "POST /api/tickets", { method: value("POST"), url: value("/api/tickets") }),
    staticNode("graphql-execution", "graphql-execution", "client.mutate", { transport: { endpoint: value("/graphql") } }),
    staticNode("graphql-operation", "graphql-operation", "CreateTicket", {}),
    staticNode("route-settings", "route", "/settings", { path: value("/settings") }),
    staticNode("component-settings", "component", "Settings", {}),
    staticNode("route-login", "route", "/login", { path: value("/login") }),
    staticNode("callable-orphan", "callable", "orphanHelper", {}),
    staticNode("http-orphan", "http-request", "GET /api/orphan", { method: value("GET"), url: value("/api/orphan") }),
  ];
  const edges: ProductEvidenceEdge[] = [
    edge("render-tickets", "ROUTE_RENDERS_COMPONENT", "route-tickets", "component-tickets"),
    edge("render-create", "ROUTE_RENDERS_COMPONENT", "route-create", "component-create"),
    edge("render-settings", "ROUTE_RENDERS_COMPONENT", "route-settings", "component-settings"),
    edge("nav-to-create", "NAVIGATES_TO", "nav-create", "route-create"),
    ...["ui-subject", "ui-client", "ui-create", "ui-save-one", "ui-save-two"].map((id) => edge(`contains-${id}`, "CONTAINS_ELEMENT", "component-create", id)),
    edge("has-create", "HAS_EVENT", "ui-create", "event-create"),
    edge("bind-create", "BINDS_TO", "event-create", "callable-handle"),
    edge("call-create", "CALLS", "callable-handle", "callable-create"),
    edge("perform-http", "PERFORMS_HTTP_REQUEST", "callable-create", "http-create"),
    edge("perform-graphql", "PERFORMS_GRAPHQL_EXECUTION", "callable-create", "graphql-execution"),
    edge("executes-operation", "EXECUTES_OPERATION", "graphql-execution", "graphql-operation"),
    edge("orphan-http", "PERFORMS_HTTP_REQUEST", "callable-orphan", "http-orphan"),
  ];
  const staticGraph: ProductEvidenceGraph = { root: "/fixture", nodes, edges, unresolved: [] };
  const tickets = state("state-tickets", "https://app.test/tickets", "Tickets", [
    element("heading-tickets", "h1", "heading", "Tickets", "Tickets"),
    element("link-create", "a", "link", "Create Ticket", "Create Ticket"),
  ], []);
  const create = state("state-create", "https://app.test/tickets/new", "Create Ticket", [
    element("subject", "input", "textbox", "Subject", "", ""), element("client", "input", "textbox", "Client", "", "Client"),
    element("create", "button", "button", "Create Ticket", "Create Ticket"), element("save", "button", "button", "Save", "Save"),
  ], [network("network-create", "POST", "https://app.test/api/tickets", "fetch"),
    network("network-graphql", "POST", "https://app.test/graphql", "fetch"),
    network("network-telemetry", "POST", "https://telemetry.test/collect", "fetch")], "/tmp/create.png");
  const login = state("state-login", "https://app.test/runtime-login", "Login", [
    element("heading-login", "h1", "heading", "Login as requester", "Login as requester"),
    element("email", "input", "textbox", "Email", ""), element("next", "button", "button", "Next", "Next"),
  ], []);
  const runtimeDiscovery: RuntimeNavigationDiscoveryGraph = {
    startUrl: tickets.url, startOrigin: "https://app.test", allowedOrigins: ["https://app.test"],
    limits: { maxDepth: 1, maxStates: 5, maxTransitions: 5, maxTargetsPerState: 5 },
    nodes: [tickets, create, login], transitions: [transition("transition-create", tickets.id, create.id, "Create Ticket")],
    skippedTargets: [], stopReasons: ["max-depth"], summary: { statesDiscovered: 3, transitionsObserved: 1, failedTransitions: 0,
      targetsSkipped: 0, blocked: 0, unknown: 0, boundaryStates: 0, mutationStopBranches: 0, maxDepthReached: 1 },
  };
  const reconciliation = reconcileProductEvidence({ staticGraph, runtimeDiscovery });
  return { staticGraph, runtimeDiscovery, reconciliation };
}

function routeIdentityFixture(patterns: string[], states: Array<[string, string]>, withHeadings = false) {
  const nodes = patterns.map((path, index) => staticNode(`identity-route-${index}`, "route", path, { path: value(path) }));
  const runtimeStates = states.map(([id, url]) => state(id, url, id, withHeadings
    ? [element(`heading-${id}`, "h1", "heading", "Timesheet", "Timesheet")] : [], []));
  const staticGraph: ProductEvidenceGraph = { root: "/identity-fixture", nodes, edges: [], unresolved: [] };
  const runtimeDiscovery: RuntimeNavigationDiscoveryGraph = {
    startUrl: states[0]?.[1] ?? "https://app.test/", startOrigin: "https://app.test", allowedOrigins: ["https://app.test"],
    limits: { maxDepth: 1, maxStates: 10, maxTransitions: 10, maxTargetsPerState: 10 }, nodes: runtimeStates,
    transitions: [], skippedTargets: [], stopReasons: ["completed"], summary: { statesDiscovered: runtimeStates.length,
      transitionsObserved: 0, failedTransitions: 0, targetsSkipped: 0, blocked: 0, unknown: 0, boundaryStates: 0,
      mutationStopBranches: 0, maxDepthReached: 0 },
  };
  return { staticGraph, runtimeDiscovery, reconciliation: reconcileProductEvidence({ staticGraph, runtimeDiscovery }) };
}

function staticNode(id: string, type: ProductEvidenceNode["type"], label: string, data: Record<string, unknown>): ProductEvidenceNode {
  const location = { path: "src/app.tsx", startLine: 1, endLine: 1 };
  return { id, type, label, data, location, evidence: [{ source: type === "http-request" ? "http-request" :
    type.startsWith("graphql") ? "graphql-operation" : type === "callable" ? "function-call" :
      type === "ui-event" ? "action-binding" : type === "route" || type === "navigation" ? "route-navigation" : "ui-structure",
  strength: "direct", location }] };
}
function edge(id: string, type: ProductEvidenceEdge["type"], from: string, to: string): ProductEvidenceEdge {
  return { id, type, from, to, evidence: [] };
}
function value(value_: string) { return { kind: "static", value: value_ }; }
function prop(name: string, value_: string) { return { name, valueType: "string", value: value_ }; }
function state(id: string, url: string, title: string, semanticElements: RuntimeStateNode["semanticElements"],
  networkItems: RuntimeNetworkObservation[], screenshot = `/tmp/${id}.png`): RuntimeStateNode {
  return { id, fingerprint: `fingerprint-${id}`, url, title, depth: id === "state-tickets" ? 0 : 1, boundary: false,
    expandable: true, stopReasons: [], screenshot: { path: screenshot, width: 1440, height: 900, fullPage: false, captured: true,
      provenance: "screenshot" }, readiness: { status: "ready", reason: "network-idle", timeoutMs: 2000 }, semanticElements,
    interactionCandidates: [], accessibility: { format: "playwright-aria-snapshot-v1", snapshot: title, provenance: "accessibility" },
    visibleText: [], runtimeCaptureId: `capture-${id}`, network: networkItems,
    networkObservations: [{ sourceId: `capture-${id}`, sourceType: "runtime-capture", network: networkItems }], provenance: "runtime-capture" };
}
function element(id: string, type: string, role: string, accessibleName: string, visibleText: string,
  placeholder = ""): RuntimeStateNode["semanticElements"][number] {
  return { id, type, role, accessibleName, ...(visibleText ? { visibleText } : {}), ...(placeholder ? { placeholder } : {}),
    domPath: `html>body>${type}`, visible: true, enabled: true, boundingBox: { x: 1, y: 1, width: 100, height: 20 },
    provenance: ["dom", "accessibility"] };
}
function network(id: string, method: string, url: string, resourceType: string): RuntimeNetworkObservation {
  return { id, method, url, resourceType, status: 200, provenance: "network" };
}
function transition(id: string, from: string, to: string, label: string): RuntimeTransitionEdge {
  return { id, from, to, target: { source: "semantic-element", ...element(`target-${id}`, "a", "link", label, label),
    declaredHref: "/tickets/new", resolvedHref: "https://app.test/tickets/new" }, safety: { decision: "allowed", reasons: [],
    provenance: "safety-rule" }, interactionPerformed: true, transition: { kind: "same-origin-url-change", beforeUrl: "https://app.test/tickets",
      afterUrl: "https://app.test/tickets/new", urlChanged: true, titleChanged: true, uiChanged: true, semanticElementsChanged: true,
      interactionCandidatesChanged: false, networkObserved: false, dialogAppeared: false, popupAppeared: false, mutationMethods: [],
      highSeveritySafetyIssue: false, network: [], provenance: ["before-runtime", "after-runtime"] }, status: "observed", stopReasons: [],
    baselineMutationMethods: [], mutationMethods: [], runtimeProbeId: `probe-${id}`, network: [], provenance: "runtime-probe" };
}
