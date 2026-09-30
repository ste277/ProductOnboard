import { stableHash } from "./runtime-capture.js";
import type { ProductEvidenceGraph, ProductEvidenceNode } from "./product-evidence-graph.js";
import type { RuntimeNavigationDiscoveryGraph } from "./runtime-discovery.js";
import type { ReconciliationManifest, ReconciliationRuntimeReference } from "./evidence-reconciliation.js";
import type { FeatureModel } from "./feature-model.js";
import type {
  ContractEndpoint,
  ContractOperation,
  ContractOperationType,
  ContractTypeDefinition,
  ProductContractEvidence,
} from "./product-contract-evidence.js";

export type ContractReconciliationStatus = "corroborated" | "contract-only" | "product-only" | "ambiguous" | "conflicting";
export type ContractReconciliationStrength = "exact" | "strong" | "supporting";
export type ContractReconciliationDomain = "operation" | "endpoint" | "type";
export type ContractComparisonDimension =
  | "operation-name" | "operation-type" | "argument-name" | "argument-presence" | "argument-type"
  | "argument-requiredness" | "argument-default" | "return-type" | "endpoint" | "field-name" | "field-type";

export interface ContractEvidenceReference {
  operationId?: string;
  operationVariantId?: string;
  endpointId?: string;
  typeId?: string;
  fieldId?: string;
}

export interface ProductEvidenceReference {
  nodeId?: string;
  runtimeStateId?: string;
  runtimeTransitionId?: string;
  networkObservationId?: string;
  productReconciliationId?: string;
  runtimeMethod?: string;
}

export interface ContractDimensionResult {
  dimension: ContractComparisonDimension;
  status: "match" | "conflict" | "insufficient";
  key?: string;
  contractValue?: string;
  productValue?: string;
  reason: string;
}

export interface ContractReconciliationResult {
  id: string;
  domain: ContractReconciliationDomain;
  subject: string;
  sortKey: string;
  status: ContractReconciliationStatus;
  strength?: ContractReconciliationStrength;
  contract: ContractEvidenceReference[];
  product: ProductEvidenceReference[];
  dimensions: ContractDimensionResult[];
  reasons: string[];
}

export interface ContractFeatureLink {
  id: string;
  featureId: string;
  staticGraphqlNodeId: string;
  contractOperationId: string;
  reconciliationResultId: string;
  reason: "feature-static-operation-link";
}

export interface ContractReconciliationCoverage {
  contract: { sourceUrl: string; retrievalStatus: string; apiStyle: string; operations: number; endpoints: number; types: number };
  product: { staticGraphqlOperations: number; staticEndpoints: number; runtimeEndpoints: number; featuresWithGraphql: number };
  compared: { operations: number; endpoints: number; types: number };
  runtime: ReconciliationManifest["coverage"];
}

export interface ContractReconciliationSummary {
  total: Record<ContractReconciliationStatus, number>;
  byDomain: Record<ContractReconciliationDomain, Record<ContractReconciliationStatus, number>>;
  featureLinks: number;
}

export interface ContractReconciliationManifest {
  id: string;
  sources: {
    contractEvidenceId: string;
    staticGraphId: string;
    runtimeDiscoveryId: string;
    productReconciliationId: string;
    featureModelId: string;
  };
  operations: ContractReconciliationResult[];
  endpoints: ContractReconciliationResult[];
  types: ContractReconciliationResult[];
  featureLinks: ContractFeatureLink[];
  contractOnly: ContractReconciliationResult[];
  productOnly: ContractReconciliationResult[];
  ambiguous: ContractReconciliationResult[];
  conflicting: ContractReconciliationResult[];
  coverage: ContractReconciliationCoverage;
  summary: ContractReconciliationSummary;
  textSummary: string;
}

export interface ReconcileProductContractInput {
  contract: ProductContractEvidence;
  staticGraph: ProductEvidenceGraph;
  runtimeDiscovery: RuntimeNavigationDiscoveryGraph;
  productReconciliation: ReconciliationManifest;
  featureModel: FeatureModel;
}

interface StaticOperation {
  node: ProductEvidenceNode;
  name: string;
  type: ContractOperationType;
  variables?: Array<{ name: string; type: string; required?: boolean; defaultValue?: string }>;
  returnType?: string;
}

interface StaticEndpoint {
  node: ProductEvidenceNode;
  value: string;
}

interface RuntimeEndpoint {
  value: string;
  method: string;
  reference: ProductEvidenceReference;
}

interface StaticSchemaType {
  node: ProductEvidenceNode;
  name: string;
  fields: Array<{ name: string; type: string }>;
}

