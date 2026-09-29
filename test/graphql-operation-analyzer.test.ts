import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { analyzeFunctionCalls } from "../src/function-call-analyzer.js";
import {
  analyzeGraphqlOperations,
  type SuccessfulGraphqlDocument,
} from "../src/graphql-operation-analyzer.js";
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

test("extracts operations, variables, nested selections, fragments, and directives", async () => {
  const repository = await createRepository("graphql documents ");
  await createFile(
    repository,
    "src/documents.ts",
    [
      'import { gql as graphql } from "@apollo/client";',
      "const GET_TICKET = graphql`",
      "  query GetTicket($ticketId: ID!, $includeNotes: Boolean = false) {",
      "    currentTicket: ticket(id: $ticketId) {",
      "      id",
      "      requester { id name }",
      "      notes @include(if: $includeNotes) { id }",
      "      ...TicketSummary",
      "      ... on ManagedTicket { status }",
      "    }",
      "  }",
      "  fragment TicketSummary on Ticket { subject status }",
      "`;",
      "",
    ].join("\n"),
  );

  const manifest = await analyzeRepository(repository);
  const document = getSuccessfulDocument(manifest.documents[0]);
  const operation = document.operations[0];
  const ticket = operation?.selections[0];

  assert.equal(document.name, "GET_TICKET");
  assert.equal(document.tag, "graphql");
  assert.equal(operation?.type, "query");
  assert.equal(operation?.name, "GetTicket");
  assert.deepEqual(
    operation?.variables.map(({ name, type, required, defaultValue }) => ({
      name,
      type,
      required,
      defaultValue,
    })),
    [
      { name: "ticketId", type: "ID!", required: true, defaultValue: undefined },
      {
        name: "includeNotes",
        type: "Boolean",
        required: false,
        defaultValue: "false",
      },
    ],
  );
  assert.equal(ticket?.kind, "field");
  if (ticket?.kind !== "field") assert.fail("Expected ticket field");
  assert.equal(ticket.name, "ticket");
  assert.equal(ticket.alias, "currentTicket");
  assert.deepEqual(ticket.arguments, [{ name: "id", value: "$ticketId" }]);
  assert.deepEqual(ticket.selections.map((selection) => selection.kind), [
    "field",
    "field",
    "field",
    "fragment-spread",
    "inline-fragment",
  ]);
  const notes = ticket.selections[2];
  assert.equal(notes?.kind, "field");
  if (notes?.kind !== "field") assert.fail("Expected notes field");
  assert.deepEqual(notes.directives, [
    { name: "include", arguments: [{ name: "if", value: "$includeNotes" }] },
  ]);
  assert.equal(document.fragments[0]?.name, "TicketSummary");
  assert.equal(document.fragments[0]?.typeCondition, "Ticket");
  assert.deepEqual(document.declarationLocation, {
    path: "src/documents.ts",
    startLine: 2,
    endLine: 13,
  });
  assert.equal(operation?.location.path, "src/documents.ts");
  assert.equal(operation?.location.startLine, 3);
});

test("supports query, mutation, subscription, anonymous, and multi-operation documents", async () => {
  const repository = await createRepository("graphql operation types ");
  await createFile(
    repository,
    "src/types.ts",
    [
      'import gql from "graphql-tag";',
      "const DOCUMENT = gql`",
      "  query GetTickets { tickets { id } }",
      "  mutation CreateTicket { createTicket { id } }",
      "  subscription TicketChanged { ticketChanged { id } }",
      "  { viewer { id } }",
      "`;",
      "",
    ].join("\n"),
  );
  await createFile(
    repository,
    "src/local-tag.ts",
    [
      "function gql(strings) { return strings; }",
      "const NOT_GRAPHQL = gql`query Ignored { ignored }`;",
      "",
    ].join("\n"),
  );

  const manifest = await analyzeRepository(repository);
  const document = getSuccessfulDocument(manifest.documents[0]);

  assert.equal(manifest.documents.length, 1);
  assert.deepEqual(
    document.operations.map((operation) => [operation.type, operation.name]),
    [
      ["query", "GetTickets"],
      ["mutation", "CreateTicket"],
      ["subscription", "TicketChanged"],
      ["query", undefined],
    ],
  );
});

