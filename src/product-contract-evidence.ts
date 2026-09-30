import { stableHash } from "./runtime-capture.js";

export type ContractApiStyle = "graphql" | "rest" | "unknown";
export type ContractOperationType = "query" | "mutation" | "subscription" | "unknown";
export type ContractRetrievalMethod = "http" | "browser-rendered" | "supplied";

export interface ContractProvenance {
  id: string;
  sourceUrl: string;
  section: string;
  structuralLocation: string;
  sourceText: string;
}

export interface ContractSourceManifest {
  id: string;
  requestedUrl: string;
  finalUrl: string;
  title: string;
  capturedAt: string;
  retrievalMethod: ContractRetrievalMethod;
  status: "complete" | "partial";
}

export interface ContractEndpoint {
  id: string;
  value: string;
  environmentOrRegion?: string;
  provenance: ContractProvenance[];
}

export interface ContractArgument {
  id: string;
  name: string;
  type: string;
  required: boolean | null;
  defaultValue?: string;
  description?: string;
  provenance: ContractProvenance[];
}

export interface ContractOperationVariant {
  id: string;
  arguments: ContractArgument[];
  returnType?: string;
  description?: string;
  provenance: ContractProvenance[];
}

export interface ContractOperation {
  id: string;
  type: ContractOperationType;
  name: string;
  variants: ContractOperationVariant[];
  examples: ContractExample[];
  conflict: boolean;
  provenance: ContractProvenance[];
}

export interface ContractTypeField {
  id: string;
  name: string;
  type: string;
  description?: string;
  provenance: ContractProvenance[];
}

export interface ContractTypeDefinition {
  id: string;
  name: string;
  kind: "object" | "input" | "enum" | "scalar" | "unknown";
  description?: string;
  fields: ContractTypeField[];
  conflict: boolean;
  provenance: ContractProvenance[];
}

export interface ContractAuthenticationRequirement {
  id: string;
  header: string;
  purpose: string;
  scheme?: string;
  provenance: ContractProvenance[];
}

export interface ContractPaginationEvidence {
  id: string;
  fields: Array<{ name: string; type?: string; description?: string; provenance: ContractProvenance[] }>;
  provenance: ContractProvenance[];
}

export interface ContractExample {
  id: string;
  kind: "graphql" | "request" | "response" | "variables" | "unknown";
  value: string;
  provenance: ContractProvenance[];
}

export interface UnresolvedContractEvidence {
  id: string;
  text: string;
  reason: string;
  provenance: ContractProvenance[];
}

export interface ProductContractEvidence {
  id: string;
  source: ContractSourceManifest;
  api: {
    style: ContractApiStyle;
    endpoints: ContractEndpoint[];
    operations: ContractOperation[];
    types: ContractTypeDefinition[];
    authentication: ContractAuthenticationRequirement[];
    pagination: ContractPaginationEvidence[];
    examples: ContractExample[];
  };
  unresolvedEvidence: UnresolvedContractEvidence[];
  provenance: ContractProvenance[];
  summary: {
    endpoints: number;
    queries: number;
    mutations: number;
    subscriptions: number;
    unknownOperations: number;
    types: number;
    authenticationRequirements: number;
    paginationEvidence: number;
    unresolvedEvidence: number;
  };
  textSummary: string;
}

export interface SuppliedDocumentationInput {
  content: string;
  contentType?: "html" | "text";
  finalUrl?: string;
  title?: string;
  capturedAt?: string;
  retrievalMethod?: ContractRetrievalMethod;
}

export interface IngestApiDocumentationInput {
  url: string;
  document?: SuppliedDocumentationInput;
  fetch?: typeof globalThis.fetch;
}

interface RawOperation {
  type: ContractOperationType;
  name: string;
  returnType?: string;
  description?: string;
  arguments: Array<{ name: string; type: string; description?: string; defaultValue?: string }>;
  examples: Array<{ kind: ContractExample["kind"]; value: string }>;
  section: string;
  location: string;
  sourceText: string;
}

interface RawType {
  name: string;
  kind: ContractTypeDefinition["kind"];
  description?: string;
  fields: Array<{ name: string; type: string; description?: string }>;
  section: string;
  location: string;
  sourceText: string;
}