export function reconcileProductContract(input: ReconcileProductContractInput): ContractReconciliationManifest {
  assertInputSources(input);
  const staticOperations = readStaticOperations(input.staticGraph);
  const staticEndpoints = readStaticEndpoints(input.staticGraph);
  const runtimeEndpoints = readRuntimeEndpoints(input.runtimeDiscovery, input.productReconciliation);
  const operations = attachOperationTransport(reconcileOperations(input.contract.api.operations, staticOperations),
    input.staticGraph, input.runtimeDiscovery, input.productReconciliation);
  const endpoints = reconcileEndpoints(input.contract.api.endpoints, staticEndpoints, runtimeEndpoints,
    input.runtimeDiscovery, input.productReconciliation);
  const types = reconcileTypes(input.contract.api.types, readStaticTypes(input.staticGraph));
  const featureLinks = linkFeatures(operations, input.featureModel);
  const all = [...operations, ...endpoints, ...types].sort(compareResult);
  const manifest: ContractReconciliationManifest = {
    id: `contract-reconciliation:${stableHash(JSON.stringify({ contract: input.contract.id,
      reconciliation: input.productReconciliation.id, features: input.featureModel.id,
      results: all.map((item) => item.id) }))}`,
    sources: { contractEvidenceId: input.contract.id, staticGraphId: input.productReconciliation.staticGraphId,
      runtimeDiscoveryId: input.productReconciliation.runtimeDiscoveryId,
      productReconciliationId: input.productReconciliation.id, featureModelId: input.featureModel.id },
    operations, endpoints, types, featureLinks,
    contractOnly: all.filter((item) => item.status === "contract-only"),
    productOnly: all.filter((item) => item.status === "product-only"),
    ambiguous: all.filter((item) => item.status === "ambiguous"),
    conflicting: all.filter((item) => item.status === "conflicting"),
    coverage: buildCoverage(input, staticOperations, staticEndpoints, runtimeEndpoints, operations, endpoints, types),
    summary: summarize(all, featureLinks), textSummary: "",
  };
  manifest.textSummary = formatContractReconciliation(manifest, input.contract, input.staticGraph, input.featureModel);
  validateContractReconciliation(manifest, input);
  return manifest;
}

function reconcileOperations(contractOperations: ContractOperation[], staticOperations: StaticOperation[]): ContractReconciliationResult[] {
  const results: ContractReconciliationResult[] = [];
  const consumed = new Set<string>();
  for (const contract of contractOperations.filter((item) => item.type !== "unknown")) {
    const exact = staticOperations.filter((item) => item.name === contract.name && item.type === contract.type);
    const sameName = staticOperations.filter((item) => item.name === contract.name);
    if (exact.length > 1) {
      exact.forEach((item) => consumed.add(item.node.id));
      results.push(makeResult("operation", `${contract.type} ${contract.name}`, `operation|${contract.type}|${contract.name}`,
        "ambiguous", [{ operationId: contract.id }], exact.map((item) => ({ nodeId: item.node.id })), [],
        ["operation-name-exact", "operation-type-match", "multiple-static-operation-candidates"], "strong"));
      continue;
    }
    if (exact.length === 0 && sameName.length > 0) {
      sameName.forEach((item) => consumed.add(item.node.id));
      const dimensions = sameName.map((item) => dimension("operation-type", "conflict", undefined, contract.type, item.type,
        "operation-type-conflict"));
      results.push(makeResult("operation", `${contract.type} ${contract.name}`, `operation|${contract.type}|${contract.name}`,
        sameName.length === 1 ? "conflicting" : "ambiguous", [{ operationId: contract.id }],
        sameName.map((item) => ({ nodeId: item.node.id })), dimensions,
        ["operation-name-exact", sameName.length === 1 ? "operation-type-conflict" : "multiple-static-operation-candidates"], "exact"));
      continue;
    }
    if (exact.length === 0) {
      results.push(makeResult("operation", `${contract.type} ${contract.name}`, `operation|${contract.type}|${contract.name}`,
        "contract-only", [{ operationId: contract.id }], [], [], ["no-static-operation-match"]));
      continue;
    }
    const product = exact[0]!; consumed.add(product.node.id);
    const dimensions = compareSignature(contract, product);
    const conflict = dimensions.some((item) => item.status === "conflict");
    results.push(makeResult("operation", `${contract.type} ${contract.name}`, `operation|${contract.type}|${contract.name}`,
      conflict ? "conflicting" : "corroborated", [{ operationId: contract.id,
        ...(contract.variants[0] ? { operationVariantId: contract.variants[0].id } : {}) }], [{ nodeId: product.node.id }],
      dimensions, unique(["operation-name-exact", "operation-type-match", ...dimensions.map((item) => item.reason)]), "exact"));
  }
  for (const product of staticOperations.filter((item) => !consumed.has(item.node.id))) {
    results.push(makeResult("operation", `${product.type} ${product.name}`, `operation|${product.type}|${product.name}`,
      "product-only", [], [{ nodeId: product.node.id }], [], ["no-contract-operation-match"]));
  }
  return results.sort(compareResult);
}

