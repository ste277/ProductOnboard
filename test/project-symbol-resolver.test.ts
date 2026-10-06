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

test("resolves configured path aliases across exports, routes, calls, and product evidence", async () => {
  const { resolution, graph } = await analyzeFiles({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@exact": ["src/exact"],
          "@app/*": ["src/*"],
          "@fallback/*": ["missing/*", "legacy/*"],
          "@nile/*": ["packages/*/src"],
        },
      },
    }),
    "src/exact.ts": "export default function exact() {}\n",
    "src/view.tsx": "export function View() { return <div>View</div>; }\n",
    "src/script.js": "export function fromJs() {}\n",
    "src/widget.jsx": "export function Widget() { return <div>Widget</div>; }\n",
    "src/pages/index.tsx": "export default function TicketPage() { return <div>Tickets</div>; }\n",
    "legacy/old.ts": "export function oldApi() {}\n",
    "src/js-origin.js": 'import { fromJs } from "@app/script";\nexport function useJs() { fromJs(); }\n',
    "src/jsx-origin.jsx": 'import { Widget } from "@app/widget";\nexport function UseJsx() { return <Widget />; }\n',
    "packages/tickets/src/service.ts": [
      'import { ApolloClient, gql } from "@apollo/client";',
      "const client = new ApolloClient({});",
      "const SAVE = gql`mutation SaveTicket { saveTicket }`;",
      "export async function saveTicket() {",
      '  await fetch("/api/tickets", { method: "POST" });',
      "  return client.mutate({ mutation: SAVE });",
      "}",
      "",
    ].join("\n"),
    "packages/tickets/src/index.ts": 'export { saveTicket as persistTicket } from "./service";\n',
    "src/App.tsx": [
      'import exact from "@exact";',
      'import { View as AliasedView } from "@app/view";',
      'import { fromJs } from "@app/script";',
      'import { Widget } from "@app/widget";',
      'import TicketPage from "@app/pages";',
      'import { oldApi } from "@fallback/old";',
      'import { persistTicket } from "@nile/tickets";',
      "export function App() {",
      "  exact(); fromJs(); oldApi(); persistTicket();",
      '  return <><Route path="/tickets" element={<TicketPage />} /><AliasedView /><Widget /></>;',
      "}",
      "",
    ].join("\n"),
  });

  const configured = resolution.resolutions.filter((item) => item.configuredModule?.kind === "path-alias");
  assert.equal(configured.length, 9);
  assert.ok(configured.every((item) => item.evidence.some((evidence) => evidence.kind === "configuration")));
  assert.equal(
    configured.find((item) => item.localName === "oldApi")?.configuredModule?.expandedTarget,
    "legacy/old",
  );
  assert.equal(
    configured.find((item) => item.localName === "persistTicket")?.strength,
    "re-exported",
  );
  assert.ok(graph.edges.some((edge) => edge.type === "ROUTE_RENDERS_COMPONENT"));
  assert.ok(graph.edges.some((edge) => edge.type === "CALLS"));
  assert.ok(graph.edges.some((edge) => edge.type === "PERFORMS_HTTP_REQUEST"));
  assert.ok(graph.edges.some((edge) => edge.type === "PERFORMS_GRAPHQL_EXECUTION"));
});

test("supports baseUrl and inherited path mappings without broad alias fallbacks", async () => {
  const { resolution } = await analyzeFiles({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["shared/*"] } },
    }),
    "src/tsconfig.json": JSON.stringify({ extends: "../tsconfig.json" }),
    "shared/api.ts": "export function sharedApi() {}\n",
    "packages/api/index.ts": "export default function accidentalMatch() {}\n",
    "src/local.ts": "export function localApi() {}\n",
    "src/use.ts": [
      'import { sharedApi } from "@shared/api";',
      'import { localApi } from "src/local";',
      'import { unknown } from "@unknown/api";',
      'import partial from "@sharedly/api";',
      'import vendor from "vendor";',
      "export function use() { sharedApi(); localApi(); unknown(); partial(); vendor(); }",
      "",
    ].join("\n"),
  });

  assert.equal(resolution.resolutions.find((item) => item.localName === "sharedApi")?.configuredModule?.configPath, "src/tsconfig.json");
  assert.equal(resolution.resolutions.find((item) => item.localName === "localApi")?.configuredModule?.kind, "base-url");
  assert.equal(resolution.unresolved.find((item) => item.localName === "unknown")?.reason, "external-module");
  assert.equal(resolution.unresolved.find((item) => item.localName === "partial")?.reason, "external-module");
  assert.equal(resolution.unresolved.find((item) => item.localName === "vendor")?.reason, "external-module");
});

