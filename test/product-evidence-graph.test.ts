import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { analyzeActionBindings } from "../src/action-binding-analyzer.js";
import { analyzeFunctionCalls } from "../src/function-call-analyzer.js";
import { analyzeGraphqlOperations } from "../src/graphql-operation-analyzer.js";
import { analyzeHttpRequests } from "../src/http-request-analyzer.js";
import {
  buildProductEvidenceGraph,
  getEvidenceNode,
  getIncomingEvidenceEdges,
  getOutgoingEvidenceEdges,
  traceEvidence,
  validateProductEvidenceGraph,
  type ProductEvidenceGraph,
} from "../src/product-evidence-graph.js";
import { scanRepository } from "../src/repository-scanner.js";
import { analyzeRoutesAndNavigation } from "../src/route-navigation-analyzer.js";
import { analyzeSources } from "../src/source-analyzer.js";
import { analyzeUiStructure } from "../src/ui-structure-analyzer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("builds the proven route-to-HTTP-and-GraphQL acceptance trace", async () => {
  const graph = await graphFor([
    "src/app.tsx",
    [
      'import { gql, useMutation } from "@apollo/client";',
      "const AUDIT = gql`mutation AuditTicketCreation { auditTicketCreation }`;",
      "function validateTicket() {}",
      "export function TicketForm() {",
      "  const [audit] = useMutation(AUDIT);",
      "  async function handleCreate() {",
      "    validateTicket();",
      '    await fetch("/api/tickets", { method: "POST" });',
      "    await audit();",
      "  }",
      '  return <Button onClick={handleCreate}>Create Ticket</Button>;',
      "}",
      "export function App() {",
      '  return <><Route path="/tickets/new" element={<TicketForm />} /><Link to="/tickets/new">New</Link></>;',
      "}",
      "",
    ].join("\n"),
  ]);

  const edgeTypes = new Set(graph.edges.map((edge) => edge.type));
  for (const type of [
    "ROUTE_RENDERS_COMPONENT",
    "NAVIGATES_TO",
    "CONTAINS_ELEMENT",
    "HAS_EVENT",
    "BINDS_TO",
    "CALLS",
    "PERFORMS_HTTP_REQUEST",
    "PERFORMS_GRAPHQL_EXECUTION",
    "USES_DOCUMENT",
    "DEFINES_OPERATION",
    "EXECUTES_OPERATION",
  ]) assert.ok(edgeTypes.has(type as never), `missing ${type}`);

  const button = graph.nodes.find(
    (node) => node.type === "ui-element" && node.label.includes("Create Ticket"),
  );
  assert.ok(button);
  const trace = traceEvidence(graph, button.id);
  assert.ok(trace.some((step) => step.node.type === "http-request"));
  assert.ok(trace.some((step) => step.node.type === "graphql-operation"));
  assert.deepEqual(trace.map((step) => step.depth), [...trace].map((step) => step.depth).sort((a, b) => a - b));
  assert.ok(graph.edges.every((edge) => edge.evidence.length > 0));
  assert.ok(graph.nodes.every((node) => node.evidence[0]?.strength === "direct"));
});

test("retains imported, member, props, imported-call, and dynamic-navigation gaps", async () => {
  const graph = await graphFor([
    "src/gaps.tsx",
    [
      'import { importedHandler } from "./actions.js";',
      'import { importedCall } from "./service.js";',
      "export function Gaps(props) {",
      "  function local() { importedCall(); service.save(); }",
      "  return <>",
      "    <Button onClick={importedHandler}>Imported</Button>",
      "    <Button onClick={service.save}>Member</Button>",
      "    <Button onClick={props.onSave}>Props</Button>",
      "    <Button onClick={() => local()}>Inline</Button>",
      "    <Link to={props.destination}>Go</Link>",
      '    <Link to="/missing">Missing</Link>',
      "  </>;",
      "}",
      "",
    ].join("\n"),
  ]);

  const references = graph.unresolved.map((item) => item.reference);
  assert.ok(references.some((value) => value.includes("importedHandler")));
  assert.ok(references.includes("service.save"));
  assert.ok(references.includes("props.onSave"));
  assert.ok(references.includes("props.destination"));
  assert.ok(references.includes("/missing"));
  assert.ok(references.some((value) => value.includes("importedCall")));
  assert.ok(graph.unresolved.every((item) => item.evidence[0]?.strength === "unresolved"));
  const inlineEvent = graph.nodes.find(
    (node) => node.type === "ui-event" && node.location.startLine === 9,
  );
  assert.ok(inlineEvent);
  const inlineCallable = getOutgoingEvidenceEdges(graph, inlineEvent.id)
    .map((edge) => getEvidenceNode(graph, edge.to))
    .find((node) => node?.type === "callable");
  assert.equal(inlineCallable?.label, "<inline-callback>");
});