function compareSignature(contract: ContractOperation, product: StaticOperation): ContractDimensionResult[] {
  const dimensions = [dimension("operation-name", "match", undefined, contract.name, product.name, "operation-name-exact"),
    dimension("operation-type", "match", undefined, contract.type, product.type, "operation-type-match")];
  if (contract.variants.length !== 1) {
    dimensions.push(dimension("argument-presence", "insufficient", undefined, undefined, undefined,
      "ambiguous-contract-signature-evidence"));
    return dimensions;
  }
  const variant = contract.variants[0]!;
  if (!product.variables) dimensions.push(dimension("argument-presence", "insufficient", undefined, undefined, undefined,
    "insufficient-static-signature-evidence"));
  else {
    const contractArgs = new Map(variant.arguments.map((item) => [item.name, item]));
    const productArgs = new Map(product.variables.map((item) => [item.name, item]));
    for (const name of unique([...contractArgs.keys(), ...productArgs.keys()]).sort()) {
      const left = contractArgs.get(name); const right = productArgs.get(name);
      if (!left || !right) {
        dimensions.push(dimension("argument-presence", "conflict", name, left ? "present" : "absent",
          right ? "present" : "absent", "argument-presence-conflict")); continue;
      }
      dimensions.push(dimension("argument-name", "match", name, name, name, "argument-name-match"));
      dimensions.push(dimension("argument-type", graphqlType(left.type) === graphqlType(right.type) ? "match" : "conflict",
        name, graphqlType(left.type), graphqlType(right.type), graphqlType(left.type) === graphqlType(right.type)
          ? "argument-type-match" : "argument-type-conflict"));
      if (typeof right.required === "boolean") dimensions.push(dimension("argument-requiredness",
        left.required === right.required ? "match" : "conflict", name, String(left.required), String(right.required),
        left.required === right.required ? "argument-requiredness-match" : "argument-requiredness-conflict"));
      else dimensions.push(dimension("argument-requiredness", "insufficient", name, String(left.required), undefined,
        "insufficient-static-signature-evidence"));
      if (left.defaultValue !== undefined && right.defaultValue !== undefined) dimensions.push(dimension("argument-default",
        left.defaultValue === right.defaultValue ? "match" : "conflict", name, left.defaultValue, right.defaultValue,
        left.defaultValue === right.defaultValue ? "argument-default-match" : "argument-default-conflict"));
    }
  }
  if (variant.returnType && product.returnType) dimensions.push(dimension("return-type",
    graphqlType(variant.returnType) === graphqlType(product.returnType) ? "match" : "conflict", undefined,
    graphqlType(variant.returnType), graphqlType(product.returnType), graphqlType(variant.returnType) === graphqlType(product.returnType)
      ? "return-type-match" : "return-type-conflict"));
  else dimensions.push(dimension("return-type", "insufficient", undefined, variant.returnType, product.returnType,
    "insufficient-static-signature-evidence"));
  return dimensions;
}

function reconcileEndpoints(contractEndpoints: ContractEndpoint[], staticEndpoints: StaticEndpoint[], runtimeEndpoints: RuntimeEndpoint[],
  runtime: RuntimeNavigationDiscoveryGraph, productReconciliation: ReconciliationManifest): ContractReconciliationResult[] {
  const results: ContractReconciliationResult[] = []; const usedStatic = new Set<string>();
  for (const contract of contractEndpoints) {
    const staticMatches = staticEndpoints.filter((item) => endpointCompatible(contract.value, item.value, runtime));
    const runtimeMatches = runtimeEndpoints.filter((item) => endpointEqual(contract.value, item.value));
    staticMatches.forEach((item) => usedStatic.add(item.node.id));
    const product = [...staticMatches.map((item) => ({ nodeId: item.node.id })), ...runtimeMatches.map((item) => item.reference)];
    const reconciliations = productReconciliation.matches.filter((item) => item.domain === "graphql" &&
      (item.static.some((ref) => staticMatches.some((endpoint) => endpoint.node.id === ref.nodeId)) ||
        item.runtime.some((ref) => runtimeMatches.some((endpoint) => sameRuntimeRef(ref, endpoint.reference)))));
    for (const item of reconciliations) product.push({ productReconciliationId: item.id });
    const reasons = [];
    if (staticMatches.some((item) => endpointEqual(contract.value, item.value))) reasons.push("endpoint-exact");
    else if (staticMatches.length) reasons.push("endpoint-path-match");
    if (runtimeMatches.length) reasons.push("endpoint-runtime-observed", "named-runtime-operation-unproven");
    if (product.length === 0) reasons.push("documented-endpoint-not-observed", "runtime-coverage-bounded");
    results.push(makeResult("endpoint", contract.value, `endpoint|${contract.value}|${contract.environmentOrRegion ?? ""}`,
      product.length ? "corroborated" : "contract-only", [{ endpointId: contract.id }], product,
      product.length ? [dimension("endpoint", "match", undefined, contract.value,
        runtimeMatches[0]?.value ?? staticMatches[0]?.value, reasons[0]!)] : [], reasons,
      runtimeMatches.length && staticMatches.length ? "exact" : product.length ? "strong" : undefined));
  }
  for (const endpoint of staticEndpoints.filter((item) => !usedStatic.has(item.node.id))) {
    results.push(makeResult("endpoint", endpoint.value, `endpoint|${endpoint.value}`, "product-only", [],
      [{ nodeId: endpoint.node.id }], [], ["no-contract-endpoint-match"]));
  }
  return results.sort(compareResult);
}