export async function ingestApiDocumentation(input: IngestApiDocumentationInput): Promise<ProductContractEvidence> {
  const requested = validateDocumentationUrl(input.url);
  const retrieved = input.document ? {
    content: input.document.content,
    contentType: input.document.contentType ?? detectContentType(input.document.content),
    finalUrl: input.document.finalUrl ?? requested.href,
    title: input.document.title ?? extractTitle(input.document.content),
    capturedAt: input.document.capturedAt ?? new Date().toISOString(),
    retrievalMethod: input.document.retrievalMethod ?? "supplied" as const,
    status: "complete" as const,
  } : await retrieveDocumentation(requested, input.fetch ?? globalThis.fetch);
  const source: ContractSourceManifest = {
    id: `contract-source:${stableHash(`${requested.href}|${retrieved.finalUrl}|${normalizeText(retrieved.title)}`)}`,
    requestedUrl: requested.href,
    finalUrl: retrieved.finalUrl,
    title: retrieved.title,
    capturedAt: retrieved.capturedAt,
    retrievalMethod: retrieved.retrievalMethod,
    status: retrieved.status,
  };
  const parsed = retrieved.contentType === "html"
    ? parseHtmlDocumentation(retrieved.content, source.finalUrl)
    : parseTextDocumentation(retrieved.content, source.finalUrl);
  const style = detectStyle(retrieved.content, parsed.operations);
  const endpoints = buildEndpoints(parsed.endpoints, source.finalUrl);
  const operations = buildOperations(parsed.operations, source.finalUrl);
  const types = buildTypes(parsed.types, source.finalUrl);
  const authentication = buildAuthentication(parsed.authentication, source.finalUrl);
  const pagination = buildPagination(types, parsed.pagination, source.finalUrl);
  const examples = uniqueBy(operations.flatMap((operation) => operation.examples), (item) => item.id).sort(compareId);
  const provenance = uniqueBy([
    ...endpoints.flatMap((item) => item.provenance), ...operations.flatMap((item) => item.provenance),
    ...operations.flatMap((item) => item.variants.flatMap((variant) => [...variant.provenance,
      ...variant.arguments.flatMap((argument) => argument.provenance)])),
    ...operations.flatMap((item) => item.examples.flatMap((example) => example.provenance)),
    ...types.flatMap((item) => [...item.provenance, ...item.fields.flatMap((field) => field.provenance)]),
    ...authentication.flatMap((item) => item.provenance), ...pagination.flatMap((item) =>
      [...item.provenance, ...item.fields.flatMap((field) => field.provenance)]),
  ], (item) => item.id).sort(compareId);
  const unresolvedEvidence = parsed.unresolved.map((item) => {
    const evidence = provenanceFor(source.finalUrl, item.section, item.location, item.text);
    return { id: `contract-unresolved:${stableHash(`${item.reason}|${evidence.id}`)}`, text: normalizeText(item.text),
      reason: item.reason, provenance: [evidence] };
  }).sort(compareId);
  const contract: ProductContractEvidence = {
    id: `product-contract:${stableHash(JSON.stringify({ source: source.id, style, endpoints: endpoints.map((item) => item.id),
      operations: operations.map((item) => item.id), types: types.map((item) => item.id) }))}`,
    source, api: { style, endpoints, operations, types, authentication, pagination, examples },
    unresolvedEvidence, provenance, summary: summarize(style, endpoints, operations, types, authentication, pagination, unresolvedEvidence),
    textSummary: "",
  };
  contract.textSummary = formatProductContractEvidence(contract);
  validateProductContractEvidence(contract);
  return contract;
}

async function retrieveDocumentation(url: URL, fetcher: typeof globalThis.fetch) {
  const response = await fetcher(url, { redirect: "follow", headers: { accept: "text/html,text/plain;q=0.9" } });
  if (!response.ok) throw new Error(`Documentation retrieval failed with HTTP ${response.status}`);
  const finalUrl = validateDocumentationUrl(response.url || url.href).href;
  const content = await response.text();
  const contentType = response.headers.get("content-type")?.includes("html") ? "html" as const : detectContentType(content);
  return { content, contentType, finalUrl, title: extractTitle(content), capturedAt: new Date().toISOString(),
    retrievalMethod: "http" as const, status: content.trim() ? "complete" as const : "partial" as const };
}

