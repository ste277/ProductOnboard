import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { analyzeActionBindings } from "../src/action-binding-analyzer.js";
import { analyzeFunctionCalls } from "../src/function-call-analyzer.js";
import { analyzeGraphqlOperations } from "../src/graphql-operation-analyzer.js";
import { analyzeHttpRequests } from "../src/http-request-analyzer.js";
import { buildProductEvidenceGraph } from "../src/product-evidence-graph.js";
import { resolveProjectSymbols } from "../src/project-symbol-resolver.js";
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

test("analyzes representative declaration syntax without runtime evidence", async () => {
  const repository = await createRepository("declaration syntax ");
  await createFile(repository, "src/types.d.ts", [
    'import type { ReactNode } from "react";',
    "interface Foo {}",
    "type Bar = string;",
    "declare const value: string;",
    "declare function run(input: string): void;",
    "declare class Client {",
    "  execute(): Promise<void>;",
    "}",
    "declare namespace Product {",
    "  interface Config {}",
    "}",
    'declare module "example" {',
    "  export function execute(): void;",
    "}",
    "declare global {",
    "  interface Window { productId: string; }",
    "}",
    "export interface Ticket {}",
    "export type TicketId = string;",
    "declare const Button: (props: { children?: ReactNode }) => unknown;",
    "export default Client;",
    "",
  ].join("\n"));

  const inventory = await scanRepository(repository);
  const inventoryBefore = JSON.stringify(inventory);
  const sources = await analyzeSources(inventory);
  const declaration = sources.files[0];

  assert.equal(inventory.files[0]?.path, "src/types.d.ts");
  assert.equal(inventory.files[0]?.extension, ".ts");
  assert.equal(declaration?.status, "ok");
  if (declaration?.status !== "ok") assert.fail("Expected declaration analysis");
  assert.deepEqual(declaration.imports.map((entry) => entry.source), ["react"]);
  assert.ok(declaration.exports.some((entry) => entry.name === "execute"));
  assert.ok(declaration.exports.some((entry) => entry.kind === "default"));
  assert.deepEqual(declaration.classes.map((entry) => entry.name), ["Client"]);
  assert.equal(declaration.classes[0]?.location.startLine, 6);
  assert.deepEqual(declaration.functions, []);
  assert.deepEqual(declaration.jsx, { present: false, elements: [] });

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

  assert.deepEqual(ui.components, []);
  assert.deepEqual(actions.actions, []);
  assert.deepEqual(navigation.routes, []);
  assert.deepEqual(navigation.navigation, []);
  assert.deepEqual(calls.callers, []);
  assert.deepEqual(http.requests, []);
  assert.deepEqual(graphql.documents, []);
  assert.deepEqual(graphql.executions, []);
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
  assert.equal(JSON.stringify(inventory), inventoryBefore);
  assert.doesNotThrow(() => JSON.stringify({ sources, resolution, graph }));
});

test("accepts the minimal Nile vite declaration fixture that previously crashed emit", async () => {
  const repository = await createRepository("nile declaration regression ");
  await createFile(
    repository,
    "e2e/ui/src/vite-env.d.ts",
    '/// <reference types="vite/client" />\n',
  );

  const sources = await analyzeSources(await scanRepository(repository));
  assert.equal(sources.files[0]?.status, "ok");
});

test("retains declaration parse failures and continues in deterministic order", async () => {
  const repository = await createRepository("declaration isolation ");
  await createFile(repository, "z-valid.ts", "export function valid() {}\n");
  await createFile(repository, "b-broken.d.ts", "declare function broken(\n");
  await createFile(repository, "a-valid.d.ts", "export interface Valid {}\n");

  const inventory = await scanRepository(repository);
  inventory.files.reverse();
  const first = await analyzeSources(inventory);
  const second = await analyzeSources(inventory);

  assert.deepEqual(first, second);
  assert.deepEqual(first.files.map((file) => [file.path, file.status]), [
    ["a-valid.d.ts", "ok"],
    ["b-broken.d.ts", "parse-error"],
    ["z-valid.ts", "ok"],
  ]);
  const failure = first.files[1];
  assert.equal(failure?.status, "parse-error");
  if (failure?.status !== "parse-error") assert.fail("Expected isolated failure");
  assert.ok(failure.errors[0]?.message);
  assert.equal(first.files[2]?.status, "ok");
});

async function createRepository(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFile(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}
