import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatProductContractEvidence,
  getContractEndpoints,
  getContractOperation,
  getContractOperationsByType,
  getContractType,
  ingestApiDocumentation,
  validateProductContractEvidence,
  type ProductContractEvidence,
} from "../src/product-contract-evidence.js";

const GRAPHQL_FIXTURE = `
API Endpoint
US: https://api.example.test/graphql
EU: https://euapi.example.test/graphql

Authentication
Authorization: Bearer secret-live-token
CustomerSubDomain: identifies the customer subdomain header
Content-Type: application/json header

Query
getTickets(input: TicketListInput!, cursor: String = null): TicketList - Fetches tickets exactly as documented.
getTickets(input: TicketListInput!, cursor: String = null): TicketList - Fetches tickets exactly as documented.

Mutation
createTicket(input: CreateTicketInput!): Ticket

Subscription
ticketChanged(id: ID!): Ticket

Type Ticket - A support ticket.
id: ID! - Stable identifier.
subject: String! - Ticket subject.
status: String - Current status.

Type ListInfo - Metadata related to pagination.
page: Int - Page number.
pageSize: Int - Maximum records per page.
hasMore: Boolean - Whether more records exist.
totalCount: Int - Total records.

Pagination uses page, pageSize, hasMore, and totalCount.

\`\`\`graphql
query getTickets($input: TicketListInput!) { getTickets(input: $input) { tickets { id } } }
\`\`\`
`;

test("ingests deterministic GraphQL documentation with source metadata and immutable input", async () => {
  const input = supplied(GRAPHQL_FIXTURE);
  const before = JSON.stringify(input);
  const first = await ingestApiDocumentation(input);
  const second = await ingestApiDocumentation(input);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(input), before);
  assert.equal(first.source.requestedUrl, "https://docs.example.test/api");
  assert.equal(first.source.finalUrl, "https://docs.example.test/api");
  assert.equal(first.source.retrievalMethod, "supplied");
  assert.equal(first.source.status, "complete");
  assert.equal(first.api.style, "graphql");
  assert.doesNotThrow(() => JSON.stringify(first));
});

test("extracts endpoints, documented regions, authentication structure, and redacts secrets", async () => {
  const contract = await ingestApiDocumentation(supplied(GRAPHQL_FIXTURE));
  assert.deepEqual(getContractEndpoints(contract).map((item) => [item.environmentOrRegion, item.value]), [
    ["US", "https://api.example.test/graphql"], ["EU", "https://euapi.example.test/graphql"],
  ]);
  assert.ok(contract.api.endpoints.every((item) => item.provenance.length > 0));
  assert.ok(contract.api.authentication.some((item) => item.header === "Authorization" && item.scheme === "Bearer"));
  assert.ok(contract.api.authentication.some((item) => item.header === "CustomerSubDomain"));
  assert.ok(contract.api.authentication.some((item) => item.header === "Content-Type"));
  assert.doesNotMatch(JSON.stringify(contract), /secret-live-token/);
  assert.match(JSON.stringify(contract), /\[REDACTED\]/);
});

test("extracts exact operation signatures, arguments, return types, examples, and deduplicated provenance", async () => {
  const contract = await ingestApiDocumentation(supplied(GRAPHQL_FIXTURE));
  const query = getContractOperation(contract, "getTickets", "query")!;
  assert.ok(query);
  assert.equal(query.variants.length, 1);
  assert.equal(query.provenance.length, 2);
  assert.equal(query.variants[0]?.returnType, "TicketList");
  assert.deepEqual(query.variants[0]?.arguments.map((item) => [item.name, item.type, item.required, item.defaultValue]), [
    ["cursor", "String", false, "null"], ["input", "TicketListInput!", true, undefined],
  ]);
  assert.equal(query.variants[0]?.description, "Fetches tickets exactly as documented.");
  assert.equal(query.examples.length, 1);
  assert.equal(query.examples[0]?.kind, "graphql");
  assert.ok(query.examples[0]?.provenance.length);
  assert.deepEqual(getContractOperationsByType(contract, "mutation").map((item) => item.name), ["createTicket"]);
  assert.deepEqual(getContractOperationsByType(contract, "subscription").map((item) => item.name), ["ticketChanged"]);
});

test("extracts types, fields, descriptions, and explicit pagination evidence", async () => {
  const contract = await ingestApiDocumentation(supplied(GRAPHQL_FIXTURE));
  const ticket = getContractType(contract, "Ticket")!;
  assert.equal(ticket.description, "A support ticket.");
  assert.deepEqual(ticket.fields.map((item) => [item.name, item.type]), [
    ["id", "ID!"], ["status", "String"], ["subject", "String!"],
  ]);
  assert.equal(ticket.fields.find((item) => item.name === "subject")?.description, "Ticket subject.");
  assert.ok(ticket.provenance.length && ticket.fields.every((item) => item.provenance.length));
  assert.equal(contract.api.pagination.length, 1);
  assert.deepEqual(contract.api.pagination[0]?.fields.map((item) => item.name), ["hasMore", "page", "pageSize", "totalCount"]);
});