function reconcileTypes(contractTypes: ContractTypeDefinition[], staticTypes: StaticSchemaType[]): ContractReconciliationResult[] {
  const results: ContractReconciliationResult[] = []; const used = new Set<string>();
  for (const contract of contractTypes) {
    const candidates = staticTypes.filter((item) => item.name === contract.name);
    if (candidates.length === 0) {
      results.push(makeResult("type", contract.name, `type|${contract.name}`, "contract-only", [{ typeId: contract.id }], [], [],
        ["no-static-type-match"])); continue;
    }
    if (candidates.length > 1) {
      candidates.forEach((item) => used.add(`${item.node.id}|${item.name}`));
      results.push(makeResult("type", contract.name, `type|${contract.name}`, "ambiguous", [{ typeId: contract.id }],
        candidates.map((item) => ({ nodeId: item.node.id })), [], ["multiple-static-type-candidates"])); continue;
    }
    const product = candidates[0]!; used.add(`${product.node.id}|${product.name}`);
    const dimensions: ContractDimensionResult[] = [];
    const productFields = new Map(product.fields.map((item) => [item.name, item]));
    for (const field of contract.fields) {
      const other = productFields.get(field.name); if (!other) continue;
      dimensions.push(dimension("field-name", "match", field.name, field.name, other.name, "field-name-match"));
      dimensions.push(dimension("field-type", graphqlType(field.type) === graphqlType(other.type) ? "match" : "conflict",
        field.name, graphqlType(field.type), graphqlType(other.type), graphqlType(field.type) === graphqlType(other.type)
          ? "field-type-match" : "field-type-conflict"));
    }
    const conflict = dimensions.some((item) => item.status === "conflict");
    results.push(makeResult("type", contract.name, `type|${contract.name}`, conflict ? "conflicting" : "corroborated",
      [{ typeId: contract.id }], [{ nodeId: product.node.id }], dimensions,
      unique(["type-name-exact", ...dimensions.map((item) => item.reason)]), "exact"));
  }
  for (const product of staticTypes.filter((item) => !used.has(`${item.node.id}|${item.name}`))) {
    results.push(makeResult("type", product.name, `type|${product.name}`, "product-only", [], [{ nodeId: product.node.id }], [],
      ["no-contract-type-match"]));
  }
  return results.sort(compareResult);
}

function linkFeatures(results: ContractReconciliationResult[], featureModel: FeatureModel): ContractFeatureLink[] {
  const links: ContractFeatureLink[] = [];
  for (const result of results.filter((item) => item.domain === "operation" &&
    (item.status === "corroborated" || item.status === "conflicting"))) {
    const operationId = result.contract[0]?.operationId; if (!operationId) continue;
    for (const ref of result.product.filter((item) => item.nodeId)) for (const feature of featureModel.features) {
      if (!feature.graphql.some((item) => item.static.some((staticRef) => staticRef.nodeId === ref.nodeId))) continue;
      links.push({ id: `contract-feature-link:${stableHash(`${feature.id}|${ref.nodeId}|${operationId}|${result.id}`)}`,
        featureId: feature.id, staticGraphqlNodeId: ref.nodeId!, contractOperationId: operationId,
        reconciliationResultId: result.id, reason: "feature-static-operation-link" });
    }
  }
  return uniqueBy(links, (item) => item.id).sort((a, b) => a.id.localeCompare(b.id));
}

