import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { analyzeFunctionCalls } from "../src/function-call-analyzer.js";
import { analyzeHttpRequests } from "../src/http-request-analyzer.js";
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

test("extracts fetch requests with static and dynamic request data", async () => {
  const repository = await createRepository("fetch requests ");
  await createFile(
    repository,
    "src/fetch.ts",
    [
      "async function load(ticketId, payload, requestMethod, token, requestUrl) {",
      '  fetch("/api/tickets");',
      "  await fetch(`/api/tickets/${ticketId}`, {",
      '    method: "post",',
      "    headers: {",
      '      "Content-Type": "application/json",',
      "      Authorization: token,",
      "    },",
      "    body: JSON.stringify(payload),",
      "  });",
      "  fetch(requestUrl, { method: requestMethod });",
      "}",
      "",
    ].join("\n"),
  );

  const { requests } = await analyzeRepository(repository);
  const [get, post, dynamic] = requests;

  assert.equal(requests.length, 3);
  assert.deepEqual(get?.method, { kind: "static", value: "GET" });
  assert.deepEqual(get?.url, { kind: "static", value: "/api/tickets" });
  assert.equal(get?.awaited, false);
  assert.equal(get?.scope, "callable");
  assert.equal(get?.caller?.name, "load");
  assert.match(get?.caller?.id ?? "", /^src\/fetch\.ts::load@/);

  assert.deepEqual(post?.method, { kind: "static", value: "POST" });
  assert.deepEqual(post?.url, {
    kind: "dynamic",
    expression: "`/api/tickets/${ticketId}`",
  });
  assert.deepEqual(post?.body, {
    kind: "dynamic",
    expression: "JSON.stringify(payload)",
  });
  assert.equal(post?.awaited, true);
  assert.deepEqual(post?.headers, {
    kind: "entries",
    entries: [
      {
        name: "Content-Type",
        value: { kind: "static", value: "application/json" },
        location: { path: "src/fetch.ts", startLine: 6, endLine: 6 },
      },
      {
        name: "Authorization",
        value: { kind: "dynamic", expression: "token" },
        location: { path: "src/fetch.ts", startLine: 7, endLine: 7 },
      },
    ],
  });
  assert.deepEqual(dynamic?.method, {
    kind: "dynamic",
    expression: "requestMethod",
  });
  assert.deepEqual(dynamic?.url, {
    kind: "dynamic",
    expression: "requestUrl",
  });
  assert.deepEqual(post?.location, {
    path: "src/fetch.ts",
    startLine: 3,
    endLine: 10,
  });
});

test("extracts Axios method calls while excluding unrelated clients and wrappers", async () => {
  const repository = await createRepository("axios methods ");
  await createFile(
    repository,
    "src/axios-methods.ts",
    [
      'import axiosClient from "axios";',
      'import { createTicket } from "./ticket-api.js";',
      "function requests(ticket) {",
      '  axiosClient.get("/tickets");',
      '  axiosClient.post("/tickets", ticket);',
      '  axiosClient.put("/tickets/1", ticket);',
      '  axiosClient.patch("/tickets/1", ticket);',
      '  axiosClient.delete("/tickets/1");',
      '  cache.get("ticket");',
      '  database.delete("ticket");',
      "  createTicket(ticket);",
      "}",
      "",
    ].join("\n"),
  );

  const { requests } = await analyzeRepository(repository);

  assert.deepEqual(requests.map((request) => request.method), [
    { kind: "static", value: "GET" },
    { kind: "static", value: "POST" },
    { kind: "static", value: "PUT" },
    { kind: "static", value: "PATCH" },
    { kind: "static", value: "DELETE" },
  ]);
  assert.ok(requests.every((request) => request.client.expression === "axiosClient"));
  assert.ok(requests.every((request) => request.client.library === "axios"));
  assert.deepEqual(requests[1]?.body, { kind: "dynamic", expression: "ticket" });
  assert.deepEqual(requests[0]?.client.importLocation, {
    path: "src/axios-methods.ts",
    startLine: 1,
    endLine: 1,
  });
});

