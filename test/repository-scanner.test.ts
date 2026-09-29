import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { scanRepository } from "../src/repository-scanner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("discovers and classifies supported files in nested directories", async () => {
  const repository = await createRepository("mixed sources ");
  await createFile(repository, "src/App.tsx", "export const App = () => null;\n");
  await createFile(repository, "src/api/client.ts", "export {};\n");
  await createFile(repository, "scripts/setup.js", "export {};\n");
  await createFile(repository, "legacy/View.jsx", "export default null;\n");
  await createFile(repository, "package.json", "{}\n");
  await createFile(repository, "README.md", "ignored\n");

  const inventory = await scanRepository(repository);

  assert.equal(inventory.root, path.resolve(repository));
  assert.deepEqual(
    inventory.files.map(({ path: filePath, extension, type }) => ({
      path: filePath,
      extension,
      type,
    })),
    [
      { path: "legacy/View.jsx", extension: ".jsx", type: "javascript-react" },
      { path: "package.json", extension: ".json", type: "json" },
      { path: "scripts/setup.js", extension: ".js", type: "javascript" },
      { path: "src/App.tsx", extension: ".tsx", type: "typescript-react" },
      { path: "src/api/client.ts", extension: ".ts", type: "typescript" },
    ],
  );
  assert.ok(inventory.files.every((file) => file.sizeBytes > 0));
});

test("excludes dependency, VCS, build, framework, and coverage output", async () => {
  const repository = await createRepository("ignored ");
  const ignoredDirectories = [
    "node_modules",
    ".git",
    "build",
    "dist",
    "out",
    ".next",
    ".nuxt",
    ".output",
    ".svelte-kit",
    ".turbo",
    "coverage",
  ];

  await Promise.all(
    ignoredDirectories.map((directory) =>
      createFile(repository, `${directory}/ignored.ts`, "ignored\n"),
    ),
  );
  await createFile(repository, "src/included.ts", "included\n");

  const inventory = await scanRepository(repository);

  assert.deepEqual(inventory.files.map((file) => file.path), ["src/included.ts"]);
});

test("returns an empty inventory for an empty repository", async () => {
  const repository = await createRepository("empty ");

  const inventory = await scanRepository(repository);

  assert.deepEqual(inventory, { root: path.resolve(repository), files: [] });
});

test("rejects a nonexistent repository path with an actionable error", async () => {
  const repository = path.join(tmpdir(), `missing-${Date.now()}`);

  await assert.rejects(
    scanRepository(repository),
    new RegExp(`Repository path does not exist: ${escapeRegExp(repository)}`),
  );
});

test("rejects a path that is not a directory", async () => {
  const repository = await createRepository("file root ");
  const filePath = await createFile(repository, "source.ts", "export {};\n");

  await assert.rejects(
    scanRepository(filePath),
    new RegExp(`Repository path is not a directory: ${escapeRegExp(filePath)}`),
  );
});

test("returns deterministic output and ordering", async () => {
  const repository = await createRepository("deterministic ");
  await createFile(repository, "z-last.js", "z\n");
  await createFile(repository, "a-first.ts", "a\n");
  await createFile(repository, "nested/middle.json", "{}\n");

  const firstInventory = await scanRepository(repository);
  const secondInventory = await scanRepository(repository);

  assert.deepEqual(firstInventory, secondInventory);
  assert.deepEqual(firstInventory.files.map((file) => file.path), [
    "a-first.ts",
    "nested/middle.json",
    "z-last.js",
  ]);
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
): Promise<string> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  return filePath;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
