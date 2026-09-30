import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatContractReconciliation,
  getContractAmbiguous,
  getContractConflicts,
  getContractCorroborated,
  getContractEvidenceForFeature,
  getContractOnly,
  getProductOnly,
  reconcileProductContract,
  validateContractReconciliation,
  type ContractReconciliationManifest,
} from "../src/contract-reconciliation.js";
import { ingestApiDocumentation } from "../src/product-contract-evidence.js";
import { reconcileProductEvidence } from "../src/evidence-reconciliation.js";
import { buildFeatureModel } from "../src/feature-model.js";
import type { ProductEvidenceEdge, ProductEvidenceGraph, ProductEvidenceNode } from "../src/product-evidence-graph.js";
import type { RuntimeNavigationDiscoveryGraph, RuntimeStateNode } from "../src/runtime-discovery.js";
import type { RuntimeNetworkObservation } from "../src/runtime-capture.js";

test("builds a deterministic immutable contract reconciliation manifest", async () => {
  const input = await fixture(); const before = JSON.stringify(input);
  const first = reconcileProductContract(input); const second = reconcileProductContract(input);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(input), before);
  assert.doesNotThrow(() => JSON.stringify(first));
  assert.equal(first.sources.contractEvidenceId, input.contract.id);
  assert.equal(first.coverage.contract.operations, 2);
  assert.equal(first.coverage.product.staticGraphqlOperations, 3);
  assert.deepEqual(first.coverage.runtime, input.productReconciliation.coverage);
});

test("corroborates exact case-sensitive operation identity and structural signatures", async () => {
  const manifest = reconcileProductContract(await fixture());
  const create = operation(manifest, "mutation createTicket");
  assert.equal(create.status, "corroborated");
  assert.equal(create.strength, "exact");
  assert.ok(create.reasons.includes("operation-name-exact"));
  assert.ok(create.reasons.includes("operation-type-match"));
  assert.ok(create.dimensions.some((item) => item.dimension === "argument-type" && item.status === "match"));
  assert.ok(create.dimensions.some((item) => item.dimension === "argument-requiredness" && item.status === "match"));
  assert.ok(create.dimensions.some((item) => item.dimension === "argument-default" && item.status === "match"));
  assert.ok(create.dimensions.some((item) => item.dimension === "return-type" && item.status === "match"));
  assert.ok(create.reasons.includes("endpoint-runtime-observed"));
  assert.ok(create.reasons.includes("named-runtime-operation-unproven"));
  assert.ok(create.product.some((item) => item.runtimeMethod === "POST" && item.networkObservationId === "network-graphql"));
  assert.ok(manifest.productOnly.some((item) => item.subject === "mutation CreateTicket"));
});

test("ignores argument order while preserving GraphQL list and nullability syntax", async () => {
  const input = await fixture();
  const node = input.staticGraph.nodes.find((item) => item.id === "operation-create")!;
  node.data.variables = [
    { name: "tags", type: "[String!]!", required: true },
    { name: "input", type: "CreateTicketInput!", required: true, defaultValue: "DEFAULT_INPUT" },
  ];
  input.contract = await contract(`Mutation\ncreateTicket(input: CreateTicketInput! = DEFAULT_INPUT, tags: [String!]!): Ticket`);
  rebuild(input);
  const result = operation(reconcileProductContract(input), "mutation createTicket");
  assert.equal(result.status, "corroborated");
  assert.equal(result.dimensions.filter((item) => item.dimension === "argument-type").every((item) => item.status === "match"), true);
});

test("reports operation type, argument, requiredness, default, and return conflicts dimensionally", async () => {
  const input = await fixture(); const node = input.staticGraph.nodes.find((item) => item.id === "operation-create")!;
  node.data.variables = [{ name: "input", type: "DifferentInput", required: false, defaultValue: "OTHER" }];
  node.data.returnType = "TicketResponse"; rebuild(input);
  const result = operation(reconcileProductContract(input), "mutation createTicket");
  assert.equal(result.status, "conflicting");
  for (const dimension of ["argument-type", "argument-requiredness", "argument-default", "return-type"]) {
    assert.ok(result.dimensions.some((item) => item.dimension === dimension && item.status === "conflict"), dimension);
  }
  assert.ok(result.dimensions.some((item) => item.dimension === "operation-name" && item.status === "match"));
  const typeInput = await fixture();
  typeInput.staticGraph.nodes.find((item) => item.id === "operation-create")!.data.operationType = "query"; rebuild(typeInput);
  const typeResult = operation(reconcileProductContract(typeInput), "mutation createTicket");
  assert.equal(typeResult.status, "conflicting");
  assert.ok(typeResult.reasons.includes("operation-type-conflict"));
});

