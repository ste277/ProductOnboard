import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { scanRepository } from "../src/repository-scanner.js";
import {
  analyzeSources,
  type SuccessfulSourceAnalysis,
} from "../src/source-analyzer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("analyzes TypeScript imports, exports, functions, and classes", async () => {
  const repository = await createRepository("typescript analysis ");
  await createFile(
    repository,
    "src/service.ts",
    [
      'import client from "./client.js";',
      'import { Request, Response as Reply } from "./types.js";',
      'import * as helpers from "./helpers.js";',
      "export class TicketService {}",
      "export async function createTicket() {",
      "  const normalize = (value: string) => value.trim();",
      "  return normalize(helpers.create(client));",
      "}",
      "const internal = function namedInternal() {};",
      "export { internal };",
      "export default TicketService;",
      "",
    ].join("\n"),
  );

  const manifest = await analyzeRepository(repository);
  const file = getSuccessfulFile(manifest.files[0]);

  assert.deepEqual(
    file.imports.map(({ source, default: defaultImport, named, namespace }) => ({
      source,
      default: defaultImport,
      named,
      namespace,
    })),
    [
      { source: "./client.js", default: "client", named: [], namespace: undefined },
      {
        source: "./types.js",
        default: undefined,
        named: [
          { imported: "Request", local: "Request" },
          { imported: "Response", local: "Reply" },
        ],
        namespace: undefined,
      },
      {
        source: "./helpers.js",
        default: undefined,
        named: [],
        namespace: "helpers",
      },
    ],
  );
  assert.deepEqual(
    file.exports.map(({ kind, name }) => ({ kind, name })),
    [
      { kind: "named", name: "TicketService" },
      { kind: "named", name: "createTicket" },
      { kind: "named", name: "internal" },
      { kind: "default", name: undefined },
    ],
  );
  assert.deepEqual(
    file.functions.map(({ name, async }) => ({ name, async })),
    [
      { name: "createTicket", async: true },
      { name: "normalize", async: false },
      { name: "internal", async: false },
    ],
  );
  assert.deepEqual(file.classes.map((entry) => entry.name), ["TicketService"]);
  assert.equal(file.jsx.present, false);
  assert.deepEqual(file.jsx.elements, []);
});

test("analyzes TSX including nested intrinsic and custom JSX elements", async () => {
  const repository = await createRepository("tsx analysis ");
  await createFile(
    repository,
    "src/TicketForm.tsx",
    [
      'import { Button } from "./components.js";',
      "",
      "export function TicketForm() {",
      "  const submitTicket = async () => {};",
      "  return (",
      "    <form>",
      "      <div><Button><span /></Button></div>",
      "    </form>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );

  const manifest = await analyzeRepository(repository);
  const file = getSuccessfulFile(manifest.files[0]);

  assert.deepEqual(file.functions.map((entry) => [entry.name, entry.async]), [
    ["TicketForm", false],
    ["submitTicket", true],
  ]);
  assert.equal(file.functions[0]?.location.path, "src/TicketForm.tsx");
  assert.equal(file.functions[0]?.location.startLine, 3);
  assert.equal(file.functions[0]?.location.endLine, 10);
  assert.equal(file.jsx.present, true);
  assert.deepEqual(file.jsx.elements.map((element) => element.name), [
    "form",
    "div",
    "Button",
    "span",
  ]);
  assert.deepEqual(
    file.jsx.elements.map((element) => element.location.startLine),
    [6, 7, 7, 7],
  );
});

test("parses JavaScript and JSX using their matching script kinds", async () => {
  const repository = await createRepository("javascript analysis ");
  await createFile(
    repository,
    "src/plain.js",
    "export const load = async () => ({ ready: true });\n",
  );
  await createFile(
    repository,
    "src/View.jsx",
    "export default function View() { return <main><Widget /></main>; }\n",
  );

  const manifest = await analyzeRepository(repository);
  const plain = getSuccessfulFile(manifest.files[0]);
  const view = getSuccessfulFile(manifest.files[1]);

  assert.equal(plain.path, "src/View.jsx");
  assert.equal(plain.jsx.present, true);
  assert.deepEqual(plain.jsx.elements.map((element) => element.name), [
    "main",
    "Widget",
  ]);
  assert.equal(view.path, "src/plain.js");
  assert.deepEqual(view.functions.map((entry) => [entry.name, entry.async]), [
    ["load", true],
  ]);
  assert.equal(view.jsx.present, false);
});

test("handles empty source files and excludes JSON inventory entries", async () => {
  const repository = await createRepository("empty source ");
  await createFile(repository, "src/empty.ts", "");
  await createFile(repository, "package.json", "{}\n");

  const manifest = await analyzeRepository(repository);
  const file = getSuccessfulFile(manifest.files[0]);

  assert.equal(manifest.files.length, 1);
  assert.deepEqual(file, {
    path: "src/empty.ts",
    status: "ok",
    sourceText: "",
    imports: [],
    exports: [],
    functions: [],
    classes: [],
    jsx: { present: false, elements: [] },
  });
});

test("returns structured errors for malformed source without stopping valid files", async () => {
  const repository = await createRepository("parse errors ");
  await createFile(repository, "src/Broken.tsx", "export const broken = (\n");
  await createFile(repository, "src/Valid.ts", "export function valid() {}\n");

  const manifest = await analyzeRepository(repository);
  const broken = manifest.files[0];
  const valid = getSuccessfulFile(manifest.files[1]);

  assert.equal(broken?.path, "src/Broken.tsx");
  assert.equal(broken?.status, "parse-error");
  if (broken?.status !== "parse-error") assert.fail("Expected a parse error");
  assert.ok(broken.errors.length > 0);
  assert.ok(broken.errors[0]?.message.length);
  assert.equal(broken.errors[0]?.line, 1);
  assert.ok((broken.errors[0]?.column ?? 0) > 0);
  assert.equal(valid.path, "src/Valid.ts");
  assert.deepEqual(valid.functions.map((entry) => entry.name), ["valid"]);
});

test("produces deterministic manifests ordered by relative source path", async () => {
  const repository = await createRepository("deterministic analysis ");
  await createFile(repository, "z-last.ts", "export const z = () => 1;\n");
  await createFile(repository, "nested/middle.jsx", "export default <Panel />;\n");
  await createFile(repository, "a-first.js", "export class A {}\n");

  const inventory = await scanRepository(repository);
  inventory.files.reverse();
  const first = await analyzeSources(inventory);
  const second = await analyzeSources(inventory);

  assert.deepEqual(first, second);
  assert.deepEqual(first.files.map((file) => file.path), [
    "a-first.js",
    "nested/middle.jsx",
    "z-last.ts",
  ]);
  assert.doesNotThrow(() => JSON.stringify(first));
});

async function analyzeRepository(repository: string) {
  return analyzeSources(await scanRepository(repository));
}

function getSuccessfulFile(
  file: Awaited<ReturnType<typeof analyzeRepository>>["files"][number] | undefined,
): SuccessfulSourceAnalysis {
  assert.ok(file);
  assert.equal(file.status, "ok");
  return file as SuccessfulSourceAnalysis;
}

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