test("resolves workspace package subpaths when a broader path alias target is absent", async () => {
  const { resolution, graph } = await analyzeFiles({
    "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@scope/*": ["packages/*/src"] } },
    }),
    "packages/shell/package.json": JSON.stringify({ name: "@scope/shell", private: true }),
    "packages/shell/src/Pages/AppHomePage.tsx": [
      "function AppHomePage() { return <main>Workspace home</main>; }",
      "export default withRouter(withLDConsumer()(AppHomePage));",
      "",
    ].join("\n"),
    "packages/home/src/App.tsx": [
      'import AppHomePage from "@scope/shell/src/Pages/AppHomePage";',
      'export function App() { return <Route path="/onboard/:pagename" component={AppHomePage} />; }',
      "",
    ].join("\n"),
  });

  const resolved = resolution.resolutions.find((item) => item.localName === "AppHomePage");
  assert.equal(resolved?.resolvedModule, "packages/shell/src/Pages/AppHomePage.tsx");
  assert.equal(resolved?.workspaceModule?.packageName, "@scope/shell");
  assert.equal(resolved?.workspaceModule?.manifestPath, "packages/shell/package.json");
  assert.equal(resolved?.target.name, "AppHomePage");
  assert.equal(resolved?.configuredModule, undefined);
  assert.ok(resolved?.evidence.some((item) => item.kind === "workspace-package"));
  assert.ok(graph.edges.some((edge) => edge.type === "ROUTE_RENDERS_COMPONENT"));
});

test("does not unwrap unsupported component export calls", async () => {
  const { resolution, graph } = await analyzeFiles({
    "src/App.tsx": [
      'import WrappedPage from "./WrappedPage";',
      'export function App() { return <Route path="/wrapped" component={WrappedPage} />; }',
      "",
    ].join("\n"),
    "src/WrappedPage.tsx": [
      "function WrappedPage() { return <main>Wrapped</main>; }",
      "export default connect({})(WrappedPage);",
      "",
    ].join("\n"),
  });

  assert.equal(
    resolution.resolutions.find((item) => item.localName === "WrappedPage")?.target.name,
    "<anonymous-default>",
  );
  assert.equal(graph.edges.some((edge) => edge.type === "ROUTE_RENDERS_COMPONENT"), false);
  assert.ok(graph.unresolved.some((item) =>
    item.relationship === "ROUTE_RENDERS_COMPONENT" &&
    item.reason === "Associated route component is not a same-file UI component"));
});

test("keeps workspace package misses explicit and does not treat dependencies as workspaces", async () => {
  const { resolution } = await analyzeFiles({
    "package.json": JSON.stringify({ workspaces: { packages: ["packages/*"] } }),
    "packages/ui/package.json": JSON.stringify({ name: "@scope/ui", main: "src/index" }),
    "packages/ui/src/other.ts": "export function other() {}\n",
    "src/use.ts": [
      'import missing from "@scope/ui";',
      'import vendor from "vendor/subpath";',
      "export function use() { missing(); vendor(); }",
      "",
    ].join("\n"),
  });

  const missing = resolution.unresolved.find((item) => item.localName === "missing");
  assert.equal(missing?.reason, "workspace-package-target-not-found");
  assert.equal(missing?.workspaceModule?.manifestPath, "packages/ui/package.json");
  assert.equal(resolution.unresolved.find((item) => item.localName === "vendor")?.reason, "external-module");
});

test("keeps duplicate workspace package names ambiguous", async () => {
  const { resolution, graph } = await analyzeFiles({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/one/package.json": JSON.stringify({ name: "@scope/shared" }),
    "packages/one/Page.tsx": "export default function Page() { return <main>One</main>; }\n",
    "packages/two/package.json": JSON.stringify({ name: "@scope/shared" }),
    "packages/two/Page.tsx": "export default function Page() { return <main>Two</main>; }\n",
    "src/App.tsx": [
      'import Page from "@scope/shared/Page";',
      'export function App() { return <Route path="/page" component={Page} />; }',
      "",
    ].join("\n"),
  });

  const unresolved = resolution.unresolved.find((item) => item.localName === "Page");
  assert.equal(unresolved?.reason, "ambiguous-module");
  assert.deepEqual(unresolved?.candidates, [
    "packages/one/package.json",
    "packages/two/package.json",
  ]);
  assert.equal(graph.edges.some((edge) => edge.type === "ROUTE_RENDERS_COMPONENT"), false);
});

test("reports configured alias failures and malformed configuration without crashing", async () => {
  const { resolution } = await analyzeFiles({
    "tsconfig.json": '{ "compilerOptions": { "paths": { "@broken/*": ["missing/*"], "@outside/*": ["../outside/*"] } } }',
    "nested/jsconfig.json": '{ "compilerOptions": ',
    "src/use.ts": [
      'import { missing } from "@broken/api";',
      'import { outside } from "@outside/api";',
      "export function use() { missing(); outside(); }",
      "",
    ].join("\n"),
  });

  assert.equal(
    resolution.unresolved.find((item) => item.localName === "missing")?.reason,
    "configured-path-alias-target-not-found",
  );
  assert.equal(
    resolution.unresolved.find((item) => item.localName === "outside")?.reason,
    "configured-path-alias-outside-repository",
  );
  assert.equal(resolution.configurationErrors.length, 1);
  assert.equal(resolution.configurationErrors[0]?.path, "nested/jsconfig.json");
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
  const inputsBeforeResolution = JSON.stringify({ inventory, sources, calls });
  const resolution = resolveProjectSymbols(inventory, sources, calls);
  assert.equal(JSON.stringify({ inventory, sources, calls }), inputsBeforeResolution);
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