test("does not turn absent static signature evidence into a conflict", async () => {
  const input = await fixture(); const node = input.staticGraph.nodes.find((item) => item.id === "operation-create")!;
  delete node.data.variables; delete node.data.returnType; rebuild(input);
  const result = operation(reconcileProductContract(input), "mutation createTicket");
  assert.equal(result.status, "corroborated");
  assert.ok(result.dimensions.some((item) => item.status === "insufficient" && item.reason === "insufficient-static-signature-evidence"));
});

test("preserves contract-only, product-only, and ambiguous operations", async () => {
  const input = await fixture();
  assert.ok(getContractOnly(reconcileProductContract(input)).some((item) => item.subject === "query getAssetSummary"));
  assert.ok(getProductOnly(reconcileProductContract(input)).some((item) => item.subject === "mutation internalAction"));
  input.staticGraph.nodes.push(staticNode("operation-create-two", "graphql-operation", "mutation createTicket", {
    operationType: "mutation", name: "createTicket", variables: [{ name: "input", type: "CreateTicketInput!", required: true }], returnType: "Ticket",
  }));
  rebuild(input);
  const manifest = reconcileProductContract(input);
  const ambiguous = operation(manifest, "mutation createTicket");
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.product.filter((item) => item.nodeId).length, 2);
  assert.ok(getContractAmbiguous(manifest).includes(ambiguous));
});

test("reconciles regional endpoints independently and retains runtime method and provenance", async () => {
  const input = await fixture(); const manifest = reconcileProductContract(input);
  const eu = manifest.endpoints.find((item) => item.subject === "https://euapi.example.test/graphql")!;
  const us = manifest.endpoints.find((item) => item.subject === "https://api.example.test/graphql")!;
  assert.equal(eu.status, "corroborated");
  assert.ok(eu.reasons.includes("endpoint-runtime-observed"));
  assert.ok(eu.reasons.includes("named-runtime-operation-unproven"));
  assert.ok(eu.product.some((item) => item.runtimeStateId === "state-create" && item.networkObservationId === "network-graphql"));
  assert.ok(eu.product.some((item) => item.runtimeMethod === "POST"));
  assert.ok(eu.product.some((item) => item.productReconciliationId));
  assert.equal(us.status, "contract-only");
  assert.equal(manifest.coverage.product.runtimeEndpoints, 1);
  assert.equal(input.runtimeDiscovery.nodes[0]!.network[0]!.method, "POST");

  const exactInput = await fixture();
  const execution = exactInput.staticGraph.nodes.find((item) => item.id === "execution-create")!;
  execution.data.transport = { endpoint: value("https://euapi.example.test/graphql") };
  rebuild(exactInput);
  const exact = reconcileProductContract(exactInput).endpoints.find((item) => item.subject === "https://euapi.example.test/graphql")!;
  assert.ok(exact.reasons.includes("endpoint-exact"));
});

test("compares explicitly available type fields without comparing descriptions", async () => {
  const input = await fixture(); let manifest = reconcileProductContract(input);
  const ticket = manifest.types.find((item) => item.subject === "Ticket")!;
  assert.equal(ticket.status, "corroborated");
  assert.ok(ticket.dimensions.some((item) => item.dimension === "field-type" && item.status === "match"));
  const document = input.staticGraph.nodes.find((item) => item.id === "document-create")!;
  document.data.schemaTypes = [{ name: "Ticket", fields: [{ name: "id", type: "String!" }, { name: "subject", type: "String!" }] }];
  rebuild(input); manifest = reconcileProductContract(input);
  const conflict = manifest.types.find((item) => item.subject === "Ticket")!;
  assert.equal(conflict.status, "conflicting");
  assert.ok(conflict.dimensions.some((item) => item.dimension === "field-type" && item.status === "conflict" && item.key === "id"));
});

test("links documented operations to features only through static GraphQL evidence", async () => {
  const input = await fixture(); const manifest = reconcileProductContract(input);
  const feature = input.featureModel.features.find((item) => item.name === "Create Ticket")!;
  const links = getContractEvidenceForFeature(manifest, feature.id);
  assert.equal(links.length, 1);
  assert.equal(links[0]?.staticGraphqlNodeId, "operation-create");
  assert.ok(links[0]?.contractOperationId);
  assert.ok(links[0]?.reconciliationResultId);
  const fake = structuredClone(input.featureModel);
  fake.features.push({ ...structuredClone(feature), id: "feature-name-only", graphql: [], name: "createTicket",
    provenance: { staticNodeIds: [], staticEdgeIds: [], runtimeStateIds: [], runtimeTransitionIds: [], reconciliationResultIds: [] } });
  input.featureModel = fake;
  assert.equal(getContractEvidenceForFeature(reconcileProductContract(input), "feature-name-only").length, 0);
});