function attachOperationTransport(results: ContractReconciliationResult[], graph: ProductEvidenceGraph,
  runtime: RuntimeNavigationDiscoveryGraph, reconciliation: ReconciliationManifest): ContractReconciliationResult[] {
  return results.map((result) => {
    const operationNodeIds = result.product.flatMap((ref) => ref.nodeId ? [ref.nodeId] : []);
    const executionIds = graph.edges.filter((edge) => edge.type === "EXECUTES_OPERATION" && operationNodeIds.includes(edge.to))
      .map((edge) => edge.from);
    const transport = reconciliation.matches.filter((item) => item.domain === "graphql" &&
      item.static.some((ref) => executionIds.includes(ref.nodeId)));
    if (transport.length === 0) return result;
    const product = [...result.product];
    for (const item of transport) {
      product.push({ productReconciliationId: item.id });
      for (const ref of item.runtime) {
        const method = ref.networkObservationId ? runtimeMethod(runtime, ref.networkObservationId) : undefined;
        product.push({ ...(ref.stateId ? { runtimeStateId: ref.stateId } : {}),
          ...(ref.transitionId ? { runtimeTransitionId: ref.transitionId } : {}),
          ...(ref.networkObservationId ? { networkObservationId: ref.networkObservationId } : {}),
          ...(method ? { runtimeMethod: method } : {}) });
      }
    }
    return makeResult(result.domain, result.subject, result.sortKey, result.status, result.contract,
      uniqueBy(product, productRefKey), result.dimensions,
      [...result.reasons, "endpoint-runtime-observed", "named-runtime-operation-unproven"], result.strength);
  }).sort(compareResult);
}

function runtimeMethod(runtime: RuntimeNavigationDiscoveryGraph, observationId: string): string | undefined {
  for (const state of runtime.nodes) for (const set of state.networkObservations) {
    const observation = set.network.find((item) => item.id === observationId); if (observation) return observation.method;
  }
  for (const edge of runtime.transitions) {
    const observation = edge.network.find((item) => item.id === observationId); if (observation) return observation.method;
  }
  return undefined;
}

export function validateContractReconciliation(manifest: ContractReconciliationManifest,
  input: ReconcileProductContractInput): void {
  const all = [...manifest.operations, ...manifest.endpoints, ...manifest.types];
  assertUnique(all.map((item) => item.id), "contract reconciliation result");
  assertUnique(manifest.featureLinks.map((item) => item.id), "contract feature link");
  const operationIds = new Set(input.contract.api.operations.map((item) => item.id));
  const variantIds = new Set(input.contract.api.operations.flatMap((item) => item.variants.map((variant) => variant.id)));
  const endpointIds = new Set(input.contract.api.endpoints.map((item) => item.id));
  const typeIds = new Set(input.contract.api.types.map((item) => item.id));
  const nodeIds = new Set(input.staticGraph.nodes.map((item) => item.id));
  const stateIds = new Set(input.runtimeDiscovery.nodes.map((item) => item.id));
  const transitionIds = new Set(input.runtimeDiscovery.transitions.map((item) => item.id));
  const networkIds = new Set(input.runtimeDiscovery.nodes.flatMap((state) => state.networkObservations.flatMap((set) =>
    set.network.map((item) => item.id))).concat(input.runtimeDiscovery.transitions.flatMap((edge) => edge.network.map((item) => item.id))));
  const reconciliationIds = new Set(allProductResults(input.productReconciliation).map((item) => item.id));
  const featureIds = new Set(input.featureModel.features.map((item) => item.id));
  for (const result of all) {
    if (!["corroborated", "contract-only", "product-only", "ambiguous", "conflicting"].includes(result.status)) {
      throw new Error(`Unsupported contract reconciliation status ${result.status}`);
    }
    if (result.strength && !["exact", "strong", "supporting"].includes(result.strength)) throw new Error(`Unsupported match strength ${result.strength}`);
    for (const ref of result.contract) {
      if (ref.operationId && !operationIds.has(ref.operationId)) throw new Error(`Invalid contract reference ${ref.operationId}`);
      if (ref.operationVariantId && !variantIds.has(ref.operationVariantId)) throw new Error(`Invalid contract reference ${ref.operationVariantId}`);
      if (ref.endpointId && !endpointIds.has(ref.endpointId)) throw new Error(`Invalid contract reference ${ref.endpointId}`);
      if (ref.typeId && !typeIds.has(ref.typeId)) throw new Error(`Invalid contract reference ${ref.typeId}`);
    }
    for (const ref of result.product) {
      if (ref.nodeId && !nodeIds.has(ref.nodeId)) throw new Error(`Invalid static reference ${ref.nodeId}`);
      if (ref.runtimeStateId && !stateIds.has(ref.runtimeStateId)) throw new Error(`Invalid runtime reference ${ref.runtimeStateId}`);
      if (ref.runtimeTransitionId && !transitionIds.has(ref.runtimeTransitionId)) throw new Error(`Invalid runtime reference ${ref.runtimeTransitionId}`);
      if (ref.networkObservationId && !networkIds.has(ref.networkObservationId)) throw new Error(`Invalid runtime reference ${ref.networkObservationId}`);
      if (ref.productReconciliationId && !reconciliationIds.has(ref.productReconciliationId)) {
        throw new Error(`Invalid reconciliation reference ${ref.productReconciliationId}`);
      }
    }
    for (const conflict of result.dimensions.filter((item) => item.status === "conflict")) {
      if (conflict.contractValue === undefined || conflict.productValue === undefined) throw new Error(`Impossible conflict in ${result.id}`);
    }
  }
  for (const link of manifest.featureLinks) {
    if (!featureIds.has(link.featureId)) throw new Error(`Invalid feature reference ${link.featureId}`);
    if (!nodeIds.has(link.staticGraphqlNodeId)) throw new Error(`Invalid static reference ${link.staticGraphqlNodeId}`);
    const result = all.find((item) => item.id === link.reconciliationResultId);
    if (!result || !result.product.some((ref) => ref.nodeId === link.staticGraphqlNodeId) ||
      !result.contract.some((ref) => ref.operationId === link.contractOperationId)) throw new Error(`Invalid feature evidence path ${link.id}`);
  }
}

