import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildKnowledgeEvidencePackage,
  buildKnowledgeWriterInput,
  FakeKnowledgeWriter,
  formatKnowledgeBaseArticle,
  generateKnowledgeBaseArticle,
  KnowledgeGenerationError,
  validateGeneratedKnowledgeArticle,
  type KnowledgeWriter,
  type KnowledgeWriterOutput,
} from "../src/knowledge-base-generator.js";
import { ingestApiDocumentation } from "../src/product-contract-evidence.js";
import { reconcileProductEvidence } from "../src/evidence-reconciliation.js";
import { buildFeatureModel } from "../src/feature-model.js";
import { reconcileProductContract } from "../src/contract-reconciliation.js";
import type { ProductEvidenceEdge, ProductEvidenceGraph, ProductEvidenceNode } from "../src/product-evidence-graph.js";
import type { RuntimeNavigationDiscoveryGraph, RuntimeStateNode, RuntimeTransitionEdge } from "../src/runtime-discovery.js";
import type { RuntimeNetworkObservation } from "../src/runtime-capture.js";

test("builds a deterministic immutable package isolated to the selected feature", async () => {
  const input = await fixture(); const before = JSON.stringify(input);
  const first = buildKnowledgeEvidencePackage(input); const second = buildKnowledgeEvidencePackage(input);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(input), before);
  assert.equal(first.feature.name, "Create Ticket");
  assert.ok(first.claims.some((item) => item.kind === "entry-point"));
  assert.ok(first.claims.some((item) => item.kind === "route"));
  assert.ok(first.claims.some((item) => item.kind === "visible-ui" && item.text.includes("Subject")));
  assert.ok(first.claims.some((item) => item.kind === "user-action" && item.text.includes("Create Ticket")));
  assert.equal(first.claims.some((item) => item.text.includes("Delete Ticket")), false);
  assert.ok(first.screenshots.some((item) => item.runtimeStateId === "state-tickets"));
  assert.ok(first.screenshots.some((item) => item.runtimeStateId === "state-create"));
  assert.equal(first.screenshots.some((item) => item.path.includes("delete")), false);
  assert.doesNotThrow(() => JSON.stringify(first));
});

test("rejects an unknown feature and excludes unrelated contract-only evidence", async () => {
  const input = await fixture();
  assert.throws(() => buildKnowledgeEvidencePackage({ ...input, featureId: "missing" }), /Unknown feature/);
  const package_ = buildKnowledgeEvidencePackage(input);
  assert.equal(package_.internalEvidence.some((item) => item.label.includes("getAssetSummary")), false);
  assert.ok(package_.internalEvidence.some((item) => item.kind === "http"));
  assert.ok(package_.internalEvidence.some((item) => item.kind === "graphql"));
  assert.ok(package_.internalEvidence.some((item) => item.kind === "contract-operation" && item.label === "mutation createTicket"));
  assert.equal(package_.claims.some((item) => item.text.includes("POST /api/tickets")), false);
});

test("applies corroborated, runtime-only, static-only, ambiguous, and conflicting claim policy", async () => {
  const input = await fixture();
  const package_ = buildKnowledgeEvidencePackage(input);
  assert.ok(package_.claims.some((item) => item.status === "corroborated" && item.publishable));
  const staticOnly = package_.claims.find((item) => item.text.includes("Hidden Field"))!;
  assert.equal(staticOnly.status, "static-only");
  assert.equal(staticOnly.publishable, false);
  const draftPackage = buildKnowledgeEvidencePackage({ ...input, policy: { allowStaticOnly: true } });
  assert.equal(draftPackage.claims.find((item) => item.text.includes("Hidden Field"))?.publishable, true);
  const ambiguous = package_.claims.find((item) => item.text.includes("Save"))!;
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.publishable, false);
  const conflict = package_.claims.find((item) => item.kind === "api-contract")!;
  assert.equal(conflict.status, "conflicting");
  assert.equal(conflict.publishable, false);
  assert.ok(package_.limitations.some((item) => item.type === "evidence-ambiguity"));
  assert.ok(package_.limitations.some((item) => item.type === "evidence-conflict"));
});

