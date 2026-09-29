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
  traceEvidence,
  type ProductEvidenceGraph,
} from "../src/product-evidence-graph.js";
import {
  resolveProjectSymbols,
  type ProjectSymbolResolutionManifest,
} from "../src/project-symbol-resolver.js";
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

test("resolves relative modules across extensions, parent paths, and index files", async () => {
  const { resolution } = await analyzeFiles({
    "src/lib/explicit.ts": "export function explicitTs() {}\n",
    "src/lib/explicit-view.tsx": "export function explicitTsx() { return <div />; }\n",
    "src/lib/plain.ts": "export function plainTs() {}\n",
    "src/lib/view.tsx": "export function plainTsx() { return <div />; }\n",
    "src/lib/script.js": "export function plainJs() {}\n",
    "src/lib/widget.jsx": "export function plainJsx() { return <div />; }\n",
    "src/lib/ts-index/index.ts": "export function tsIndex() {}\n",
    "src/lib/tsx-index/index.tsx": "export function tsxIndex() { return <div />; }\n",
    "src/screens/use.ts": [
      'import { explicitTs } from "../lib/explicit.ts";',
      'import { explicitTsx } from "../lib/explicit-view.tsx";',
      'import { plainTs } from "../lib/plain";',
      'import { plainTsx } from "../lib/view";',
      'import { plainJs } from "../lib/script";',
      'import { plainJsx } from "../lib/widget";',
      'import { tsIndex } from "../lib/ts-index";',
      'import { tsxIndex } from "../lib/tsx-index";',
      "export function useAll() {",
      "  explicitTs(); explicitTsx(); plainTs(); plainTsx();",
      "  plainJs(); plainJsx(); tsIndex(); tsxIndex();",
      "}",
      "",
    ].join("\n"),
  });

  assert.equal(resolution.resolutions.filter((item) => item.kind === "import").length, 8);
  assert.deepEqual(
    resolution.resolutions.filter((item) => item.kind === "import").map((item) => item.resolvedModule),
    [
      "src/lib/explicit-view.tsx",
      "src/lib/explicit.ts",
      "src/lib/plain.ts",
      "src/lib/script.js",
      "src/lib/ts-index/index.ts",
      "src/lib/tsx-index/index.tsx",
      "src/lib/view.tsx",
      "src/lib/widget.jsx",
    ],
  );
  assert.ok(resolution.resolutions.every((item) => item.strength === "direct"));
});

test("resolves named, aliased, export-list, and default declarations", async () => {
  const { resolution } = await analyzeFiles({
    "src/api.ts": [
      "function createTicket() {}",
      "function internalSave() {}",
      "export { createTicket, internalSave as saveTicket };",
      "export default function DefaultApi() {}",
      "",
    ].join("\n"),
    "src/anonymous.ts": "export default function () {}\n",
    "src/use.ts": [
      'import DefaultApi, { createTicket as create, saveTicket } from "./api";',
      'import Anonymous from "./anonymous";',
      "export function use() { create(); saveTicket(); DefaultApi(); Anonymous(); }",
      "",
    ].join("\n"),
  });

  const byLocal = new Map(resolution.resolutions.map((item) => [item.localName, item]));
  assert.equal(byLocal.get("create")?.importedName, "createTicket");
  assert.equal(byLocal.get("create")?.target.name, "createTicket");
  assert.equal(byLocal.get("saveTicket")?.target.name, "internalSave");
  assert.equal(byLocal.get("DefaultApi")?.target.name, "DefaultApi");
  assert.equal(byLocal.get("Anonymous")?.target.kind, "callable");
  assert.ok(byLocal.get("Anonymous")?.target.id.includes("::<anonymous>@"));
});

test("resolves direct, aliased, export-all, and multi-hop re-exports with provenance", async () => {
  const { resolution } = await analyzeFiles({
    "src/core.ts": "export function createTicket() {}\nexport function auditTicket() {}\n",
    "src/middle.ts": 'export { createTicket } from "./core";\nexport * from "./core";\n',
    "src/api.ts": 'export { createTicket as saveTicket } from "./middle";\nexport * from "./middle";\n',
    "src/use.ts": [
      'import { saveTicket, auditTicket } from "./api";',
      "export function use() { saveTicket(); auditTicket(); }",
      "",
    ].join("\n"),
  });

  const save = resolution.resolutions.find((item) => item.localName === "saveTicket");
  const audit = resolution.resolutions.find((item) => item.localName === "auditTicket");
  assert.equal(save?.target.name, "createTicket");
  assert.equal(audit?.target.name, "auditTicket");
  assert.equal(save?.strength, "re-exported");
  assert.equal(audit?.strength, "re-exported");
  assert.deepEqual(
    save?.evidence.filter((item) => item.kind === "re-export").map((item) => item.path),
    ["src/api.ts", "src/middle.ts"],
  );
});