test("query helpers and formatter are deterministic", async () => {
  const input = await fixture(); const manifest = reconcileProductContract(input);
  assert.ok(getContractCorroborated(manifest).length);
  assert.deepEqual(getContractConflicts(manifest), manifest.conflicting);
  assert.equal(formatContractReconciliation(manifest, input.contract, input.staticGraph, input.featureModel), manifest.textSummary);
  assert.match(manifest.textSummary, /OPERATION\nmutation createTicket/);
  assert.match(manifest.textSummary, /FEATURES\nCreate Ticket/);
  assert.equal(Object.hasOwn(manifest.operations[0] ?? {}, "confidence"), false);
  assert.equal(input.contract.api.authentication.length, 0);
  assert.equal(input.contract.api.pagination.length, 1);
});

test("validation rejects bad references, impossible conflicts, duplicate IDs, and invalid feature paths", async () => {
  const input = await fixture(); const manifest = reconcileProductContract(input);
  const badContract: ContractReconciliationManifest = structuredClone(manifest);
  badContract.operations.find((item) => item.contract.some((ref) => ref.operationId))!
    .contract.find((ref) => ref.operationId)!.operationId = "missing-contract";
  assert.throws(() => validateContractReconciliation(badContract, input), /Invalid contract reference/);
  const badStatic = structuredClone(manifest); badStatic.operations.find((item) => item.product.some((ref) => ref.nodeId))!
    .product.find((ref) => ref.nodeId)!.nodeId = "missing-static";
  assert.throws(() => validateContractReconciliation(badStatic, input), /Invalid static reference/);
  const badRuntime = structuredClone(manifest); badRuntime.endpoints.find((item) => item.product.some((ref) => ref.runtimeStateId))!
    .product.find((ref) => ref.runtimeStateId)!.runtimeStateId = "missing-runtime";
  assert.throws(() => validateContractReconciliation(badRuntime, input), /Invalid runtime reference/);
  const badFeature = structuredClone(manifest); badFeature.featureLinks[0]!.featureId = "missing-feature";
  assert.throws(() => validateContractReconciliation(badFeature, input), /Invalid feature reference/);
  const impossible = structuredClone(manifest); impossible.operations.find((item) => item.contract.length && item.product.length)!
    .dimensions.push({ dimension: "return-type", status: "conflict",
    contractValue: "Ticket", reason: "return-type-conflict" });
  assert.throws(() => validateContractReconciliation(impossible, input), /Impossible conflict/);
  const duplicate = structuredClone(manifest); duplicate.operations.push(structuredClone(duplicate.operations[0]!));
  assert.throws(() => validateContractReconciliation(duplicate, input), /Duplicate contract reconciliation result ID/);
});

async function fixture() {
  const staticGraph = graph(); const runtimeDiscovery = runtime();
  const productReconciliation = reconcileProductEvidence({ staticGraph, runtimeDiscovery });
  const featureModel = buildFeatureModel({ staticGraph, runtimeDiscovery, reconciliation: productReconciliation });
  return { contract: await contract(BASE_CONTRACT), staticGraph, runtimeDiscovery, productReconciliation, featureModel };
}

function rebuild(input: Awaited<ReturnType<typeof fixture>>) {
  input.productReconciliation = reconcileProductEvidence({ staticGraph: input.staticGraph, runtimeDiscovery: input.runtimeDiscovery });
  input.featureModel = buildFeatureModel({ staticGraph: input.staticGraph, runtimeDiscovery: input.runtimeDiscovery,
    reconciliation: input.productReconciliation });
}

const BASE_CONTRACT = `GraphQL API Endpoint\nUS: https://api.example.test/graphql\nEU: https://euapi.example.test/graphql
Mutation\ncreateTicket(input: CreateTicketInput! = DEFAULT_INPUT): Ticket
Query\ngetAssetSummary(): AssetSummary
Type Ticket - Contract description is not compared.
id: ID! - Identifier.
subject: String! - Subject.
Type PageInfo - Pagination metadata.
page: Int
pageSize: Int
Pagination uses page and pageSize.`;

async function contract(text: string) {
  return ingestApiDocumentation({ url: "https://docs.example.test/graphql", document: { content: text, contentType: "text",
    finalUrl: "https://docs.example.test/graphql", title: "Example GraphQL", capturedAt: "2026-01-01T00:00:00.000Z",
    retrievalMethod: "supplied" } });
}