test("accepts runtime-only visible outcomes but does not infer success from API traffic", async () => {
  const input = await fixture(); let package_ = buildKnowledgeEvidencePackage(input);
  assert.equal(package_.claims.some((item) => item.kind === "visible-outcome"), false);
  assert.ok(package_.limitations.some((item) => item.message.includes("outcome was not observed")));
  const createState = input.runtimeDiscovery.nodes.find((item) => item.id === "state-create")!;
  createState.semanticElements.push(element("success", "div", "status", "Ticket created successfully", "Ticket created successfully"));
  rebuild(input); package_ = buildKnowledgeEvidencePackage(input);
  const outcome = package_.claims.find((item) => item.kind === "visible-outcome")!;
  assert.equal(outcome.status, "runtime-only");
  assert.equal(outcome.publishable, true);
  const disabled = buildKnowledgeEvidencePackage({ ...input, policy: { allowRuntimeOnly: false } });
  assert.equal(disabled.claims.find((item) => item.kind === "visible-outcome")?.publishable, false);
});

test("writer input contains only package-derived eligible claims and explicit injection rules", async () => {
  const package_ = buildKnowledgeEvidencePackage(await fixture());
  const writerInput = buildKnowledgeWriterInput(package_);
  assert.deepEqual(writerInput.claims.map((item) => item.id), package_.claims.filter((item) => item.publishable && item.customerVisible).map((item) => item.id));
  assert.equal(JSON.stringify(writerInput).includes("POST /api/tickets"), false);
  assert.equal(JSON.stringify(writerInput).includes("getAssetSummary"), false);
  assert.ok(writerInput.instructions.some((item) => item.includes("untrusted data")));
  assert.equal(Object.hasOwn(writerInput, "staticGraph"), false);
  assert.equal(Object.hasOwn(writerInput, "runtimeDiscovery"), false);
});