test("reports missing, ambiguous, circular, external, alias, and dynamic imports", async () => {
  const { resolution, graph } = await analyzeFiles({
    "src/foo.ts": "export function foo() {}\n",
    "src/foo.tsx": "export function foo() { return <div />; }\n",
    "src/a.ts": 'export { loop } from "./b";\n',
    "src/b.ts": 'export { loop } from "./a";\n',
    "src/no-export.ts": "export function other() {}\n",
    "src/MissingHandler.tsx": [
      'import { missingHandler } from "./missing";',
      "export function MissingHandler() { return <Button onClick={missingHandler}>Missing</Button>; }",
      "",
    ].join("\n"),
    "src/use.ts": [
      'import { missing } from "./missing";',
      'import { absent } from "./no-export";',
      'import { foo } from "./foo";',
      'import { loop } from "./a";',
      'import axios from "axios";',
      'import { aliased } from "@/api";',
      "export async function use(name) { await import(name); await import('./foo'); }",
      "",
    ].join("\n"),
  });

  const reasons = resolution.unresolved.map((item) => item.reason);
  for (const reason of [
    "module-not-found",
    "export-not-found",
    "ambiguous-module",
    "circular-re-export",
    "external-module",
    "unsupported-module-alias",
    "dynamic-import-out-of-scope",
  ]) assert.ok(reasons.includes(reason as never), `missing ${reason}`);
  assert.equal(resolution.unresolved.filter((item) => item.kind === "dynamic-import").length, 2);
  assert.ok(graph.unresolved.some(
    (item) => item.relationship === "BINDS_TO" && item.reason.includes("module-not-found"),
  ));
});

test("resolves namespace member calls to callable identities", async () => {
  const { resolution, graph } = await analyzeFiles({
    "src/api.ts": "export function createTicket() {}\n",
    "src/use.ts": [
      'import * as ticketApi from "./api";',
      "export function use() { ticketApi.createTicket(); unknown.save(); }",
      "",
    ].join("\n"),
  });
  const member = resolution.resolutions.find((item) => item.kind === "namespace-member");
  assert.equal(member?.localName, "ticketApi");
  assert.equal(member?.importedName, "createTicket");
  assert.equal(member?.target.kind, "callable");
  assert.ok(member?.usageLocation);
  assert.ok(graph.edges.some((edge) => edge.type === "CALLS"));
});

test("integrates re-exported UI handlers and preserves the HTTP evidence path", async () => {
  const { graph, resolution } = await analyzeFiles({
    "src/screens/TicketCreate.tsx": [
      'import { createTicket } from "../actions";',
      "export function TicketCreate() {",
      "  return <Button onClick={createTicket}>Create Ticket</Button>;",
      "}",
      "",
    ].join("\n"),
    "src/actions/index.ts": 'export { createTicket } from "../api/tickets";\n',
    "src/api/tickets.ts": [
      "export async function createTicket(ticket) {",
      '  return fetch("/api/tickets", { method: "POST", body: JSON.stringify(ticket) });',
      "}",
      "",
    ].join("\n"),
  });

  const importResolution = resolution.resolutions.find(
    (item) => item.importingFile === "src/screens/TicketCreate.tsx",
  );
  assert.equal(importResolution?.strength, "re-exported");
  const button = graph.nodes.find(
    (node) => node.type === "ui-element" && node.label.includes("Create Ticket"),
  );
  assert.ok(button);
  const trace = traceEvidence(graph, button.id);
  assert.deepEqual(
    trace.filter((step) => ["ui-element", "ui-event", "callable", "http-request"].includes(step.node.type))
      .map((step) => step.node.type),
    ["ui-element", "ui-event", "callable", "http-request"],
  );
  const binding = graph.edges.find((edge) => edge.type === "BINDS_TO");
  assert.ok(binding?.evidence.some((item) => item.source === "module-resolution"));
  assert.equal(graph.unresolved.some((item) => item.relationship === "BINDS_TO"), false);
});