test("keeps duplicate route and HTTP occurrences distinct and navigation ambiguous", async () => {
  const graph = await graphFor([
    "src/duplicates.tsx",
    [
      "function send() {",
      '  fetch("/same"); fetch("/same");',
      "}",
      "export function Duplicates() {",
      "  return <>",
      '    <Route path="/same" element={<Duplicates />} />',
      '    <Route path="/same" element={<Duplicates />} />',
      '    <Link to="/same">Same</Link>',
      "  </>;",
      "}",
      "",
    ].join("\n"),
  ]);

  const requests = graph.nodes.filter((node) => node.type === "http-request");
  const routes = graph.nodes.filter((node) => node.type === "route");
  assert.equal(requests.length, 2);
  assert.equal(new Set(requests.map((node) => node.id)).size, 2);
  assert.equal(routes.length, 2);
  assert.equal(new Set(routes.map((node) => node.id)).size, 2);
  assert.ok(graph.unresolved.some(
    (item) => item.relationship === "NAVIGATES_TO" && item.reason.includes("Multiple"),
  ));
});

test("does not guess an operation for a multi-operation document", async () => {
  const graph = await graphFor([
    "src/graphql.ts",
    [
      'import { ApolloClient, gql } from "@apollo/client";',
      "const client = new ApolloClient({});",
      "const DOC = gql`query One { one } query Two { two }`;",
      "function load() { return client.query({ query: DOC }); }",
      "",
    ].join("\n"),
  ]);

  assert.equal(graph.nodes.filter((node) => node.type === "graphql-operation").length, 2);
  assert.equal(graph.edges.filter((edge) => edge.type === "DEFINES_OPERATION").length, 2);
  assert.equal(graph.edges.filter((edge) => edge.type === "EXECUTES_OPERATION").length, 0);
  assert.ok(graph.unresolved.some(
    (item) => item.relationship === "EXECUTES_OPERATION" && item.reason.includes("multiple"),
  ));
});

test("carries explicit GraphQL transport evidence into execution nodes", async () => {
  const graph = await graphFor([
    "src/graphql-transport.ts",
    [
      'import { ApolloClient, gql } from "@apollo/client";',
      'const client = new ApolloClient({ uri: "/graphql" });',
      "const DOC = gql`query Tickets { tickets { id } }`;",
      "client.query({ query: DOC });",
      "",
    ].join("\n"),
  ]);
  const execution = graph.nodes.find((node) => node.type === "graphql-execution");
  assert.deepEqual(execution?.data.transport, {
    client: "ApolloClient", configuration: "uri", endpoint: { kind: "static", value: "/graphql" },
    location: { path: "src/graphql-transport.ts", startLine: 2, endLine: 2 },
  });
});

test("supports lookup helpers and terminates traces across recursive cycles", async () => {
  const graph = await graphFor([
    "src/cycles.ts",
    [
      "function first() { second(); }",
      "function second() { first(); }",
      "function recurse() { recurse(); }",
      "",
    ].join("\n"),
  ]);
  const first = graph.nodes.find((node) => node.type === "callable" && node.label === "first");
  assert.ok(first);
  assert.equal(getEvidenceNode(graph, first.id)?.id, first.id);
  assert.equal(getOutgoingEvidenceEdges(graph, first.id).length, 1);
  const secondEdge = getOutgoingEvidenceEdges(graph, first.id)[0]!;
  assert.equal(getIncomingEvidenceEdges(graph, secondEdge.to).length, 1);
  const trace = traceEvidence(graph, first.id);
  assert.equal(new Set(trace.map((step) => step.node.id)).size, trace.length);
  assert.equal(trace.length, 2);
});