export function getContractCorroborated(manifest: ContractReconciliationManifest): ContractReconciliationResult[] {
  return allResults(manifest).filter((item) => item.status === "corroborated");
}
export function getContractOnly(manifest: ContractReconciliationManifest): ContractReconciliationResult[] { return [...manifest.contractOnly]; }
export function getProductOnly(manifest: ContractReconciliationManifest): ContractReconciliationResult[] { return [...manifest.productOnly]; }
export function getContractAmbiguous(manifest: ContractReconciliationManifest): ContractReconciliationResult[] { return [...manifest.ambiguous]; }
export function getContractConflicts(manifest: ContractReconciliationManifest): ContractReconciliationResult[] { return [...manifest.conflicting]; }
export function getContractEvidenceForFeature(manifest: ContractReconciliationManifest, featureId: string): ContractFeatureLink[] {
  return manifest.featureLinks.filter((item) => item.featureId === featureId);
}

export function formatContractReconciliation(manifest: ContractReconciliationManifest, contract?: ProductContractEvidence,
  graph?: ProductEvidenceGraph, features?: FeatureModel): string {
  const lines = ["CONTRACT RECONCILIATION"];
  for (const result of manifest.operations) {
    lines.push("", "OPERATION", result.subject, "", "DOCUMENTED", operationText(result, contract), "", "STATIC",
      staticOperationText(result, graph), "", "RESULT", result.status.toUpperCase());
    const linked = manifest.featureLinks.filter((item) => item.reconciliationResultId === result.id);
    if (linked.length) lines.push("", "FEATURES", ...linked.map((item) => features?.features.find((feature) => feature.id === item.featureId)?.name ?? item.featureId));
    if (result.reasons.includes("named-runtime-operation-unproven")) lines.push("", "RUNTIME", "Transport endpoint observed", "Named operation execution unproven");
  }
  lines.push("", "SUMMARY", ...Object.entries(manifest.summary.total).map(([status, count]) => `${status}: ${count}`));
  return lines.join("\n");
}

function readStaticOperations(graph: ProductEvidenceGraph): StaticOperation[] {
  return graph.nodes.filter((node) => node.type === "graphql-operation").flatMap((node) => {
    const type = node.data.operationType; const name = node.data.name;
    if ((type !== "query" && type !== "mutation" && type !== "subscription") || typeof name !== "string") return [];
    const variables = Array.isArray(node.data.variables) ? node.data.variables.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>; if (typeof item.name !== "string" || typeof item.type !== "string") return [];
      return [{ name: item.name, type: item.type, ...(typeof item.required === "boolean" ? { required: item.required } : {}),
        ...(typeof item.defaultValue === "string" ? { defaultValue: item.defaultValue } : {}) }];
    }) : undefined;
    return [{ node, name, type, ...(variables ? { variables } : {}),
      ...(typeof node.data.returnType === "string" ? { returnType: node.data.returnType } : {}) }];
  });
}

function readStaticEndpoints(graph: ProductEvidenceGraph): StaticEndpoint[] {
  return graph.nodes.filter((node) => node.type === "graphql-execution").flatMap((node) => {
    const transport = node.data.transport as Record<string, unknown> | undefined;
    const endpoint = transport?.endpoint as Record<string, unknown> | undefined;
    return endpoint?.kind === "static" && typeof endpoint.value === "string" ? [{ node, value: endpoint.value }] : [];
  });
}