test("connects imported calls to HTTP and GraphQL without synthetic transitive edges", async () => {
  const { graph } = await analyzeFiles({
    "src/screen.ts": [
      'import { persist } from "./service";',
      "export function handleCreate() { return persist(); }",
      "",
    ].join("\n"),
    "src/service.ts": [
      'import { ApolloClient, gql } from "@apollo/client";',
      "const client = new ApolloClient({});",
      "const DOC = gql`mutation Audit { audit }`;",
      "export async function persist() {",
      '  await fetch("/api/tickets", { method: "POST" });',
      "  return client.mutate({ mutation: DOC });",
      "}",
      "",
    ].join("\n"),
  });

  const handle = graph.nodes.find((node) => node.type === "callable" && node.label === "handleCreate");
  const persist = graph.nodes.find((node) => node.type === "callable" && node.label === "persist");
  assert.ok(handle && persist);
  assert.ok(graph.edges.some((edge) => edge.type === "CALLS" && edge.from === handle.id && edge.to === persist.id));
  assert.ok(graph.edges.some((edge) => edge.type === "PERFORMS_HTTP_REQUEST" && edge.from === persist.id));
  assert.ok(graph.edges.some((edge) => edge.type === "PERFORMS_GRAPHQL_EXECUTION" && edge.from === persist.id));
  assert.equal(graph.edges.some((edge) => edge.type === "PERFORMS_HTTP_REQUEST" && edge.from === handle.id), false);
  assert.equal(graph.edges.some((edge) => edge.type === "PERFORMS_GRAPHQL_EXECUTION" && edge.from === handle.id), false);
});

test("resolves imported route components and cross-file callable cycles deterministically", async () => {
  const first = await analyzeFiles({
    "src/App.tsx": [
      'import TicketList from "./TicketList";',
      "export function App() { return <Route path=\"/tickets\" element={<TicketList />} />; }",
      "",
    ].join("\n"),
    "src/TicketList.tsx": "export default function TicketList() { return <div>Tickets</div>; }\n",
    "src/a.ts": 'import { b } from "./b";\nexport function a() { b(); }\n',
    "src/b.ts": 'import { a } from "./a";\nexport function b() { a(); }\n',
  });
  const second = await analyzeFiles({
    "src/App.tsx": [
      'import TicketList from "./TicketList";',
      "export function App() { return <Route path=\"/tickets\" element={<TicketList />} />; }",
      "",
    ].join("\n"),
    "src/TicketList.tsx": "export default function TicketList() { return <div>Tickets</div>; }\n",
    "src/a.ts": 'import { b } from "./b";\nexport function a() { b(); }\n',
    "src/b.ts": 'import { a } from "./a";\nexport function b() { a(); }\n',
  });

  assert.ok(first.graph.edges.some((edge) => edge.type === "ROUTE_RENDERS_COMPONENT"));
  assert.equal(first.graph.edges.filter((edge) => edge.type === "CALLS").length, 2);
  const normalizeRoot = (value: unknown, root: string) => JSON.stringify(value).replaceAll(root, "<root>");
  assert.equal(
    normalizeRoot(first.resolution, first.resolution.root),
    normalizeRoot(second.resolution, second.resolution.root),
  );
  assert.equal(
    normalizeRoot(first.graph, first.graph.root),
    normalizeRoot(second.graph, second.graph.root),
  );
});

async function analyzeFiles(files: Record<string, string>): Promise<{
  resolution: ProjectSymbolResolutionManifest;
  graph: ProductEvidenceGraph;
}> {
  const repository = await createRepository("symbol resolution ");
  await Promise.all(
    Object.entries(files).map(([relativePath, content]) =>
      createFile(repository, relativePath, content),
    ),
  );
  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  const ui = analyzeUiStructure(sources);
  const actions = analyzeActionBindings(sources, ui);
  const navigation = analyzeRoutesAndNavigation(inventory, sources, ui);
  const calls = analyzeFunctionCalls(sources);
  const http = analyzeHttpRequests(sources, calls);
  const graphql = analyzeGraphqlOperations(sources, calls);
  const resolution = resolveProjectSymbols(inventory, sources, calls);
  const graph = buildProductEvidenceGraph({
    inventory,
    sources,
    ui,
    actions,
    navigation,
    calls,
    http,
    graphql,
    resolution,
  });
  return { resolution, graph };
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