test("keeps same-name components and callables distinct across files", async () => {
  const repository = await createRepository("same names graph ");
  await createFile(
    repository,
    "src/one.tsx",
    "export function Shared() { function save() {} return <Button onClick={save}>One</Button>; }\n",
  );
  await createFile(
    repository,
    "src/two.tsx",
    "export function Shared() { function save() {} return <Button onClick={save}>Two</Button>; }\n",
  );
  const graph = await analyzeRepository(repository);
  const components = graph.nodes.filter(
    (node) => node.type === "component" && node.label === "Shared",
  );
  const callables = graph.nodes.filter(
    (node) => node.type === "callable" && node.label === "save",
  );
  assert.equal(components.length, 2);
  assert.equal(new Set(components.map((node) => node.id)).size, 2);
  assert.equal(callables.length, 2);
  assert.equal(new Set(callables.map((node) => node.id)).size, 2);
});

test("validates duplicate IDs, missing endpoints, and invalid endpoint types", () => {
  const location = { path: "src/a.ts", startLine: 1, endLine: 1 };
  const node = {
    id: "one",
    type: "callable" as const,
    label: "one",
    location,
    evidence: [],
    data: {},
  };
  assert.throws(
    () => validateProductEvidenceGraph({ root: "/repo", nodes: [node, node], edges: [], unresolved: [] }),
    /Duplicate node ID/,
  );
  assert.throws(
    () => validateProductEvidenceGraph({
      root: "/repo",
      nodes: [node],
      edges: [{ id: "edge", type: "CALLS", from: "one", to: "missing", evidence: [] }],
      unresolved: [],
    }),
    /missing node/,
  );
  assert.throws(
    () => validateProductEvidenceGraph({
      root: "/repo",
      nodes: [node, { ...node, id: "two", type: "route" }],
      edges: [{ id: "edge", type: "CALLS", from: "one", to: "two", evidence: [] }],
      unresolved: [],
    }),
    /requires callable -> callable/,
  );
  assert.throws(
    () => validateProductEvidenceGraph({
      root: "/repo",
      nodes: [node],
      edges: [
        { id: "edge", type: "CALLS", from: "one", to: "one", evidence: [] },
        { id: "edge", type: "CALLS", from: "one", to: "one", evidence: [] },
      ],
      unresolved: [],
    }),
    /Duplicate edge ID/,
  );
});

test("empty input is valid and repeated builds serialize identically", async () => {
  const repository = await createRepository("empty graph ");
  const first = await analyzeRepository(repository);
  const second = await analyzeRepository(repository);
  assert.deepEqual(first, { root: repository, nodes: [], edges: [], unresolved: [] });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  validateProductEvidenceGraph(first);
});

async function graphFor(file: [string, string]): Promise<ProductEvidenceGraph> {
  const repository = await createRepository("evidence graph ");
  await createFile(repository, file[0], file[1]);
  return analyzeRepository(repository);
}

async function analyzeRepository(repository: string): Promise<ProductEvidenceGraph> {
  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  const ui = analyzeUiStructure(sources);
  const actions = analyzeActionBindings(sources, ui);
  const navigation = analyzeRoutesAndNavigation(inventory, sources, ui);
  const calls = analyzeFunctionCalls(sources);
  const http = analyzeHttpRequests(sources, calls);
  const graphql = analyzeGraphqlOperations(sources, calls);
  return buildProductEvidenceGraph({
    inventory,
    sources,
    ui,
    actions,
    navigation,
    calls,
    http,
    graphql,
  });
}

async function createRepository(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFile(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