function readStaticTypes(graph: ProductEvidenceGraph): StaticSchemaType[] {
  const result: StaticSchemaType[] = [];
  for (const node of graph.nodes.filter((item) => item.type === "graphql-document")) {
    if (!Array.isArray(node.data.schemaTypes)) continue;
    for (const value of node.data.schemaTypes) {
      if (!value || typeof value !== "object") continue; const item = value as Record<string, unknown>;
      if (typeof item.name !== "string" || !Array.isArray(item.fields)) continue;
      const fields = item.fields.flatMap((field) => field && typeof field === "object" &&
        typeof (field as Record<string, unknown>).name === "string" && typeof (field as Record<string, unknown>).type === "string"
        ? [{ name: (field as Record<string, unknown>).name as string, type: (field as Record<string, unknown>).type as string }] : []);
      result.push({ node, name: item.name, fields });
    }
  }
  return result;
}

function readRuntimeEndpoints(runtime: RuntimeNavigationDiscoveryGraph, reconciliation: ReconciliationManifest): RuntimeEndpoint[] {
  const refs = reconciliation.matches.filter((item) => item.domain === "graphql").flatMap((item) => item.runtime);
  const result: RuntimeEndpoint[] = [];
  for (const state of runtime.nodes) for (const set of state.networkObservations) for (const observation of set.network) {
    if (refs.some((ref) => ref.networkObservationId === observation.id && (!ref.stateId || ref.stateId === state.id))) {
      result.push({ value: observation.url, method: observation.method,
        reference: { runtimeStateId: state.id, networkObservationId: observation.id, runtimeMethod: observation.method } });
    }
  }
  for (const edge of runtime.transitions) for (const observation of edge.network) {
    if (refs.some((ref) => ref.networkObservationId === observation.id && (!ref.transitionId || ref.transitionId === edge.id))) {
      result.push({ value: observation.url, method: observation.method,
        reference: { runtimeTransitionId: edge.id, networkObservationId: observation.id, runtimeMethod: observation.method } });
    }
  }
  return result.sort((a, b) => `${a.value}|${a.method}`.localeCompare(`${b.value}|${b.method}`));
}