test("binds proven Apollo hooks and mutation executors to local documents", async () => {
  const repository = await createRepository("graphql hooks ");
  await createFile(
    repository,
    "src/hooks.tsx",
    [
      'import { gql, useQuery as queryHook, useMutation } from "@apollo/client";',
      "const GET_TICKETS = gql`query GetTickets { tickets { id } }`;",
      "const CREATE_TICKET = gql`mutation CreateTicket($input: String!) { createTicket(input: $input) { id } }`;",
      "queryHook(GET_TICKETS);",
      "queryHook(selectedQuery);",
      "export function TicketForm() {",
      "  const [createTicket] = useMutation(CREATE_TICKET);",
      "  const save = async (ticket) => {",
      "    await createTicket({ variables: { input: ticket, notify: true } });",
      "  };",
      "  return <form />;",
      "}",
      "",
    ].join("\n"),
  );

  const manifest = await analyzeRepository(repository);
  const [query, dynamicQuery, setup, mutation] = manifest.executions;

  assert.equal(query?.scope, "module");
  assert.equal(query?.executor, "queryHook");
  assert.equal(query?.operationType, "query");
  assert.equal(query?.document.kind, "local");
  assert.equal(query?.awaited, false);
  assert.deepEqual(dynamicQuery?.document, {
    kind: "dynamic",
    expression: "selectedQuery",
  });
  assert.equal(setup?.phase, "setup");
  assert.equal(setup?.localExecutor, "createTicket");
  assert.equal(setup?.document.kind, "local");
  assert.equal(mutation?.phase, "execute");
  assert.equal(mutation?.executor, "createTicket");
  assert.equal(mutation?.awaited, true);
  assert.equal(mutation?.caller?.name, "save");
  assert.match(mutation?.caller?.id ?? "", /^src\/hooks\.tsx::save@/);
  assert.deepEqual(mutation?.variables, {
    kind: "entries",
    entries: [
      {
        name: "input",
        value: { kind: "dynamic", expression: "ticket" },
        location: { path: "src/hooks.tsx", startLine: 9, endLine: 9 },
      },
      {
        name: "notify",
        value: { kind: "static", value: true },
        location: { path: "src/hooks.tsx", startLine: 9, endLine: 9 },
      },
    ],
  });
});

test("recognizes proven aliased Apollo clients and excludes arbitrary query methods", async () => {
  const repository = await createRepository("graphql clients ");
  await createFile(
    repository,
    "src/client.ts",
    [
      'import { gql, ApolloClient as Client } from "@apollo/client";',
      "const client = new Client({});",
      "const GET_TICKET = gql`query GetTicket { ticket { id } }`;",
      "const CREATE_TICKET = gql`mutation CreateTicket { createTicket { id } }`;",
      "async function run(ticketId) {",
      "  await client.query({ query: GET_TICKET, variables: { ticketId, includeNotes: true } });",
      "  client.mutate({ mutation: CREATE_TICKET, variables: variablesInput });",
      "  database.query({ query: GET_TICKET });",
      "}",
      "",
    ].join("\n"),
  );

  const manifest = await analyzeRepository(repository);
  const [query, mutation] = manifest.executions;

  assert.equal(manifest.executions.length, 2);
  assert.equal(query?.executor, "client.query");
  assert.equal(query?.awaited, true);
  assert.equal(query?.caller?.name, "run");
  assert.deepEqual(query?.variables, {
    kind: "entries",
    entries: [
      {
        name: "ticketId",
        value: { kind: "dynamic", expression: "ticketId" },
        location: { path: "src/client.ts", startLine: 6, endLine: 6 },
      },
      {
        name: "includeNotes",
        value: { kind: "static", value: true },
        location: { path: "src/client.ts", startLine: 6, endLine: 6 },
      },
    ],
  });
  assert.equal(mutation?.executor, "client.mutate");
  assert.deepEqual(mutation?.variables, {
    kind: "dynamic",
    expression: "variablesInput",
  });
  assert.deepEqual(query?.executorImportLocation, {
    path: "src/client.ts",
    startLine: 1,
    endLine: 1,
  });
  assert.deepEqual(query?.clientInstanceLocation, {
    path: "src/client.ts",
    startLine: 2,
    endLine: 2,
  });
});