test("distinguishes REST and unknown documentation without treating either as GraphQL", async () => {
  const rest = await ingestApiDocumentation(supplied("REST API\nGET /tickets\nPOST /tickets"));
  assert.equal(rest.api.style, "rest");
  assert.deepEqual(rest.api.operations.map((item) => [item.type, item.name]), [
    ["unknown", "GET /tickets"], ["unknown", "POST /tickets"],
  ]);
  const unknown = await ingestApiDocumentation(supplied("Product API information will be published later."));
  assert.equal(unknown.api.style, "unknown");
  assert.equal(unknown.api.operations.length, 0);
  assert.equal(unknown.unresolvedEvidence.length, 1);
});

test("preserves conflicting definitions instead of selecting one", async () => {
  const contract = await ingestApiDocumentation(supplied("Query\ngetTicket(id: ID!): Ticket\ngetTicket(id: String!): TicketResult"));
  const operation = getContractOperation(contract, "getTicket", "query")!;
  assert.equal(operation.conflict, true);
  assert.equal(operation.variants.length, 2);
  assert.deepEqual(new Set(operation.variants.map((item) => item.returnType)), new Set(["Ticket", "TicketResult"]));
});

test("parses generic generated HTML operation and type structures", async () => {
  const html = `<html><head><title>Generated API</title></head><body>
    <p>GraphQL API Endpoint EU: https://eu.example.test/graphql</p>
    <section id="query-findThings" class="operation operation-query">
      <h2 class="operation-heading"><code>findThings</code></h2>
      <div class="operation-description"><p>Finds things.</p></div>
      <div class="operation-response"><p>Returns <a href="#definition-ThingList"><code>ThingList</code></a></p></div>
      <div class="operation-arguments"><tbody><tr><td><span class="property-name"><code>input</code></span><span class="property-type"><code>FindInput!</code></span></td><td>Search input.</td></tr></tbody></div>
      <div class="operation-query-example"><code>query findThings { findThings { id } }</code></div>
    </section>
    <section id="definition-Thing" class="definition definition-object">
      <h2 class="definition-heading">Thing</h2><div class="definition-description"><p>A thing.</p></div>
      <div class="definition-properties"><tbody><tr><td><span class="property-name"><code>id</code></span><span class="property-type"><code>ID!</code></span></td><td>Identifier.</td></tr></tbody></div>
    </section></body></html>`;
  const contract = await ingestApiDocumentation({ ...supplied(html), document: { ...supplied(html).document!, contentType: "html" } });
  assert.equal(contract.source.title, "Example API");
  assert.equal(contract.api.style, "graphql");
  assert.equal(getContractOperation(contract, "findThings")?.variants[0]?.arguments[0]?.required, true);
  assert.equal(getContractType(contract, "Thing")?.fields[0]?.description, "Identifier.");
});

test("uses only the supplied URL fetch and never executes or crawls documented operations", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(GRAPHQL_FIXTURE, { status: 200, headers: { "content-type": "text/plain" } });
  };
  const contract = await ingestApiDocumentation({ url: "https://docs.example.test/api", fetch: fetcher });
  assert.deepEqual(calls, ["https://docs.example.test/api"]);
  assert.equal(contract.source.retrievalMethod, "http");
});

test("formatter, helpers, deterministic ordering, and validation operate on the public contract", async () => {
  const contract = await ingestApiDocumentation(supplied(GRAPHQL_FIXTURE));
  assert.equal(formatProductContractEvidence(contract), contract.textSummary);
  assert.match(contract.textSummary, /PRODUCT CONTRACT/);
  assert.match(contract.textSummary, /Query: getTickets/);
  assert.deepEqual(contract.api.operations, [...contract.api.operations].sort((a, b) => `${a.type}|${a.name}`.localeCompare(`${b.type}|${b.name}`)));
  assert.doesNotThrow(() => validateProductContractEvidence(contract));
  const duplicate: ProductContractEvidence = structuredClone(contract);
  duplicate.api.endpoints.push(structuredClone(duplicate.api.endpoints[0]!));
  assert.throws(() => validateProductContractEvidence(duplicate), /Duplicate contract evidence ID/);
  const invalidProvenance: ProductContractEvidence = structuredClone(contract);
  invalidProvenance.api.operations[0]!.provenance[0]!.sourceUrl = "";
  assert.throws(() => validateProductContractEvidence(invalidProvenance), /Invalid provenance/);
  const unsafe: ProductContractEvidence = structuredClone(contract);
  unsafe.api.operations[0]!.provenance[0]!.sourceText = "Authorization: Bearer leaked-token";
  assert.throws(() => validateProductContractEvidence(unsafe), /Unsafe secret-like value/);
});

function supplied(content: string) {
  return { url: "https://docs.example.test/api", document: { content, contentType: "text" as const,
    finalUrl: "https://docs.example.test/api", title: "Example API", capturedAt: "2026-01-02T03:04:05.000Z",
    retrievalMethod: "supplied" as const } };
}