function endpointCompatible(contract: string, product: string, runtime: RuntimeNavigationDiscoveryGraph): boolean {
  if (endpointEqual(contract, product)) return true;
  if (!product.startsWith("/")) return false;
  const contractUrl = new URL(contract); if (contractUrl.pathname !== normalizePath(product)) return false;
  return runtime.nodes.some((state) => new URL(state.url).origin === contractUrl.origin) ||
    readAllRuntimeUrls(runtime).some((value) => { try { return new URL(value).origin === contractUrl.origin; } catch { return false; } });
}
function endpointEqual(left: string, right: string): boolean {
  try { const a = new URL(left); const b = new URL(right); return a.origin === b.origin && normalizePath(a.pathname) === normalizePath(b.pathname); }
  catch { return left === right; }
}
function readAllRuntimeUrls(runtime: RuntimeNavigationDiscoveryGraph): string[] {
  return runtime.nodes.flatMap((state) => state.networkObservations.flatMap((set) => set.network.map((item) => item.url)))
    .concat(runtime.transitions.flatMap((edge) => edge.network.map((item) => item.url)));
}
function normalizePath(value: string): string { const path = value.startsWith("/") ? value : `/${value}`; return path.length > 1 ? path.replace(/\/+$/, "") : path; }
function graphqlType(value: string): string { return value.replace(/\s+/g, ""); }
function dimension(dimension_: ContractComparisonDimension, status: ContractDimensionResult["status"], key: string | undefined,
  contractValue: string | undefined, productValue: string | undefined, reason: string): ContractDimensionResult {
  return { dimension: dimension_, status, ...(key ? { key } : {}), ...(contractValue !== undefined ? { contractValue } : {}),
    ...(productValue !== undefined ? { productValue } : {}), reason };
}
function makeResult(domain: ContractReconciliationDomain, subject: string, sortKey: string, status: ContractReconciliationStatus,
  contract: ContractEvidenceReference[], product: ProductEvidenceReference[], dimensions: ContractDimensionResult[], reasons: string[],
  strength?: ContractReconciliationStrength): ContractReconciliationResult {
  const identity = JSON.stringify({ domain, subject, status, contract: contract.map(contractRefKey).sort(),
    product: product.map(productRefKey).sort(), dimensions });
  return { id: `contract-reconciliation-result:${stableHash(identity)}`, domain, subject, sortKey, status,
    ...(strength ? { strength } : {}), contract, product, dimensions, reasons: unique(reasons) };
}
function buildCoverage(input: ReconcileProductContractInput, staticOperations: StaticOperation[], staticEndpoints: StaticEndpoint[],
  runtimeEndpoints: RuntimeEndpoint[], operations: ContractReconciliationResult[], endpoints: ContractReconciliationResult[],
  types: ContractReconciliationResult[]): ContractReconciliationCoverage {
  return { contract: { sourceUrl: input.contract.source.finalUrl, retrievalStatus: input.contract.source.status,
    apiStyle: input.contract.api.style, operations: input.contract.api.operations.length, endpoints: input.contract.api.endpoints.length,
    types: input.contract.api.types.length }, product: { staticGraphqlOperations: staticOperations.length,
    staticEndpoints: staticEndpoints.length, runtimeEndpoints: runtimeEndpoints.length,
    featuresWithGraphql: input.featureModel.features.filter((item) => item.graphql.length > 0).length },
  compared: { operations: operations.filter((item) => item.contract.length && item.product.length).length,
    endpoints: endpoints.filter((item) => item.contract.length && item.product.length).length,
    types: types.filter((item) => item.contract.length && item.product.length).length },
  runtime: structuredClone(input.productReconciliation.coverage) };
}
function summarize(results: ContractReconciliationResult[], links: ContractFeatureLink[]): ContractReconciliationSummary {
  const statuses: ContractReconciliationStatus[] = ["corroborated", "contract-only", "product-only", "ambiguous", "conflicting"];
  const empty = () => Object.fromEntries(statuses.map((status) => [status, 0])) as Record<ContractReconciliationStatus, number>;
  const total = empty(); const byDomain = { operation: empty(), endpoint: empty(), type: empty() };
  for (const item of results) { total[item.status] += 1; byDomain[item.domain][item.status] += 1; }
  return { total, byDomain, featureLinks: links.length };
}
function operationText(result: ContractReconciliationResult, contract?: ProductContractEvidence): string {
  const operation = contract?.api.operations.find((item) => item.id === result.contract[0]?.operationId); if (!operation) return result.subject;
  const variant = operation.variants[0]; return `${operation.type} ${operation.name}${variant ? `(${variant.arguments.map((item) => `${item.name}: ${item.type}`).join(", ")})${variant.returnType ? `: ${variant.returnType}` : ""}` : ""}`;
}
function staticOperationText(result: ContractReconciliationResult, graph?: ProductEvidenceGraph): string {
  const node = graph?.nodes.find((item) => item.id === result.product.find((ref) => ref.nodeId)?.nodeId); return node?.label ?? "not available";
}
function assertInputSources(input: ReconcileProductContractInput): void {
  if (input.featureModel.sourceEvidence.reconciliationId !== input.productReconciliation.id) throw new Error("Feature model reconciliation source mismatch");
  if (input.featureModel.sourceEvidence.staticGraphId !== input.productReconciliation.staticGraphId ||
    input.featureModel.sourceEvidence.runtimeDiscoveryId !== input.productReconciliation.runtimeDiscoveryId) throw new Error("Feature model evidence source mismatch");
}
function allProductResults(manifest: ReconciliationManifest) { return [...manifest.matches, ...manifest.staticOnly, ...manifest.runtimeOnly, ...manifest.ambiguous]; }
function allResults(manifest: ContractReconciliationManifest) { return [...manifest.operations, ...manifest.endpoints, ...manifest.types]; }
function contractRefKey(ref: ContractEvidenceReference) { return [ref.operationId, ref.operationVariantId, ref.endpointId, ref.typeId, ref.fieldId].join("|"); }
function productRefKey(ref: ProductEvidenceReference) { return [ref.nodeId, ref.runtimeStateId, ref.runtimeTransitionId,
  ref.networkObservationId, ref.productReconciliationId, ref.runtimeMethod].join("|"); }
function sameRuntimeRef(left: ReconciliationRuntimeReference, right: ProductEvidenceReference): boolean {
  return left.networkObservationId === right.networkObservationId && (!left.stateId || left.stateId === right.runtimeStateId) &&
    (!left.transitionId || left.transitionId === right.runtimeTransitionId);
}
function compareResult(a: ContractReconciliationResult, b: ContractReconciliationResult): number { return `${a.domain}|${a.sortKey}|${a.id}`.localeCompare(`${b.domain}|${b.sortKey}|${b.id}`); }
function unique<T>(items: T[]): T[] { return [...new Set(items)]; }
function uniqueBy<T>(items: T[], key: (item: T) => string): T[] { const seen = new Set<string>(); return items.filter((item) => {
  const value = key(item); if (seen.has(value)) return false; seen.add(value); return true; }); }
function assertUnique(items: string[], label: string): void { if (new Set(items).size !== items.length) throw new Error(`Duplicate ${label} ID`); }