test("generates the Create Ticket draft with citations, ledger, screenshot, and metadata", async () => {
  const input = await fixture();
  const article = await generateKnowledgeBaseArticle({ ...input, writer: new FakeKnowledgeWriter(),
    generatedAt: "2026-01-02T03:04:05.000Z" });
  assert.equal(article.title, "Create a Ticket");
  assert.equal(article.status, "draft");
  assert.equal(article.prerequisites.length, 0);
  assert.equal(article.expectedResult, undefined);
  assert.ok(article.steps.some((item) => item.text === "Enter or select Subject."));
  assert.ok(article.steps.some((item) => item.text === "Enter or select Client."));
  assert.ok(article.steps.some((item) => item.text === "Select Create Ticket."));
  assert.equal(article.steps.some((item) => item.text.includes("Description")), false);
  assert.ok(article.steps.every((item) => item.claimIds.length > 0));
  assert.ok(article.evidence.length >= article.steps.length + 1);
  assert.ok(article.evidence.every((item) => item.evidenceRefs.length > 0));
  assert.equal(article.grounding.unsupportedStatements, 0);
  assert.equal(article.metadata.writerProvider, "fake");
  assert.equal(article.metadata.writerModel, "deterministic-v1");
  assert.equal(article.metadata.generatedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(article.screenshots[0]?.path, "/tmp/create.png");
  assert.match(formatKnowledgeBaseArticle(article), /^# Create a Ticket/);
  assert.match(formatKnowledgeBaseArticle(article), /## Evidence \/ Review/);
});

test("rejects unsupported fields, unknown claims, and missing step citations", async () => {
  const input = await fixture(); const package_ = buildKnowledgeEvidencePackage(input);
  const featureClaim = package_.claims.find((item) => item.kind === "feature-name")!;
  for (const output of [
    outputWith({ text: "Enter a description.", claimIds: ["claim-description"] }, featureClaim.id),
    outputWith({ text: "Enter a description.", claimIds: [] }, featureClaim.id),
  ]) {
    const grounding = validateGeneratedKnowledgeArticle(output, package_);
    assert.ok(grounding.issues.length);
    await assert.rejects(generateKnowledgeBaseArticle({ ...input, writer: writer(output) }),
      (error: unknown) => error instanceof KnowledgeGenerationError && error.stage === "grounding");
  }
});

test("rejects unsupported administrator prerequisites and unsupported expected results", async () => {
  const input = await fixture(); const package_ = buildKnowledgeEvidencePackage(input);
  const featureClaim = package_.claims.find((item) => item.kind === "feature-name")!;
  const prerequisite: KnowledgeWriterOutput = { title: "Create a Ticket", summary: statement("Use Create Ticket.", featureClaim.id),
    prerequisites: [statement("You must be an administrator.", featureClaim.id)], steps: [], notes: [] };
  assert.ok(validateGeneratedKnowledgeArticle(prerequisite, package_).issues.some((item) => item.type === "unsupported-prerequisite"));
  await assert.rejects(generateKnowledgeBaseArticle({ ...input, writer: writer(prerequisite) }), KnowledgeGenerationError);
  const expected: KnowledgeWriterOutput = { title: "Create a Ticket", summary: statement("Use Create Ticket.", featureClaim.id),
    prerequisites: [], steps: [], expectedResult: statement("The ticket is created.", featureClaim.id), notes: [] };
  assert.ok(validateGeneratedKnowledgeArticle(expected, package_).issues.some((item) => item.type === "unsupported-expected-result"));
});

test("rejects ambiguous and conflicting claim citations", async () => {
  const input = await fixture(); const package_ = buildKnowledgeEvidencePackage(input);
  const featureClaim = package_.claims.find((item) => item.kind === "feature-name")!;
  for (const bad of [package_.claims.find((item) => item.status === "ambiguous")!,
    package_.claims.find((item) => item.status === "conflicting")!]) {
    const output = outputWith(statement("Use uncertain evidence.", bad.id), featureClaim.id);
    const grounding = validateGeneratedKnowledgeArticle(output, package_);
    assert.ok(grounding.issues.some((item) => item.type === "ineligible-claim"));
  }
});

test("excludes sensitive values and arbitrary captured text", async () => {
  const input = await fixture();
  input.runtimeDiscovery.nodes.find((item) => item.id === "state-create")!.visibleText.push({
    id: "sensitive", text: "Authorization: Bearer private-token cookie=session-secret", domPath: "html>body", provenance: "dom" });
  rebuild(input);
  const package_ = buildKnowledgeEvidencePackage(input); const serialized = JSON.stringify(package_);
  assert.doesNotMatch(serialized, /private-token|session-secret|storage-state|cookie=/i);
  assert.equal(serialized.includes("Authorization"), false);
});

test("rejects malformed writer output and wraps writer failures", async () => {
  const input = await fixture();
  await assert.rejects(generateKnowledgeBaseArticle({ ...input, writer: { async generate() { return { title: "bad" } as never; } } }),
    (error: unknown) => error instanceof KnowledgeGenerationError && error.stage === "output");
  await assert.rejects(generateKnowledgeBaseArticle({ ...input, writer: { async generate() { throw new Error("provider failed"); } } }),
    (error: unknown) => error instanceof KnowledgeGenerationError && error.stage === "writer" && error.message === "provider failed");
});

async function fixture() {
  const staticGraph = graph(); const runtimeDiscovery = runtime();
  const reconciliation = reconcileProductEvidence({ staticGraph, runtimeDiscovery });
  const featureModel = buildFeatureModel({ staticGraph, runtimeDiscovery, reconciliation });
  const contractEvidence = await ingestApiDocumentation({ url: "https://docs.example.test/graphql", document: {
    content: "GraphQL API Endpoint\nEU: https://app.example.test/graphql\nMutation\ncreateTicket(input: DifferentInput!): TicketResponse\nQuery\ngetAssetSummary(): AssetSummary",
    contentType: "text", finalUrl: "https://docs.example.test/graphql", title: "Example", capturedAt: "2026-01-01T00:00:00.000Z",
    retrievalMethod: "supplied" } });
  const contractReconciliation = reconcileProductContract({ contract: contractEvidence, staticGraph, runtimeDiscovery,
    productReconciliation: reconciliation, featureModel });
  const featureId = featureModel.features.find((item) => item.name === "Create Ticket")!.id;
  return { featureId, featureModel, staticGraph, runtimeDiscovery, reconciliation, contractEvidence, contractReconciliation };
}

function rebuild(input: Awaited<ReturnType<typeof fixture>>) {
  input.reconciliation = reconcileProductEvidence({ staticGraph: input.staticGraph, runtimeDiscovery: input.runtimeDiscovery });
  input.featureModel = buildFeatureModel({ staticGraph: input.staticGraph, runtimeDiscovery: input.runtimeDiscovery,
    reconciliation: input.reconciliation });
  input.featureId = input.featureModel.features.find((item) => item.name === "Create Ticket")!.id;
  input.contractReconciliation = reconcileProductContract({ contract: input.contractEvidence, staticGraph: input.staticGraph,
    runtimeDiscovery: input.runtimeDiscovery, productReconciliation: input.reconciliation, featureModel: input.featureModel });
}

function graph(): ProductEvidenceGraph {
  const nodes = [
    node("route-tickets", "route", "/tickets", { path: value("/tickets") }), node("component-tickets", "component", "Tickets", {}),
    node("route-create", "route", "/tickets/new", { path: value("/tickets/new") }), node("component-create", "component", "TicketCreate", {}),
    node("nav-create", "navigation", "Create Ticket", { label: value("Create Ticket"), destination: value("/tickets/new") }),
    node("ui-subject", "ui-element", "input", { component: "TicketCreate", name: "input", props: [prop("aria-label", "Subject")] }),
    node("ui-client", "ui-element", "select", { component: "TicketCreate", name: "select", props: [prop("aria-label", "Client")] }),
    node("ui-create", "ui-element", 'button "Create Ticket"', { component: "TicketCreate", name: "button", props: [] }),
    node("ui-hidden", "ui-element", 'input "Hidden Field"', { component: "TicketCreate", name: "input", props: [prop("aria-label", "Hidden Field")] }),
    node("ui-save-one", "ui-element", 'button "Save"', { component: "TicketCreate", name: "button", props: [] }),
    node("ui-save-two", "ui-element", 'button "Save"', { component: "TicketCreate", name: "button", props: [] }),
    node("event-create", "ui-event", "onClick", {}), node("callable-handle", "callable", "handleCreate", {}),
    node("callable-create", "callable", "createTicket", {}), node("http-create", "http-request", "POST /api/tickets", {
      method: value("POST"), url: value("/api/tickets") }),
    node("execution-create", "graphql-execution", "mutate", { operationType: "mutation", transport: { endpoint: value("/graphql") } }),
    node("document-create", "graphql-document", "CreateTicketDocument", {}),
    node("operation-create", "graphql-operation", "mutation createTicket", { operationType: "mutation", name: "createTicket",
      variables: [{ name: "input", type: "CreateTicketInput!", required: true }], returnType: "Ticket" }),
    node("route-delete", "route", "/tickets/delete", { path: value("/tickets/delete") }), node("component-delete", "component", "Delete Ticket", {}),
    node("ui-delete", "ui-element", 'button "Delete Ticket"', { component: "Delete Ticket", name: "button", props: [] }),
  ];
  const edges: ProductEvidenceEdge[] = [
    edge("render-tickets", "ROUTE_RENDERS_COMPONENT", "route-tickets", "component-tickets"),
    edge("render-create", "ROUTE_RENDERS_COMPONENT", "route-create", "component-create"), edge("nav-create-route", "NAVIGATES_TO", "nav-create", "route-create"),
    ...["ui-subject", "ui-client", "ui-create", "ui-hidden", "ui-save-one", "ui-save-two"].map((id) => edge(`contains-${id}`, "CONTAINS_ELEMENT", "component-create", id)),
    edge("event", "HAS_EVENT", "ui-create", "event-create"), edge("bind", "BINDS_TO", "event-create", "callable-handle"),
    edge("calls", "CALLS", "callable-handle", "callable-create"), edge("http", "PERFORMS_HTTP_REQUEST", "callable-create", "http-create"),
    edge("graphql", "PERFORMS_GRAPHQL_EXECUTION", "callable-create", "execution-create"),
    edge("uses", "USES_DOCUMENT", "execution-create", "document-create"), edge("executes", "EXECUTES_OPERATION", "execution-create", "operation-create"),
    edge("defines", "DEFINES_OPERATION", "document-create", "operation-create"),
    edge("render-delete", "ROUTE_RENDERS_COMPONENT", "route-delete", "component-delete"),
    edge("contains-delete", "CONTAINS_ELEMENT", "component-delete", "ui-delete"),
  ];
  return { root: "/fixture", nodes, edges, unresolved: [] };
}

function runtime(): RuntimeNavigationDiscoveryGraph {
  const tickets = state("state-tickets", "https://app.example.test/tickets", "Tickets", [
    element("link-create", "a", "link", "Create Ticket", "Create Ticket")], [], "/tmp/tickets.png", 0);
  const create = state("state-create", "https://app.example.test/tickets/new", "Create Ticket", [
    element("subject", "input", "textbox", "Subject", ""), element("client", "select", "combobox", "Client", ""),
    element("create", "button", "button", "Create Ticket", "Create Ticket"), element("save", "button", "button", "Save", "Save")],
  [network("api", "POST", "https://app.example.test/api/tickets"), network("graphql-network", "POST", "https://app.example.test/graphql"),
    network("telemetry", "POST", "https://telemetry.example.test/collect")], "/tmp/create.png", 1);
  const deleteState = state("state-delete", "https://app.example.test/tickets/delete", "Delete Ticket", [
    element("delete", "button", "button", "Delete Ticket", "Delete Ticket")], [], "/tmp/delete.png", 1);
  return { startUrl: tickets.url, startOrigin: "https://app.example.test", allowedOrigins: ["https://app.example.test"],
    limits: { maxDepth: 1, maxStates: 5, maxTransitions: 5, maxTargetsPerState: 5 }, nodes: [tickets, create, deleteState],
    transitions: [transition("transition-create", tickets.id, create.id, "Create Ticket")], skippedTargets: [], stopReasons: ["max-depth"],
    summary: { statesDiscovered: 3, transitionsObserved: 1, failedTransitions: 0, targetsSkipped: 0, blocked: 0, unknown: 0,
      boundaryStates: 0, mutationStopBranches: 0, maxDepthReached: 1 } };
}

function state(id: string, url: string, title: string, semanticElements: RuntimeStateNode["semanticElements"], networkItems: RuntimeNetworkObservation[],
  screenshot: string, depth: number): RuntimeStateNode { return { id, fingerprint: `fingerprint-${id}`, url, title, depth, boundary: false,
  expandable: true, stopReasons: [], screenshot: { path: screenshot, width: 1440, height: 900, fullPage: false, captured: true,
    provenance: "screenshot" }, readiness: { status: "ready", reason: "network-idle", timeoutMs: 2000 }, semanticElements,
  interactionCandidates: [], accessibility: { format: "playwright-aria-snapshot-v1", snapshot: title, provenance: "accessibility" },
  visibleText: [], runtimeCaptureId: `capture-${id}`, network: networkItems,
  networkObservations: [{ sourceId: `capture-${id}`, sourceType: "runtime-capture", network: networkItems }], provenance: "runtime-capture" }; }
function element(id: string, type: string, role: string, accessibleName: string, visibleText: string): RuntimeStateNode["semanticElements"][number] {
  return { id, type, role, accessibleName, ...(visibleText ? { visibleText } : {}), domPath: `html>body>${type}`, visible: true, enabled: true,
    boundingBox: { x: 1, y: 1, width: 100, height: 20 }, provenance: ["dom", "accessibility"] };
}
function transition(id: string, from: string, to: string, label: string): RuntimeTransitionEdge { return { id, from, to,
  target: { source: "semantic-element", ...element(`target-${id}`, "a", "link", label, label), declaredHref: "/tickets/new",
    resolvedHref: "https://app.example.test/tickets/new" }, safety: { decision: "allowed", reasons: [], provenance: "safety-rule" },
  interactionPerformed: true, transition: { kind: "same-origin-url-change", beforeUrl: "https://app.example.test/tickets",
    afterUrl: "https://app.example.test/tickets/new", urlChanged: true, titleChanged: true, uiChanged: true,
    semanticElementsChanged: true, interactionCandidatesChanged: false, networkObserved: false, dialogAppeared: false,
    popupAppeared: false, mutationMethods: [], highSeveritySafetyIssue: false, network: [], provenance: ["before-runtime", "after-runtime"] },
  status: "observed", stopReasons: [], baselineMutationMethods: [], mutationMethods: [], runtimeProbeId: `probe-${id}`, network: [],
  provenance: "runtime-probe" }; }
function node(id: string, type: ProductEvidenceNode["type"], label: string, data: Record<string, unknown>): ProductEvidenceNode {
  const location = { path: "src/app.tsx", startLine: 1, endLine: 1 }; return { id, type, label, data, location,
    evidence: [{ source: type.startsWith("graphql") ? "graphql-operation" : type === "http-request" ? "http-request" :
      type === "route" || type === "navigation" ? "route-navigation" : type === "ui-event" ? "action-binding" :
        type === "callable" ? "function-call" : "ui-structure", strength: "direct", location }] };
}
function edge(id: string, type: ProductEvidenceEdge["type"], from: string, to: string): ProductEvidenceEdge { return { id, type, from, to, evidence: [] }; }
function value(value_: string) { return { kind: "static", value: value_ }; }
function prop(name: string, value_: string) { return { name, valueType: "string", value: value_ }; }
function network(id: string, method: string, url: string): RuntimeNetworkObservation { return { id, method, url, resourceType: "fetch", status: 200,
  provenance: "network" }; }
function statement(text: string, claimId: string) { return { text, claimIds: [claimId] }; }
function outputWith(step: { text: string; claimIds: string[] }, featureClaimId: string): KnowledgeWriterOutput { return { title: "Create a Ticket",
  summary: statement("Use Create Ticket.", featureClaimId), prerequisites: [], steps: [step], notes: [] }; }
function writer(output: KnowledgeWriterOutput): KnowledgeWriter { return { async generate() { return output; } }; }
