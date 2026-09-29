import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  analyzeFunctionCalls,
  type CallableRecord,
  type FunctionCall,
} from "../src/function-call-analyzer.js";
import { scanRepository } from "../src/repository-scanner.js";
import { analyzeSources } from "../src/source-analyzer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("extracts local, imported, member, unresolved, awaited, and optional calls", async () => {
  const repository = await createRepository("call bindings ");
  await createFile(
    repository,
    "src/save.ts",
    [
      'import saveDefault from "./save-default.js";',
      'import { persistTicket, createTicket as create } from "./tickets.js";',
      "function validate() { return true; }",
      "const audit = () => {};",
      "async function handleSave(ticketId, formData) {",
      "  validate();",
      "  audit();",
      "  await persistTicket(ticketId, formData);",
      "  create();",
      "  saveDefault();",
      '  services.ticket.save("now");',
      "  missing();",
      "  onComplete?.();",
      "}",
      "",
    ].join("\n"),
  );

  const manifest = await analyzeRepository(repository);
  const caller = getCaller(manifest.callers, "handleSave");

  assert.equal(caller.async, true);
  assert.equal(caller.kind, "function-declaration");
  assert.deepEqual(caller.location, {
    path: "src/save.ts",
    startLine: 5,
    endLine: 14,
  });
  assert.deepEqual(caller.calls.map((call) => call.expression), [
    "validate",
    "audit",
    "persistTicket",
    "create",
    "saveDefault",
    "services.ticket.save",
    "missing",
    "onComplete",
  ]);

  const validate = getCall(caller, "validate", "local");
  assert.equal(validate.callee.name, "validate");
  assert.match(validate.callee.id, /^src\/save\.ts::validate@/);
  assert.deepEqual(validate.callee.location, {
    path: "src/save.ts",
    startLine: 3,
    endLine: 3,
  });

  const audit = getCall(caller, "audit", "local");
  assert.equal(audit.callee.name, "audit");
  assert.equal(audit.awaited, false);

  const persist = getCall(caller, "persistTicket", "imported");
  assert.equal(persist.importedName, "persistTicket");
  assert.equal(persist.source, "./tickets.js");
  assert.equal(persist.awaited, true);
  assert.deepEqual(persist.arguments, ["ticketId", "formData"]);
  assert.deepEqual(persist.importLocation, {
    path: "src/save.ts",
    startLine: 2,
    endLine: 2,
  });

  const alias = getCall(caller, "create", "imported");
  assert.equal(alias.importedName, "createTicket");
  assert.equal(alias.localName, "create");
  const defaultCall = getCall(caller, "saveDefault", "imported");
  assert.equal(defaultCall.importedName, "default");
  assert.equal(defaultCall.source, "./save-default.js");
  assert.equal(getCall(caller, "services.ticket.save", "member-expression").arguments[0], '"now"');
  assert.equal(getCall(caller, "missing", "unresolved").awaited, false);
  assert.equal(getCall(caller, "onComplete", "unresolved").optional, true);
  assert.deepEqual(caller.calls[0]?.location, {
    path: "src/save.ts",
    startLine: 6,
    endLine: 6,
  });
});

test("supports arrow and function-expression callers, repeated calls, and recursion", async () => {
  const repository = await createRepository("callable forms ");
  await createFile(
    repository,
    "src/forms.ts",
    [
      "const target = () => true;",
      "const arrowCaller = () => { target(); target(); };",
      "const expressionCaller = function () { target(); };",
      "function recursive() { recursive(); }",
      "",
    ].join("\n"),
  );

  const manifest = await analyzeRepository(repository);
  const arrow = getCaller(manifest.callers, "arrowCaller");
  const expression = getCaller(manifest.callers, "expressionCaller");
  const recursive = getCaller(manifest.callers, "recursive");

  assert.equal(arrow.kind, "arrow-function");
  assert.deepEqual(arrow.calls.map((call) => call.expression), ["target", "target"]);
  assert.ok(arrow.calls.every((call) => call.bindingType === "local"));
  assert.equal(expression.kind, "function-expression");
  assert.equal(expression.calls[0]?.bindingType, "local");
  const recursiveCall = getCall(recursive, "recursive", "local");
  assert.equal(recursiveCall.callee.id, recursive.id);
});