test("supports Axios config and request forms with static and dynamic fields", async () => {
  const repository = await createRepository("axios config ");
  await createFile(
    repository,
    "src/config.ts",
    [
      'import axios from "axios";',
      "function send(ticket, method, url, headers) {",
      '  axios({ method: "POST", url: "/tickets", data: ticket });',
      "  axios.request({ method, url, headers });",
      "  axios.request(dynamicConfig);",
      "}",
      "",
    ].join("\n"),
  );

  const { requests } = await analyzeRepository(repository);

  assert.deepEqual(requests[0]?.method, { kind: "static", value: "POST" });
  assert.deepEqual(requests[0]?.url, { kind: "static", value: "/tickets" });
  assert.deepEqual(requests[0]?.body, { kind: "dynamic", expression: "ticket" });
  assert.deepEqual(requests[1]?.method, { kind: "dynamic", expression: "method" });
  assert.deepEqual(requests[1]?.url, { kind: "dynamic", expression: "url" });
  assert.deepEqual(requests[1]?.headers, {
    kind: "dynamic",
    expression: "headers",
  });
  assert.deepEqual(requests[2]?.method, {
    kind: "dynamic",
    expression: "dynamicConfig.method",
  });
  assert.deepEqual(requests[2]?.url, {
    kind: "dynamic",
    expression: "dynamicConfig.url",
  });
});

test("tracks statically proven Axios instances and safely combines static URLs", async () => {
  const repository = await createRepository("axios instances ");
  await createFile(
    repository,
    "src/instances.ts",
    [
      'import client from "axios";',
      'const api = client.create({ baseURL: "/api" });',
      "const remote = client.create({ baseURL: API_BASE_URL });",
      "async function save(ticket) {",
      '  await api.post("/tickets", ticket);',
      '  remote.get("/tickets");',
      "}",
      "",
    ].join("\n"),
  );

  const { requests } = await analyzeRepository(repository);
  const [api, remote] = requests;

  assert.deepEqual(api?.baseUrl, { kind: "static", value: "/api" });
  assert.deepEqual(api?.effectiveUrl, {
    kind: "static",
    value: "/api/tickets",
  });
  assert.deepEqual(api?.url, { kind: "static", value: "/tickets" });
  assert.equal(api?.awaited, true);
  assert.deepEqual(api?.client.instanceLocation, {
    path: "src/instances.ts",
    startLine: 2,
    endLine: 2,
  });
  assert.deepEqual(remote?.baseUrl, {
    kind: "dynamic",
    expression: "API_BASE_URL",
  });
  assert.equal(remote?.effectiveUrl, undefined);
});

test("associates top-level and inline-callback requests with the correct scope", async () => {
  const repository = await createRepository("http scopes ");
  await createFile(
    repository,
    "src/scopes.ts",
    [
      'fetch("/api/bootstrap");',
      "function load(items) {",
      "  items.forEach(async (item) => {",
      "    await fetch(`/api/items/${item.id}`);",
      "  });",
      "}",
      "",
    ].join("\n"),
  );

  const { requests } = await analyzeRepository(repository);
  const [topLevel, callback] = requests;

  assert.equal(topLevel?.scope, "module");
  assert.equal(topLevel?.caller, undefined);
  assert.equal(callback?.scope, "callable");
  assert.equal(callback?.caller?.name, "<inline-callback>");
  assert.match(callback?.caller?.id ?? "", /::<inline-callback>@/);
  assert.notEqual(callback?.caller?.name, "load");
});

test("analyzes HTTP evidence in TS, TSX, JS, and JSX", async () => {
  const repository = await createRepository("http languages ");
  await createFile(repository, "src/a.ts", 'function a() { fetch("/ts"); }\n');
  await createFile(
    repository,
    "src/b.tsx",
    'function b() { fetch("/tsx"); return <div />; }\n',
  );
  await createFile(repository, "src/c.js", 'function c() { fetch("/js"); }\n');
  await createFile(
    repository,
    "src/d.jsx",
    'function d() { fetch("/jsx"); return <div />; }\n',
  );

  const { requests } = await analyzeRepository(repository);

  assert.deepEqual(requests.map((request) => request.url), [
    { kind: "static", value: "/ts" },
    { kind: "static", value: "/tsx" },
    { kind: "static", value: "/js" },
    { kind: "static", value: "/jsx" },
  ]);
});

test("isolates malformed files and produces deterministic repeated requests", async () => {
  const repository = await createRepository("deterministic http ");
  await createFile(
    repository,
    "src/Broken.ts",
    'function broken( { fetch("/broken");\n',
  );
  await createFile(
    repository,
    "src/Valid.ts",
    'function valid() { fetch("/same"); fetch("/same"); }\n',
  );

  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  const calls = analyzeFunctionCalls(sources);
  const first = analyzeHttpRequests(sources, calls);
  const second = analyzeHttpRequests(sources, calls);

  assert.equal(
    sources.files.find((file) => file.path === "src/Broken.ts")?.status,
    "parse-error",
  );
  assert.equal(first.requests.length, 2);
  assert.deepEqual(first, second);
  assert.doesNotThrow(() => JSON.stringify(first));
});

async function analyzeRepository(repository: string) {
  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  const calls = analyzeFunctionCalls(sources);
  return analyzeHttpRequests(sources, calls);
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