test("associates inline callback execution with its own callable identity", async () => {
  const repository = await createRepository("graphql callback ");
  await createFile(
    repository,
    "src/callback.ts",
    [
      'import { gql, useQuery } from "@apollo/client";',
      "const GET_ITEM = gql`query GetItem { item { id } }`;",
      "function load(items) {",
      "  items.forEach((item) => useQuery(GET_ITEM, { variables: { id: item.id } }));",
      "}",
      "",
    ].join("\n"),
  );

  const manifest = await analyzeRepository(repository);
  const execution = manifest.executions[0];

  assert.equal(execution?.caller?.name, "<inline-callback>");
  assert.match(execution?.caller?.id ?? "", /::<inline-callback>@/);
  assert.notEqual(execution?.caller?.name, "load");
});

test("analyzes proven GraphQL documents in TS, TSX, JS, and JSX", async () => {
  const repository = await createRepository("graphql languages ");
  await createFile(
    repository,
    "src/a.ts",
    'import { gql } from "@apollo/client"; const A = gql`query A { a }`;\n',
  );
  await createFile(
    repository,
    "src/b.tsx",
    'import { gql } from "@apollo/client"; const B = gql`query B { b }`; export const View = () => <div />;\n',
  );
  await createFile(
    repository,
    "src/c.js",
    'import gql from "graphql-tag"; const C = gql`query C { c }`;\n',
  );
  await createFile(
    repository,
    "src/d.jsx",
    'import gql from "graphql-tag"; const D = gql`query D { d }`; export const View = () => <div />;\n',
  );

  const manifest = await analyzeRepository(repository);

  assert.deepEqual(manifest.documents.map((document) => document.name), [
    "A",
    "B",
    "C",
    "D",
  ]);
});

test("isolates malformed GraphQL and source while producing deterministic output", async () => {
  const repository = await createRepository("malformed graphql ");
  await createFile(
    repository,
    "src/Documents.ts",
    [
      'import { gql } from "@apollo/client";',
      "const BROKEN = gql`query Broken { tickets {`;",
      "const VALID = gql`query Valid { tickets { id } }`;",
      "",
    ].join("\n"),
  );
  await createFile(repository, "src/Broken.ts", "function broken( {\n");

  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  const calls = analyzeFunctionCalls(sources);
  const first = analyzeGraphqlOperations(sources, calls);
  const second = analyzeGraphqlOperations(sources, calls);

  assert.equal(first.documents[0]?.status, "parse-error");
  if (first.documents[0]?.status !== "parse-error") {
    assert.fail("Expected malformed GraphQL document");
  }
  assert.ok(first.documents[0].errors[0]?.message);
  assert.ok((first.documents[0].errors[0]?.line ?? 0) > 0);
  assert.equal(first.documents[1]?.status, "ok");
  assert.equal(
    sources.files.find((file) => file.path === "src/Broken.ts")?.status,
    "parse-error",
  );
  assert.deepEqual(first, second);
  assert.doesNotThrow(() => JSON.stringify(first));
});

function getSuccessfulDocument(
  document: ReturnType<typeof analyzeGraphqlOperations>["documents"][number] | undefined,
): SuccessfulGraphqlDocument {
  assert.ok(document);
  assert.equal(document.status, "ok");
  return document as SuccessfulGraphqlDocument;
}

async function analyzeRepository(repository: string) {
  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  const calls = analyzeFunctionCalls(sources);
  return analyzeGraphqlOperations(sources, calls);
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