test("captures nested calls and calls throughout straightforward control flow", async () => {
  const repository = await createRepository("control flow calls ");
  await createFile(
    repository,
    "src/control.ts",
    [
      "function run(items) {",
      "  notify(formatMessage(getResult()));",
      "  if (isValid()) { createTicket(); } else { showError(); }",
      "  for (const item of items) { processItem(item); }",
      "  try { save(); } catch (error) { reportError(error); } finally { stopLoading(); }",
      "}",
      "",
    ].join("\n"),
  );

  const manifest = await analyzeRepository(repository);
  const run = getCaller(manifest.callers, "run");

  assert.deepEqual(run.calls.map((call) => call.expression), [
    "notify",
    "formatMessage",
    "getResult",
    "isValid",
    "createTicket",
    "showError",
    "processItem",
    "save",
    "reportError",
    "stopLoading",
  ]);
});

test("does not treat callback values as calls and isolates inline callback bodies", async () => {
  const repository = await createRepository("callback calls ");
  await createFile(
    repository,
    "src/callbacks.ts",
    [
      "function formatTicket(item) { return item; }",
      "function render(items) {",
      "  items.map(formatTicket);",
      "  items.map((item) => formatTicket(item));",
      "}",
      "",
    ].join("\n"),
  );

  const manifest = await analyzeRepository(repository);
  const render = getCaller(manifest.callers, "render");
  const callback = manifest.callers.find(
    (caller) => caller.kind === "inline-callback",
  );

  assert.deepEqual(render.calls.map((call) => call.expression), ["items.map", "items.map"]);
  assert.ok(callback);
  assert.equal(callback.parentId, render.id);
  assert.deepEqual(callback.calls.map((call) => call.expression), ["formatTicket"]);
  assert.equal(callback.calls[0]?.bindingType, "local");
});

test("uses distinct stable identities for same-named functions in separate files", async () => {
  const repository = await createRepository("call identities ");
  await createFile(repository, "src/a.ts", "function save() { save(); }\n");
  await createFile(repository, "src/b.ts", "function save() { save(); }\n");

  const first = await analyzeRepository(repository);
  const second = await analyzeRepository(repository);
  const saves = first.callers.filter((caller) => caller.name === "save");

  assert.equal(saves.length, 2);
  assert.notEqual(saves[0]?.id, saves[1]?.id);
  assert.match(saves[0]?.id ?? "", /^src\/a\.ts::save@/);
  assert.match(saves[1]?.id ?? "", /^src\/b\.ts::save@/);
  assert.deepEqual(first, second);
  assert.doesNotThrow(() => JSON.stringify(first));
});

test("analyzes TS, TSX, JS, and JSX files", async () => {
  const repository = await createRepository("language calls ");
  await createFile(repository, "src/a.ts", "export function fromTs() { calledTs(); }\n");
  await createFile(
    repository,
    "src/b.tsx",
    "export function fromTsx() { calledTsx(); return <div />; }\n",
  );
  await createFile(repository, "src/c.js", "export function fromJs() { calledJs(); }\n");
  await createFile(
    repository,
    "src/d.jsx",
    "export function fromJsx() { calledJsx(); return <div />; }\n",
  );

  const manifest = await analyzeRepository(repository);

  assert.deepEqual(manifest.callers.map((caller) => caller.name), [
    "fromTs",
    "fromTsx",
    "fromJs",
    "fromJsx",
  ]);
  assert.deepEqual(
    manifest.callers.map((caller) => caller.calls[0]?.expression),
    ["calledTs", "calledTsx", "calledJs", "calledJsx"],
  );
});

test("isolates malformed files while retaining deterministic valid-file output", async () => {
  const repository = await createRepository("malformed calls ");
  await createFile(
    repository,
    "src/Broken.ts",
    "function broken( { missing();\n",
  );
  await createFile(
    repository,
    "src/Valid.ts",
    "function valid() { called(); }\n",
  );

  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  const manifest = analyzeFunctionCalls(sources);

  assert.equal(
    sources.files.find((file) => file.path === "src/Broken.ts")?.status,
    "parse-error",
  );
  assert.deepEqual(manifest.callers.map((caller) => caller.name), ["valid"]);
});

function getCaller(callers: CallableRecord[], name: string): CallableRecord {
  const caller = callers.find((candidate) => candidate.name === name);
  assert.ok(caller, `Expected caller ${name}`);
  return caller;
}

function getCall<T extends FunctionCall["bindingType"]>(
  caller: CallableRecord,
  expression: string,
  bindingType: T,
): Extract<FunctionCall, { bindingType: T }> {
  const call = caller.calls.find((candidate) => candidate.expression === expression);
  assert.ok(call, `Expected call ${expression}`);
  assert.equal(call.bindingType, bindingType);
  return call as Extract<FunctionCall, { bindingType: T }>;
}

async function analyzeRepository(repository: string) {
  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  return analyzeFunctionCalls(sources);
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