function parseHtmlDocumentation(html: string, sourceUrl: string) {
  const operations: RawOperation[] = [];
  const types: RawType[] = [];
  for (const match of html.matchAll(/<section\b[^>]*\bid=["'](query|mutation|subscription)-([^"']+)["'][^>]*>([\s\S]*?)<\/section>/gi)) {
    const type = match[1]!.toLowerCase() as ContractOperationType;
    const body = match[3]!;
    const name = textOf(first(body, /<h2\b[^>]*class=["'][^"']*operation-heading[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i)) || decodeEntities(match[2]!);
    const returnType = textOf(first(body, /operation-response[\s\S]*?<code>([\s\S]*?)<\/code>/i)) || undefined;
    const description = sectionDescription(body, "operation-description");
    const arguments_ = propertyRows(first(body, /operation-arguments[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i));
    const examples = [...body.matchAll(/<div\b[^>]*class=["'][^"']*operation-(query|mutation|subscription|variables|response)-example[^"']*["'][^>]*>[\s\S]*?<code\b[^>]*>([\s\S]*?)<\/code>/gi)]
      .map((item) => ({ kind: exampleKind(item[1]!), value: sanitizeExample(textOf(item[2]!)) })).filter((item) => item.value);
    operations.push({ type, name, ...(returnType ? { returnType } : {}), ...(description ? { description } : {}),
      arguments: arguments_, examples, section: `${capitalize(type)} ${name}`, location: `#${type}-${match[2]!}`,
      sourceText: normalizeText(textOf(body).slice(0, 1000)) });
  }
  for (const match of html.matchAll(/<section\b[^>]*\bid=["']definition-([^"']+)["'][^>]*class=["'][^"']*definition(?:-([a-z]+))?[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi)) {
    const body = match[3]!; const name = textOf(first(body, /<h2\b[^>]*class=["'][^"']*definition-heading[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i)) || decodeEntities(match[1]!);
    const rawKind = match[2]?.toLowerCase();
    const kind: ContractTypeDefinition["kind"] = rawKind === "object" || rawKind === "input" || rawKind === "enum" || rawKind === "scalar"
      ? rawKind : "unknown";
    const fieldsBody = first(body, /definition-(?:properties|values)[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i);
    const description = sectionDescription(body, "definition-description");
    types.push({ name, kind, ...(description ? { description } : {}), fields: propertyRows(fieldsBody),
      section: `Type ${name}`, location: `#definition-${match[1]!}`, sourceText: normalizeText(textOf(body).slice(0, 1000)) });
  }
  const endpoints = extractEndpoints(textOf(html));
  const authentication = extractAuthentication(textOf(html));
  const pagination = extractPagination(textOf(html));
  const unresolved = operations.length === 0 && /\b(api|query|mutation|endpoint)\b/i.test(textOf(html))
    ? [{ text: textOf(html).slice(0, 500), reason: "api-related-content-not-structurally-classified", section: "Document", location: "article" }] : [];
  void sourceUrl;
  return { operations, types, endpoints, authentication, pagination, unresolved };
}

function parseTextDocumentation(text: string, sourceUrl: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const operations: RawOperation[] = [];
  const types: RawType[] = [];
  let operationType: ContractOperationType = "unknown";
  for (let index = 0; index < lines.length; index++) {
    const heading = /^(Query|Mutation|Subscription)\s*:?[\s]*$/i.exec(lines[index]!);
    if (heading) { operationType = heading[1]!.toLowerCase() as ContractOperationType; continue; }
    const inline = /^(?:(Query|Mutation|Subscription)\s+)?([_A-Za-z][_0-9A-Za-z]*)\s*\(([^)]*)\)\s*:\s*([^\s]+)(?:\s+-\s+(.+))?$/i.exec(lines[index]!);
    if (inline && (inline[1] || operationType !== "unknown")) {
      const type = (inline[1]?.toLowerCase() ?? operationType) as ContractOperationType;
      operations.push({ type, name: inline[2]!, arguments: parseArguments(inline[3]!), returnType: inline[4]!,
        ...(inline[5] ? { description: normalizeText(inline[5]) } : {}), examples: [], section: `${capitalize(type)} ${inline[2]!}`,
        location: `line:${index + 1}`, sourceText: lines[index]! });
    }
  }
  for (let index = 0; index < lines.length; index++) {
    const heading = /^Type\s+([_A-Za-z][_0-9A-Za-z]*)(?:\s+-\s+(.+))?$/i.exec(lines[index]!);
    if (!heading) continue;
    const fields: RawType["fields"] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const field = /^([_A-Za-z][_0-9A-Za-z]*)\s*:\s*([^\s]+)(?:\s+-\s+(.+))?$/.exec(lines[cursor]!);
      if (!field) break;
      fields.push({ name: field[1]!, type: field[2]!, ...(field[3] ? { description: normalizeText(field[3]) } : {}) });
    }
    types.push({ name: heading[1]!, kind: "object", ...(heading[2] ? { description: normalizeText(heading[2]) } : {}), fields,
      section: `Type ${heading[1]!}`, location: `line:${index + 1}`, sourceText: lines.slice(index, index + fields.length + 1).join("\n") });
  }
  const graphqlExamples = [...text.matchAll(/```(?:graphql|gql)\s*([\s\S]*?)```/gi)].map((match, index) => ({
    kind: "graphql" as const, value: sanitizeExample(match[1]!), section: "Example", location: `graphql-example:${index + 1}` }));
  for (const example of graphqlExamples) {
    const operation = operations.find((item) => new RegExp(`\\b${escapeRegex(item.name)}\\b`).test(example.value));
    if (operation) operation.examples.push({ kind: example.kind, value: example.value });
  }
  const endpoints = extractEndpoints(text);
  const authentication = extractAuthentication(text);
  const pagination = extractPagination(text);
  const rest = lines.filter((line) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S+/i.test(line));
  for (const line of rest) {
    const match = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S+)/i.exec(line)!;
    operations.push({ type: "unknown", name: `${match[1]!.toUpperCase()} ${match[2]!}`, arguments: [], examples: [],
      section: "REST Operations", location: `rest:${match[1]!.toUpperCase()}:${match[2]!}`, sourceText: line });
  }
  const unresolved = operations.length === 0 && rest.length === 0 && /\b(api|endpoint|operation)\b/i.test(text)
    ? [{ text: text.slice(0, 500), reason: "api-related-content-not-structurally-classified", section: "Document", location: "text" }] : [];
  void sourceUrl;
  return { operations, types, endpoints, authentication, pagination, unresolved };
}

function buildEndpoints(raw: Array<{ value: string; environmentOrRegion?: string; text: string }>, sourceUrl: string): ContractEndpoint[] {
  const grouped = groupBy(raw, (item) => `${item.value}|${item.environmentOrRegion ?? ""}`);
  return [...grouped.entries()].map(([key, items]) => {
    const item = items[0]!; const provenance = items.map((value, index) =>
      provenanceFor(sourceUrl, "API Endpoints", `endpoint:${index + 1}:${stableHash(key)}`, value.text));
    return { id: `contract-endpoint:${stableHash(key)}`, value: item.value,
      ...(item.environmentOrRegion ? { environmentOrRegion: item.environmentOrRegion } : {}), provenance: uniqueBy(provenance, (value) => value.id) };
  }).sort((a, b) => `${a.value}|${a.environmentOrRegion ?? ""}`.localeCompare(`${b.value}|${b.environmentOrRegion ?? ""}`));
}

function buildOperations(raw: RawOperation[], sourceUrl: string): ContractOperation[] {
  const grouped = groupBy(raw, (item) => `${item.type}|${item.name}`);
  return [...grouped.entries()].map(([key, definitions]) => {
    const variantsBySignature = groupBy(definitions, (item) => JSON.stringify({ returnType: item.returnType ?? "",
      arguments: item.arguments.map((argument) => [argument.name, argument.type, argument.defaultValue ?? ""]) }));
    const variants = [...variantsBySignature.entries()].map(([signature, items]) => {
      const firstItem = items[0]!; const provenance = items.map((item) => provenanceFor(sourceUrl, item.section, item.location, item.sourceText));
      const arguments_ = firstItem.arguments.map((argument) => ({ id: `contract-argument:${stableHash(`${key}|${signature}|${argument.name}`)}`,
        name: argument.name, type: argument.type, required: argument.type.endsWith("!") ? true : false,
        ...(argument.defaultValue ? { defaultValue: redactSensitiveValue(argument.defaultValue) } : {}),
        ...(argument.description ? { description: argument.description } : {}), provenance }));
      return { id: `contract-operation-variant:${stableHash(`${key}|${signature}`)}`, arguments: arguments_.sort(compareName),
        ...(firstItem.returnType ? { returnType: firstItem.returnType } : {}),
        ...(firstItem.description ? { description: firstItem.description } : {}), provenance };
    }).sort(compareId);
    const provenance = uniqueBy(variants.flatMap((item) => item.provenance), (item) => item.id).sort(compareId);
    const examples = definitions.flatMap((item) => item.examples.map((example, index) => makeExample(sourceUrl, item.section,
      `${item.location}:example:${index + 1}`, example.kind, example.value))).filter((item) => item.value);
    return { id: `contract-operation:${stableHash(key)}`, type: definitions[0]!.type, name: definitions[0]!.name,
      variants, examples: uniqueBy(examples, (item) => item.id).sort(compareId), conflict: variants.length > 1, provenance };
  }).sort((a, b) => `${a.type}|${a.name}`.localeCompare(`${b.type}|${b.name}`));
}

function buildTypes(raw: RawType[], sourceUrl: string): ContractTypeDefinition[] {
  const grouped = groupBy(raw, (item) => item.name);
  return [...grouped.entries()].map(([name, definitions]) => {
    const signatures = new Set(definitions.map((item) => JSON.stringify(item.fields.map((field) => [field.name, field.type]))));
    const provenance = definitions.map((item) => provenanceFor(sourceUrl, item.section, item.location, item.sourceText));
    const fields = uniqueBy(definitions.flatMap((item) => item.fields.map((field) => ({
      id: `contract-field:${stableHash(`${name}|${field.name}|${field.type}`)}`, name: field.name, type: field.type,
      ...(field.description ? { description: field.description } : {}), provenance: [provenanceFor(sourceUrl, item.section,
        `${item.location}:field:${field.name}`, `${field.name}: ${field.type}${field.description ? ` ${field.description}` : ""}`)] }))),
    (item) => item.id).sort(compareName);
    return { id: `contract-type:${stableHash(name)}`, name, kind: definitions[0]!.kind,
      ...(definitions[0]!.description ? { description: definitions[0]!.description } : {}), fields,
      conflict: signatures.size > 1, provenance: uniqueBy(provenance, (item) => item.id) };
  }).sort(compareName);
}

function buildAuthentication(raw: Array<{ header: string; purpose: string; scheme?: string; text: string }>, sourceUrl: string) {
  return uniqueBy(raw.map((item) => ({ id: `contract-auth:${stableHash(item.header.toLowerCase())}`, header: item.header,
    purpose: normalizeText(item.purpose), ...(item.scheme ? { scheme: item.scheme } : {}),
    provenance: [provenanceFor(sourceUrl, "Authentication", `header:${item.header}`, redactSensitiveExample(item.text))] })),
  (item) => item.id).sort((a, b) => a.header.localeCompare(b.header));
}

function buildPagination(types: ContractTypeDefinition[], raw: string[], sourceUrl: string): ContractPaginationEvidence[] {
  const explicit = types.filter((item) => /pagination|listinfo/i.test(`${item.name} ${item.description ?? ""} ${item.fields.map((field) => field.description ?? "").join(" ")}`));
  if (explicit.length === 0 && raw.length === 0) return [];
  const fields = uniqueBy(explicit.flatMap((item) => item.fields.filter((field) =>
    /page|limit|cursor|offset|hasmore|totalcount/i.test(field.name)).map((field) => ({ name: field.name, type: field.type,
      ...(field.description ? { description: field.description } : {}), provenance: field.provenance }))), (item) => item.name);
  const provenance = uniqueBy([...explicit.flatMap((item) => item.provenance), ...raw.map((text, index) =>
    provenanceFor(sourceUrl, "Pagination", `pagination:${index + 1}`, text))], (item) => item.id);
  return [{ id: `contract-pagination:${stableHash(fields.map((item) => item.name).sort().join("|"))}`, fields: fields.sort(compareName), provenance }];
}

export function validateProductContractEvidence(contract: ProductContractEvidence): void {
  const allIds = [contract.source.id, ...contract.api.endpoints.map((item) => item.id), ...contract.api.operations.map((item) => item.id),
    ...contract.api.operations.flatMap((item) => item.variants.flatMap((variant) => [variant.id, ...variant.arguments.map((argument) => argument.id)])),
    ...contract.api.types.flatMap((item) => [item.id, ...item.fields.map((field) => field.id)]),
    ...contract.api.authentication.map((item) => item.id), ...contract.api.pagination.map((item) => item.id),
    ...contract.api.examples.map((item) => item.id), ...contract.unresolvedEvidence.map((item) => item.id)];
  if (new Set(allIds).size !== allIds.length) throw new Error("Duplicate contract evidence ID");
  const provenanceIds = new Set(contract.provenance.map((item) => item.id));
  const references = [
    ...contract.api.endpoints.flatMap((item) => item.provenance), ...contract.api.operations.flatMap((item) => [
      ...item.provenance, ...item.variants.flatMap((variant) => [...variant.provenance, ...variant.arguments.flatMap((argument) => argument.provenance)]),
      ...item.examples.flatMap((example) => example.provenance)]),
    ...contract.api.types.flatMap((item) => [...item.provenance, ...item.fields.flatMap((field) => field.provenance)]),
    ...contract.api.authentication.flatMap((item) => item.provenance), ...contract.api.pagination.flatMap((item) =>
      [...item.provenance, ...item.fields.flatMap((field) => field.provenance)]), ...contract.unresolvedEvidence.flatMap((item) => item.provenance),
  ];
  for (const item of references) {
    if (!item.sourceUrl || !item.section || !item.structuralLocation || !item.sourceText) throw new Error(`Invalid provenance ${item.id}`);
    if (!provenanceIds.has(item.id) && !contract.unresolvedEvidence.some((entry) => entry.provenance.some((value) => value.id === item.id))) {
      throw new Error(`Missing provenance reference ${item.id}`);
    }
    if (containsUnsafeSecret(item.sourceText)) throw new Error(`Unsafe secret-like value in provenance ${item.id}`);
  }
  for (const operation of contract.api.operations) if (!["query", "mutation", "subscription", "unknown"].includes(operation.type)) {
    throw new Error(`Invalid operation type ${operation.type}`);
  }
  for (const endpoint of contract.api.endpoints) validateDocumentationUrl(endpoint.value);
  if (contract.api.style === "unknown" && contract.api.operations.length > 0) throw new Error("Unknown API style has structured operations");
}

export function getContractOperation(contract: ProductContractEvidence, name: string,
  type?: ContractOperationType): ContractOperation | undefined {
  return contract.api.operations.find((item) => item.name === name && (!type || item.type === type));
}
export function getContractOperationsByType(contract: ProductContractEvidence, type: ContractOperationType): ContractOperation[] {
  return contract.api.operations.filter((item) => item.type === type);
}
export function getContractType(contract: ProductContractEvidence, name: string): ContractTypeDefinition | undefined {
  return contract.api.types.find((item) => item.name === name);
}
export function getContractEndpoints(contract: ProductContractEvidence): ContractEndpoint[] { return [...contract.api.endpoints]; }

export function formatProductContractEvidence(contract: ProductContractEvidence): string {
  const lines = ["PRODUCT CONTRACT", "", "SOURCE", contract.source.finalUrl, contract.source.title, contract.source.retrievalMethod,
    "", "API STYLE", contract.api.style.toUpperCase(), "", "ENDPOINTS"];
  lines.push(...(contract.api.endpoints.length ? contract.api.endpoints.map((item) =>
    `${item.environmentOrRegion ? `${item.environmentOrRegion} ` : ""}${item.value}`) : ["none"]));
  lines.push("", "AUTHENTICATION", ...(contract.api.authentication.length ? contract.api.authentication.map((item) =>
    `${item.header}${item.scheme ? ` (${item.scheme})` : ""}: ${item.purpose}`) : ["none"]), "", "OPERATIONS");
  lines.push(...(contract.api.operations.length ? contract.api.operations.map((item) => `${capitalize(item.type)}: ${item.name}`) : ["none"]));
  lines.push("", "TYPES", `${contract.api.types.length}`, "", "PAGINATION", contract.api.pagination.length ? "documented" : "none",
    "", "UNRESOLVED", `${contract.unresolvedEvidence.length}`);
  return lines.join("\n");
}

function extractEndpoints(text: string): Array<{ value: string; environmentOrRegion?: string; text: string }> {
  const output = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>'"`]+/g)) {
    const value = match[0]!.replace(/[),.;]+$/, "");
    const context = text.slice(Math.max(0, match.index! - 120), Math.min(text.length, match.index! + value.length + 80));
    if (!/\b(api|endpoint|graphql)\b/i.test(context)) continue;
    const preceding = text.slice(Math.max(0, match.index! - 100), match.index!);
    const regions = [...preceding.matchAll(/\b(US|EU|UK|AU|APAC|EMEA)\b/gi)];
    const region = regions.at(-1)?.[1]?.toUpperCase();
    output.push({ value, ...(region ? { environmentOrRegion: region } : {}), text: normalizeText(context) });
  }
  return output;
}

function extractAuthentication(text: string): Array<{ header: string; purpose: string; scheme?: string; text: string }> {
  const output = [];
  for (const match of text.matchAll(/\b(Authorization|Content-Type|CustomerSubDomain|X-[A-Za-z0-9-]+)\b\s*:\s*([^\n]{0,100})/gi)) {
    const context = normalizeText(match[0]!); if (!/auth|bearer|token|json|header|subdomain/i.test(context)) continue;
    const scheme = /\bBearer\b/i.test(context) ? "Bearer" : undefined;
    output.push({ header: canonicalHeader(match[1]!), purpose: redactSensitiveExample(context), ...(scheme ? { scheme } : {}), text: context });
  }
  return output;
}

function extractPagination(text: string): string[] {
  return [...text.matchAll(/[^.\n]{0,100}\bpagination\b[^.\n]{0,160}/gi)].map((match) => normalizeText(match[0]!));
}

function propertyRows(body: string): Array<{ name: string; type: string; description?: string }> {
  const output = [];
  for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const value = row[1]!; const name = textOf(first(value, /property-name[\s\S]*?<code>([\s\S]*?)<\/code>/i));
    const type = textOf(first(value, /property-type[\s\S]*?<code>([\s\S]*?)<\/code>/i));
    const cells = [...value.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
    const description = cells[1] ? normalizeText(textOf(cells[1][1]!)) : "";
    if (name && type) output.push({ name, type, ...(description ? { description } : {}) });
  }
  return output;
}

function parseArguments(value: string): Array<{ name: string; type: string; defaultValue?: string }> {
  if (!value.trim()) return [];
  return value.split(",").flatMap((part) => {
    const match = /^\s*([_A-Za-z][_0-9A-Za-z]*)\s*:\s*([^=\s]+)(?:\s*=\s*(.+))?\s*$/.exec(part);
    return match ? [{ name: match[1]!, type: match[2]!, ...(match[3] ? { defaultValue: match[3].trim() } : {}) }] : [];
  });
}

function sectionDescription(body: string, className: string): string | undefined {
  const value = normalizeText(textOf(first(body, new RegExp(`${className}[\\s\\S]*?<p[^>]*>([\\s\\S]*?)<\\/p>`, "i"))));
  return value || undefined;
}
function detectStyle(content: string, operations: RawOperation[]): ContractApiStyle {
  if (operations.some((item) => item.type !== "unknown") || /\bGraphQL\b/i.test(textOf(content))) return "graphql";
  return /(?:^|\n)\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S+/im.test(content) ? "rest" : "unknown";
}
function makeExample(url: string, section: string, location: string, kind: ContractExample["kind"], value: string): ContractExample {
  const safe = sanitizeExample(value); const provenance = provenanceFor(url, section, location, safe);
  return { id: `contract-example:${stableHash(`${kind}|${safe}|${location}`)}`, kind, value: safe, provenance: [provenance] };
}
function provenanceFor(sourceUrl: string, section: string, structuralLocation: string, sourceText: string): ContractProvenance {
  const safeText = redactSensitiveExample(normalizeText(sourceText));
  return { id: `contract-provenance:${stableHash(`${sourceUrl}|${section}|${structuralLocation}|${safeText}`)}`,
    sourceUrl, section: section || "Document", structuralLocation, sourceText: safeText };
}
function sanitizeExample(value: string): string { return redactSensitiveExample(value.replace(/\r\n/g, "\n").trim()); }
function redactSensitiveExample(value: string): string {
  return value
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s,"'}]+/gi, "$1[REDACTED]")
    .replace(/(Authorization\s*[:=]\s*)(?!Bearer\b)[^\s,"'}]+/gi, "$1[REDACTED]")
    .replace(/(["']?(?:token|api[_-]?key|password|secret)["']?\s*[:=]\s*["'])[^"']+(["'])/gi, "$1[REDACTED]$2");
}
function redactSensitiveValue(value: string): string { return /token|secret|password|bearer|api[_-]?key/i.test(value) ? "[REDACTED]" : value; }
function containsUnsafeSecret(value: string): boolean {
  const bearer = /Authorization\s*[:=]\s*Bearer\s+(\S+)/i.exec(value);
  if (bearer && bearer[1] !== "[REDACTED]") return true;
  const direct = /Authorization\s*[:=]\s*(\S+)/i.exec(value);
  if (direct && direct[1]?.toLowerCase() !== "bearer" && direct[1] !== "[REDACTED]") return true;
  return /(?:token|api[_-]?key|password|secret)["']?\s*[:=]\s*["'](?!\[REDACTED\])[^"']+/i.test(value);
}
function summarize(_style: ContractApiStyle, endpoints: ContractEndpoint[], operations: ContractOperation[], types: ContractTypeDefinition[],
  authentication: ContractAuthenticationRequirement[], pagination: ContractPaginationEvidence[], unresolved: UnresolvedContractEvidence[]) {
  return { endpoints: endpoints.length, queries: operations.filter((item) => item.type === "query").length,
    mutations: operations.filter((item) => item.type === "mutation").length,
    subscriptions: operations.filter((item) => item.type === "subscription").length,
    unknownOperations: operations.filter((item) => item.type === "unknown").length, types: types.length,
    authenticationRequirements: authentication.length, paginationEvidence: pagination.length, unresolvedEvidence: unresolved.length };
}
function validateDocumentationUrl(value: string): URL { const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Documentation URL must use HTTP or HTTPS"); return url; }
function extractTitle(value: string): string { return textOf(first(value, /<title\b[^>]*>([\s\S]*?)<\/title>/i)) || "API Documentation"; }
function detectContentType(value: string): "html" | "text" { return /<html\b|<section\b|<article\b/i.test(value) ? "html" : "text"; }
function textOf(value: string): string { return normalizeText(decodeEntities(value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, " "))); }
function decodeEntities(value: string): string { return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code))); }
function normalizeText(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function first(value: string, expression: RegExp): string { return expression.exec(value)?.[1] ?? ""; }
function canonicalHeader(value: string): string { return value.toLowerCase() === "authorization" ? "Authorization" :
  value.toLowerCase() === "content-type" ? "Content-Type" : value.toLowerCase() === "customersubdomain" ? "CustomerSubDomain" : value; }
function exampleKind(value: string): ContractExample["kind"] { return value === "query" || value === "mutation" || value === "subscription"
  ? "graphql" : value === "variables" ? "variables" : value === "response" ? "response" : "unknown"; }
function capitalize(value: string): string { return value ? value[0]!.toUpperCase() + value.slice(1) : value; }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function compareId<T extends { id: string }>(a: T, b: T): number { return a.id.localeCompare(b.id); }
function compareName<T extends { name: string }>(a: T, b: T): number { return a.name.localeCompare(b.name); }
function uniqueBy<T>(items: T[], key: (item: T) => string): T[] { const seen = new Set<string>(); return items.filter((item) => {
  const value = key(item); if (seen.has(value)) return false; seen.add(value); return true; }); }
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> { const result = new Map<string, T[]>();
  for (const item of items) result.set(key(item), [...(result.get(key(item)) ?? []), item]); return result; }