function graph(): ProductEvidenceGraph {
  const nodes = [
    staticNode("route-create", "route", "/tickets/new", { path: value("/tickets/new") }),
    staticNode("component-create", "component", "TicketCreate", {}),
    staticNode("ui-create", "ui-element", 'button "Create Ticket"', { component: "TicketCreate", name: "button", props: [] }),
    staticNode("event-create", "ui-event", "onClick", {}), staticNode("callable-create", "callable", "createTicketAction", {}),
    staticNode("execution-create", "graphql-execution", "mutate", { operationType: "mutation",
      transport: { endpoint: value("/graphql") } }),
    staticNode("document-create", "graphql-document", "CreateTicketDocument", { schemaTypes: [
      { name: "Ticket", fields: [{ name: "id", type: "ID!" }, { name: "subject", type: "String!" }] },
    ] }),
    staticNode("operation-create", "graphql-operation", "mutation createTicket", { operationType: "mutation", name: "createTicket",
      variables: [{ name: "input", type: "CreateTicketInput!", required: true, defaultValue: "DEFAULT_INPUT" }], returnType: "Ticket" }),
    staticNode("operation-internal", "graphql-operation", "mutation internalAction", { operationType: "mutation", name: "internalAction" }),
    staticNode("operation-case", "graphql-operation", "mutation CreateTicket", { operationType: "mutation", name: "CreateTicket" }),
  ];
  const edges: ProductEvidenceEdge[] = [
    edge("render-create", "ROUTE_RENDERS_COMPONENT", "route-create", "component-create"),
    edge("contains-create", "CONTAINS_ELEMENT", "component-create", "ui-create"), edge("has-create", "HAS_EVENT", "ui-create", "event-create"),
    edge("bind-create", "BINDS_TO", "event-create", "callable-create"),
    edge("perform-create", "PERFORMS_GRAPHQL_EXECUTION", "callable-create", "execution-create"),
    edge("uses-document", "USES_DOCUMENT", "execution-create", "document-create"),
    edge("executes-create", "EXECUTES_OPERATION", "execution-create", "operation-create"),
    edge("defines-create", "DEFINES_OPERATION", "document-create", "operation-create"),
  ];
  return { root: "/fixture", nodes, edges, unresolved: [] };
}

function runtime(): RuntimeNavigationDiscoveryGraph {
  const networkItems = [network("network-graphql", "POST", "https://euapi.example.test/graphql")];
  const state: RuntimeStateNode = { id: "state-create", fingerprint: "fingerprint-create", url: "https://euapi.example.test/tickets/new",
    title: "Create Ticket", depth: 0, boundary: false, expandable: true, stopReasons: [], screenshot: { path: "/tmp/create.png",
      width: 1440, height: 900, fullPage: false, captured: true, provenance: "screenshot" }, readiness: { status: "ready",
      reason: "network-idle", timeoutMs: 2000 }, semanticElements: [{ id: "element-create", type: "button", role: "button",
      accessibleName: "Create Ticket", visibleText: "Create Ticket", domPath: "html>body>button", visible: true, enabled: true,
      boundingBox: { x: 1, y: 1, width: 100, height: 20 }, provenance: ["dom", "accessibility"] }], interactionCandidates: [],
    accessibility: { format: "playwright-aria-snapshot-v1", snapshot: "Create Ticket", provenance: "accessibility" }, visibleText: [],
    runtimeCaptureId: "capture-create", network: networkItems,
    networkObservations: [{ sourceId: "capture-create", sourceType: "runtime-capture", network: networkItems }],
    provenance: "runtime-capture" };
  return { startUrl: state.url, startOrigin: "https://euapi.example.test", allowedOrigins: ["https://euapi.example.test"],
    limits: { maxDepth: 1, maxStates: 3, maxTransitions: 3, maxTargetsPerState: 3 }, nodes: [state], transitions: [], skippedTargets: [],
    stopReasons: ["max-depth"], summary: { statesDiscovered: 1, transitionsObserved: 0, failedTransitions: 0, targetsSkipped: 0,
      blocked: 0, unknown: 0, boundaryStates: 0, mutationStopBranches: 0, maxDepthReached: 0 } };
}

function staticNode(id: string, type: ProductEvidenceNode["type"], label: string, data: Record<string, unknown>): ProductEvidenceNode {
  const location = { path: "src/app.tsx", startLine: 1, endLine: 1 };
  return { id, type, label, data, location, evidence: [{ source: type.startsWith("graphql") ? "graphql-operation" :
    type === "route" ? "route-navigation" : type === "ui-event" ? "action-binding" : type === "callable" ? "function-call" : "ui-structure",
  strength: "direct", location }] };
}
function edge(id: string, type: ProductEvidenceEdge["type"], from: string, to: string): ProductEvidenceEdge { return { id, type, from, to, evidence: [] }; }
function value(value_: string) { return { kind: "static", value: value_ }; }
function network(id: string, method: string, url: string): RuntimeNetworkObservation { return { id, method, url, resourceType: "fetch", status: 200, provenance: "network" }; }
function operation(manifest: ContractReconciliationManifest, subject: string) { const result = manifest.operations.find((item) => item.subject === subject);
  assert.ok(result, `Missing ${subject}`); return result; }
