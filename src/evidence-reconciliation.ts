import { stableHash } from "./runtime-capture.js";
import type { ProductEvidenceGraph, ProductEvidenceNode } from "./product-evidence-graph.js";
import type {
  RuntimeNavigationDiscoveryGraph,
  RuntimeStateNode,
  RuntimeTransitionEdge,
} from "./runtime-discovery.js";

export type ReconciliationDomain = "route" | "ui" | "navigation" | "http" | "graphql";
export type ReconciliationStatus = "corroborated" | "static-only" | "runtime-only" | "ambiguous";
export type ReconciliationStrength = "exact" | "strong" | "supporting";

export interface ReconciliationStaticReference {
  nodeId: string;
  nodeType: ProductEvidenceNode["type"];
  evidence: ProductEvidenceNode["evidence"];
}

export interface ReconciliationRuntimeReference {
  stateId?: string;
  elementId?: string;
  candidateId?: string;
  transitionId?: string;
  networkObservationId?: string;
  sourceId?: string;
  sourceType?: "runtime-capture" | "runtime-probe-after" | "runtime-probe";
}

export interface ReconciledEvidenceResult {
  id: string;
  domain: ReconciliationDomain;
  status: ReconciliationStatus;
  strength?: ReconciliationStrength;
  static: ReconciliationStaticReference[];
  runtime: ReconciliationRuntimeReference[];
  reasons: string[];
}

export interface ReconciliationCoverage {
  bounded: true;
  limits: RuntimeNavigationDiscoveryGraph["limits"];
  statesObserved: number;
  transitionsObserved: number;
  originBoundaries: number;
  mutationStops: number;
  partialStates: Array<{ stateId: string; readiness: RuntimeStateNode["readiness"] }>;
  branchStops: Array<{ stateId: string; reasons: RuntimeStateNode["stopReasons"] }>;
  overallStopReasons: RuntimeNavigationDiscoveryGraph["stopReasons"];
}

export interface ReconciliationDomainSummary {
  corroborated: number;
  staticOnly: number;
  runtimeOnly: number;
  ambiguous: number;
}

export interface ReconciliationManifest {
  id: string;
  staticGraphId: string;
  runtimeDiscoveryId: string;
  matches: ReconciledEvidenceResult[];
  staticOnly: ReconciledEvidenceResult[];
  runtimeOnly: ReconciledEvidenceResult[];
  ambiguous: ReconciledEvidenceResult[];
  coverage: ReconciliationCoverage;
  summary: Record<ReconciliationDomain, ReconciliationDomainSummary>;
  textSummary: string;
}

export interface ReconcileProductEvidenceInput {
  staticGraph: ProductEvidenceGraph;
  runtimeDiscovery: RuntimeNavigationDiscoveryGraph;
}

interface StaticUiDescriptor {
  node: ProductEvidenceNode;
  routes: string[];
  tag: string;
  text: string;
  ariaLabel: string;
  placeholder: string;
  inputType: string;
  hasEvent: boolean;
}

interface RuntimeUiDescriptor {
  state: RuntimeStateNode;
  kind: "semantic" | "candidate";
  id: string;
  tag: string;
  role: string;
  name: string;
  visibleText: string;
  placeholder: string;
  inputType: string;
  strongInteraction: boolean;
}

interface RuntimeNetworkDescriptor {
  stateId?: string;
  transitionId?: string;
  sourceId: string;
  sourceType: ReconciliationRuntimeReference["sourceType"];
  observation: RuntimeStateNode["network"][number];
}

const RESOURCE_TYPES = new Set(["document", "script", "stylesheet", "image", "font", "media"]);

export function reconcileProductEvidence(input: ReconcileProductEvidenceInput): ReconciliationManifest {
  const staticGraphId = graphId(input.staticGraph);
  const runtimeDiscoveryId = discoveryId(input.runtimeDiscovery);
  const results = [
    ...reconcileRoutes(input.staticGraph, input.runtimeDiscovery),
    ...reconcileUi(input.staticGraph, input.runtimeDiscovery),
    ...reconcileNavigation(input.staticGraph, input.runtimeDiscovery),
    ...reconcileHttp(input.staticGraph, input.runtimeDiscovery),
    ...reconcileGraphql(input.staticGraph, input.runtimeDiscovery),
  ].sort(compareResult);
  const manifest: ReconciliationManifest = {
    id: `reconciliation:${stableHash(`${staticGraphId}|${runtimeDiscoveryId}`)}`,
    staticGraphId,
    runtimeDiscoveryId,
    matches: results.filter((item) => item.status === "corroborated"),
    staticOnly: results.filter((item) => item.status === "static-only"),
    runtimeOnly: results.filter((item) => item.status === "runtime-only"),
    ambiguous: results.filter((item) => item.status === "ambiguous"),
    coverage: coverage(input.runtimeDiscovery),
    summary: summarize(results),
    textSummary: "",
  };
  manifest.textSummary = formatReconciliationSummary(manifest);
  validateReconciliationManifest(manifest, input.staticGraph, input.runtimeDiscovery);
  return manifest;
}

function reconcileRoutes(graph: ProductEvidenceGraph, runtime: RuntimeNavigationDiscoveryGraph): ReconciledEvidenceResult[] {
  const results: ReconciledEvidenceResult[] = [];
  const matchedStates = new Set<string>();
  for (const route of graph.nodes.filter((node) => node.type === "route")) {
    const path = readStaticValue(route.data.path);
    if (!path) {
      results.push(result("route", "ambiguous", [staticRef(route)], [], ["dynamic-static-evidence"]));
      continue;
    }
    const candidates = runtime.nodes.filter((state) => routeMatches(path, runtimeRoute(state.url)));
    if (candidates.length === 0) {
      results.push(result("route", "static-only", [staticRef(route)], [],
        ["no-runtime-state-for-route", "runtime-coverage-bounded"]));
      continue;
    }
    for (const state of candidates) {
      matchedStates.add(state.id);
      const exact = normalizeRoute(path) === runtimeRoute(state.url);
      results.push(result("route", "corroborated", [staticRef(route)], [{ stateId: state.id }],
        [exact ? (new URL(state.url).hash.startsWith("#/") ? "hash-route-match" : "route-path-exact") :
          "route-parameter-match"], exact ? "exact" : "strong"));
    }
  }
  for (const state of runtime.nodes.filter((item) => !matchedStates.has(item.id))) {
    results.push(result("route", "runtime-only", [], [{ stateId: state.id }], ["no-static-route-match"]));
  }
  return results;
}

function reconcileUi(graph: ProductEvidenceGraph, runtime: RuntimeNavigationDiscoveryGraph): ReconciledEvidenceResult[] {
  const staticUi = staticUiDescriptors(graph);
  const runtimeUi = runtimeUiDescriptors(runtime);
  const potentials = new Map<string, RuntimeUiDescriptor[]>();
  for (const item of staticUi) {
    potentials.set(item.node.id, runtimeUi.filter((candidate) => uiCompatible(item, candidate)));
  }
  const inverse = new Map<string, StaticUiDescriptor[]>();
  for (const item of staticUi) for (const candidate of potentials.get(item.node.id) ?? []) {
    const key = `${candidate.state.id}|${candidate.kind}|${candidate.id}`;
    const values = inverse.get(key) ?? [];
    values.push(item);
    inverse.set(key, values);
  }
  const results: ReconciledEvidenceResult[] = [];
  const consumedStatic = new Set<string>();
  const consumedRuntime = new Set<string>();
  for (const [key, staticCandidates] of [...inverse].sort(([left], [right]) => left.localeCompare(right))) {
    if (staticCandidates.length < 2) continue;
    const runtimeCandidate = runtimeUi.find((item) => `${item.state.id}|${item.kind}|${item.id}` === key)!;
    results.push(result("ui", "ambiguous", staticCandidates.map((item) => staticRef(item.node)),
      [runtimeUiRef(runtimeCandidate)], ["duplicate-label-ambiguous", "route-context-match"]));
    staticCandidates.forEach((item) => consumedStatic.add(item.node.id));
    consumedRuntime.add(key);
  }
  for (const item of staticUi) {
    if (consumedStatic.has(item.node.id)) continue;
    const candidates = (potentials.get(item.node.id) ?? []).filter((candidate) =>
      !consumedRuntime.has(`${candidate.state.id}|${candidate.kind}|${candidate.id}`));
    if (candidates.length === 0) {
      results.push(result("ui", "static-only", [staticRef(item.node)], [],
        [item.text ? "no-runtime-element-match" : "dynamic-static-evidence", "runtime-coverage-bounded"]));
    } else if (candidates.length > 1) {
      results.push(result("ui", "ambiguous", [staticRef(item.node)], candidates.map(runtimeUiRef),
        ["multiple-runtime-element-matches", "route-context-match"]));
      candidates.forEach((candidate) => consumedRuntime.add(`${candidate.state.id}|${candidate.kind}|${candidate.id}`));
    } else {
      const candidate = candidates[0]!;
      const reasons = uiReasons(item, candidate);
      results.push(result("ui", "corroborated", [staticRef(item.node)], [runtimeUiRef(candidate)], reasons,
        reasons.includes("element-text-exact") && reasons.includes("element-type-match") ? "exact" : "strong"));
      consumedRuntime.add(`${candidate.state.id}|${candidate.kind}|${candidate.id}`);
    }
  }
  for (const item of runtimeUi) {
    const key = `${item.state.id}|${item.kind}|${item.id}`;
    if (!consumedRuntime.has(key)) results.push(result("ui", "runtime-only", [], [runtimeUiRef(item)],
      [item.kind === "candidate" ? "no-static-candidate-match" : "no-static-element-match"]));
  }
  return results;
}

function reconcileNavigation(graph: ProductEvidenceGraph, runtime: RuntimeNavigationDiscoveryGraph): ReconciledEvidenceResult[] {
  const results: ReconciledEvidenceResult[] = [];
  const usedTransitions = new Set<string>();
  for (const navigation of graph.nodes.filter((node) => node.type === "navigation")) {
    const destination = readStaticValue(navigation.data.destination);
    const label = readStaticValue(navigation.data.label) ?? "";
    if (!destination) {
      results.push(result("navigation", "ambiguous", [staticRef(navigation)], [], ["dynamic-static-evidence"]));
      continue;
    }
    const candidates = runtime.transitions.filter((edge) => {
      const state = runtime.nodes.find((item) => item.id === edge.to);
      return state && routeMatches(destination, runtimeRoute(state.url));
    });
    if (candidates.length === 0) {
      results.push(result("navigation", "static-only", [staticRef(navigation)], [],
        ["no-runtime-transition-match", "runtime-coverage-bounded"]));
    } else if (candidates.length > 1 && !label) {
      results.push(result("navigation", "ambiguous", [staticRef(navigation)], candidates.map(transitionRef),
        ["duplicate-navigation-ambiguous", "navigation-destination-match"]));
    } else {
      const labelled = candidates.filter((edge) => normalizeText(runtimeTargetText(edge)) === normalizeText(label));
      const selected = labelled.length === 1 ? labelled : candidates.length === 1 ? candidates : [];
      if (selected.length !== 1) {
        results.push(result("navigation", "ambiguous", [staticRef(navigation)], candidates.map(transitionRef),
          ["duplicate-navigation-ambiguous", "navigation-destination-match"]));
      } else {
        const edge = selected[0]!;
        usedTransitions.add(edge.id);
        const reasons = ["navigation-destination-match"];
        if (label && normalizeText(runtimeTargetText(edge)) === normalizeText(label)) reasons.push("navigation-label-match");
        results.push(result("navigation", "corroborated", [staticRef(navigation)], [transitionRef(edge)], reasons,
          reasons.length === 2 ? "exact" : "strong"));
      }
    }
  }
  for (const edge of runtime.transitions.filter((item) => !usedTransitions.has(item.id))) {
    results.push(result("navigation", "runtime-only", [], [transitionRef(edge)],
      [edge.transition?.kind === "same-url" ? "same-url-transition-no-static-navigation" : "no-static-navigation-match"]));
  }
  return results;
}

function reconcileHttp(graph: ProductEvidenceGraph, runtime: RuntimeNavigationDiscoveryGraph): ReconciledEvidenceResult[] {
  const results: ReconciledEvidenceResult[] = [];
  const requests = runtimeNetwork(runtime).filter((item) => !RESOURCE_TYPES.has(item.observation.resourceType));
  const staticRequests = graph.nodes.filter((node) => node.type === "http-request");
  const potentials = new Map<string, RuntimeNetworkDescriptor[]>();
  for (const node of staticRequests) {
    const method = readStaticValue(node.data.method)?.toUpperCase();
    const url = readStaticValue(node.data.effectiveUrl) ?? readStaticValue(node.data.url);
    potentials.set(node.id, method && url ? requests.filter((item) => item.observation.method.toUpperCase() === method &&
      httpPath(item.observation.url) === httpPath(url)) : []);
    if (!method || !url) results.push(result("http", "ambiguous", [staticRef(node)], [], ["dynamic-static-evidence"]));
  }
  const dynamicIds = new Set(results.flatMap((item) => item.static.map((ref) => ref.nodeId)));
  const inverse = new Map<string, ProductEvidenceNode[]>();
  for (const node of staticRequests.filter((item) => !dynamicIds.has(item.id))) {
    for (const candidate of potentials.get(node.id) ?? []) {
      const key = networkKey(candidate);
      const values = inverse.get(key) ?? [];
      values.push(node); inverse.set(key, values);
    }
  }
  const usedNetwork = new Set<string>();
  const usedStatic = new Set<string>(dynamicIds);
  for (const [key, nodes] of inverse) {
    if (nodes.length < 2) continue;
    const candidate = requests.find((item) => networkKey(item) === key)!;
    results.push(result("http", "ambiguous", nodes.map(staticRef), [networkRef(candidate)],
      ["duplicate-static-request-ambiguous", "http-method-match", "http-path-match"]));
    nodes.forEach((node) => usedStatic.add(node.id)); usedNetwork.add(key);
  }
  for (const node of staticRequests.filter((item) => !usedStatic.has(item.id))) {
    const candidates = (potentials.get(node.id) ?? []).filter((item) => !usedNetwork.has(networkKey(item)));
    if (candidates.length === 0) results.push(result("http", "static-only", [staticRef(node)], [],
      ["static-request-not-observed", "runtime-coverage-bounded"]));
    else {
      results.push(result("http", "corroborated", [staticRef(node)], candidates.map(networkRef),
        ["http-method-match", "http-path-match"], candidates.length === 1 ? "exact" : "strong"));
      candidates.forEach((item) => usedNetwork.add(networkKey(item)));
    }
  }
  for (const item of requests.filter((candidate) => !usedNetwork.has(networkKey(candidate)))) {
    results.push(result("http", "runtime-only", [], [networkRef(item)], ["network-request-not-in-static-manifest"]));
  }
  return results;
}

function reconcileGraphql(graph: ProductEvidenceGraph, runtime: RuntimeNavigationDiscoveryGraph): ReconciledEvidenceResult[] {
  const executions = graph.nodes.filter((node) => node.type === "graphql-execution");
  const requests = runtimeNetwork(runtime).filter((item) => !RESOURCE_TYPES.has(item.observation.resourceType));
  const groups = new Map<string, ProductEvidenceNode[]>();
  const results: ReconciledEvidenceResult[] = [];
  for (const node of executions) {
    const transport = node.data.transport as { endpoint?: { kind?: string; value?: string } } | undefined;
    if (transport?.endpoint?.kind !== "static" || !transport.endpoint.value) {
      results.push(result("graphql", "static-only", [staticRef(node)], [], ["graphql-endpoint-unresolved"]));
      continue;
    }
    const key = httpPath(transport.endpoint.value);
    const values = groups.get(key) ?? []; values.push(node); groups.set(key, values);
  }
  for (const [endpoint, nodes] of groups) {
    const matches = requests.filter((item) => httpPath(item.observation.url) === endpoint);
    if (matches.length === 0) results.push(result("graphql", "static-only", nodes.map(staticRef), [],
      ["graphql-endpoint-not-observed", "runtime-coverage-bounded"]));
    else results.push(result("graphql", "corroborated", nodes.map(staticRef), matches.map(networkRef),
      ["graphql-endpoint-match", "named-operation-not-proven"], "strong"));
  }
  return results;
}

export function validateReconciliationManifest(
  manifest: ReconciliationManifest,
  staticGraph: ProductEvidenceGraph,
  runtime: RuntimeNavigationDiscoveryGraph,
): void {
  const all = allResults(manifest);
  assertUnique(all.map((item) => item.id), "reconciliation result");
  const staticIds = new Set(staticGraph.nodes.map((node) => node.id));
  const stateIds = new Set(runtime.nodes.map((node) => node.id));
  const transitionIds = new Set(runtime.transitions.map((edge) => edge.id));
  const networkIds = new Set(runtimeNetwork(runtime).map((item) => item.observation.id));
  for (const item of all) {
    if (item.reasons.length === 0) throw new Error(`Reconciliation ${item.id} has no reason codes`);
    if (item.status === "corroborated" && (!item.strength || item.static.length === 0 || item.runtime.length === 0)) {
      throw new Error(`Corroborated reconciliation ${item.id} requires strength and both evidence systems`);
    }
    if (item.status === "static-only" && (item.static.length === 0 || item.runtime.length > 0)) {
      throw new Error(`Static-only reconciliation ${item.id} has invalid references`);
    }
    if (item.status === "runtime-only" && (item.runtime.length === 0 || item.static.length > 0)) {
      throw new Error(`Runtime-only reconciliation ${item.id} has invalid references`);
    }
    for (const ref of item.static) if (!staticIds.has(ref.nodeId)) throw new Error(`Missing static reference ${ref.nodeId}`);
    for (const ref of item.runtime) {
      if (ref.stateId && !stateIds.has(ref.stateId)) throw new Error(`Missing runtime state ${ref.stateId}`);
      if (ref.transitionId && !transitionIds.has(ref.transitionId)) throw new Error(`Missing runtime transition ${ref.transitionId}`);
      if (ref.networkObservationId && !networkIds.has(ref.networkObservationId)) {
        throw new Error(`Missing runtime network observation ${ref.networkObservationId}`);
      }
    }
  }
  const exactStatic = new Set<string>();
  for (const item of manifest.matches.filter((entry) => entry.strength === "exact")) for (const ref of item.static) {
    const key = `${item.domain}|${ref.nodeId}`;
    if (exactStatic.has(key) && item.domain !== "route") throw new Error(`Duplicate exact match for ${ref.nodeId}`);
    exactStatic.add(key);
  }
}

export function getCorroboratedEvidence(manifest: ReconciliationManifest): ReconciledEvidenceResult[] {
  return [...manifest.matches];
}
export function getStaticOnlyEvidence(manifest: ReconciliationManifest): ReconciledEvidenceResult[] {
  return [...manifest.staticOnly];
}
export function getRuntimeOnlyEvidence(manifest: ReconciliationManifest): ReconciledEvidenceResult[] {
  return [...manifest.runtimeOnly];
}
export function getAmbiguousEvidence(manifest: ReconciliationManifest): ReconciledEvidenceResult[] {
  return [...manifest.ambiguous];
}

export function formatReconciliationSummary(manifest: ReconciliationManifest): string {
  const lines = ["RECONCILIATION"];
  for (const domain of ["route", "ui", "navigation", "http", "graphql"] as const) {
    const item = manifest.summary[domain];
    lines.push(`${domain.toUpperCase()} ${item.corroborated} corroborated, ${item.staticOnly} static-only, ` +
      `${item.runtimeOnly} runtime-only, ${item.ambiguous} ambiguous`);
  }
  lines.push(`RUNTIME COVERAGE ${manifest.coverage.statesObserved} states / depth ${manifest.coverage.limits.maxDepth}`);
  lines.push(`${manifest.coverage.mutationStops} mutation stops, ${manifest.coverage.originBoundaries} origin boundaries`);
  return lines.join("\n");
}

function staticUiDescriptors(graph: ProductEvidenceGraph): StaticUiDescriptor[] {
  const componentRoutes = componentRouteMap(graph);
  return graph.nodes.filter((node) => node.type === "ui-element").map((node) => {
    const props = Array.isArray(node.data.props) ? node.data.props as Array<Record<string, unknown>> : [];
    const prop = (name: string) => props.find((item) => item.name === name && item.valueType === "string")?.value as string | undefined;
    const component = String(node.data.component ?? "");
    return { node, routes: componentRoutes.get(component) ?? [], tag: String(node.data.name ?? "").toLowerCase(),
      text: quotedLabel(node.label), ariaLabel: prop("aria-label") ?? "", placeholder: prop("placeholder") ?? "",
      inputType: prop("type") ?? "", hasEvent: graph.edges.some((edge) => edge.type === "HAS_EVENT" && edge.from === node.id) };
  });
}

function componentRouteMap(graph: ProductEvidenceGraph): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of graph.edges.filter((item) => item.type === "ROUTE_RENDERS_COMPONENT")) {
    const route = graph.nodes.find((node) => node.id === edge.from);
    const component = graph.nodes.find((node) => node.id === edge.to);
    const path = route && readStaticValue(route.data.path);
    if (component && path) result.set(component.label, [...(result.get(component.label) ?? []), normalizeRoute(path)]);
  }
  return result;
}

function runtimeUiDescriptors(runtime: RuntimeNavigationDiscoveryGraph): RuntimeUiDescriptor[] {
  return runtime.nodes.flatMap((state) => [
    ...state.semanticElements.map((item) => ({ state, kind: "semantic" as const, id: item.id,
      tag: item.type.toLowerCase(), role: item.role.toLowerCase(), name: item.accessibleName,
      visibleText: item.visibleText ?? "", placeholder: item.placeholder ?? "", inputType: item.inputType ?? "",
      strongInteraction: false })),
    ...state.interactionCandidates.map((item) => ({ state, kind: "candidate" as const, id: item.id,
      tag: item.tag.toLowerCase(), role: item.role ?? "", name: item.accessibleName ?? "", visibleText: item.text,
      placeholder: "", inputType: "", strongInteraction: item.strength === "strong" })),
  ]);
}

function uiCompatible(item: StaticUiDescriptor, candidate: RuntimeUiDescriptor): boolean {
  if (item.routes.length === 0 || !item.routes.some((route) => routeMatches(route, runtimeRoute(candidate.state.url)))) return false;
  const staticNames = [item.text, item.ariaLabel, item.placeholder].map(normalizeText).filter(Boolean);
  const runtimeNames = [candidate.name, candidate.visibleText, candidate.placeholder].map(normalizeText).filter(Boolean);
  if (!staticNames.some((name) => runtimeNames.includes(name))) return false;
  if (item.inputType && candidate.inputType && item.inputType.toLowerCase() !== candidate.inputType.toLowerCase()) return false;
  return compatibleTag(item.tag, candidate.tag, candidate.role);
}

function uiReasons(item: StaticUiDescriptor, candidate: RuntimeUiDescriptor): string[] {
  const reasons = ["route-context-match"];
  if (normalizeText(item.text) && normalizeText(item.text) === normalizeText(candidate.visibleText)) reasons.push("element-text-exact");
  if ([item.text, item.ariaLabel].map(normalizeText).includes(normalizeText(candidate.name))) reasons.push("accessible-name-exact");
  if (item.ariaLabel && normalizeText(item.ariaLabel) === normalizeText(candidate.name)) reasons.push("aria-label-match");
  if (compatibleTag(item.tag, candidate.tag, candidate.role)) reasons.push("element-type-match");
  if (item.inputType && item.inputType.toLowerCase() === candidate.inputType.toLowerCase()) reasons.push("input-type-match");
  if (item.placeholder && normalizeText(item.placeholder) === normalizeText(candidate.placeholder)) reasons.push("placeholder-match");
  if (item.hasEvent && candidate.strongInteraction) reasons.push("interaction-evidence-match");
  return reasons;
}

function runtimeNetwork(runtime: RuntimeNavigationDiscoveryGraph): RuntimeNetworkDescriptor[] {
  const result: RuntimeNetworkDescriptor[] = [];
  for (const state of runtime.nodes) for (const set of state.networkObservations) for (const observation of set.network) {
    result.push({ stateId: state.id, sourceId: set.sourceId, sourceType: set.sourceType, observation });
  }
  for (const edge of runtime.transitions) for (const observation of edge.network) {
    result.push({ transitionId: edge.id, sourceId: edge.runtimeProbeId, sourceType: "runtime-probe", observation });
  }
  return result.sort((left, right) => networkKey(left).localeCompare(networkKey(right)));
}

function result(domain: ReconciliationDomain, status: ReconciliationStatus,
  staticReferences: ReconciliationStaticReference[], runtimeReferences: ReconciliationRuntimeReference[],
  reasons: string[], strength?: ReconciliationStrength): ReconciledEvidenceResult {
  const identity = JSON.stringify({ domain, status, static: staticReferences.map((item) => item.nodeId).sort(),
    runtime: runtimeReferences.map(runtimeRefKey).sort(), reasons: [...reasons].sort() });
  return { id: `reconciliation-result:${stableHash(identity)}`, domain, status,
    ...(strength ? { strength } : {}), static: staticReferences, runtime: runtimeReferences, reasons };
}

function staticRef(node: ProductEvidenceNode): ReconciliationStaticReference {
  return { nodeId: node.id, nodeType: node.type, evidence: node.evidence };
}
function runtimeUiRef(item: RuntimeUiDescriptor): ReconciliationRuntimeReference {
  return { stateId: item.state.id, ...(item.kind === "semantic" ? { elementId: item.id } : { candidateId: item.id }) };
}
function transitionRef(edge: RuntimeTransitionEdge): ReconciliationRuntimeReference {
  return { transitionId: edge.id, sourceId: edge.runtimeProbeId, sourceType: "runtime-probe" };
}
function networkRef(item: RuntimeNetworkDescriptor): ReconciliationRuntimeReference {
  return { ...(item.stateId ? { stateId: item.stateId } : {}), ...(item.transitionId ? { transitionId: item.transitionId } : {}),
    networkObservationId: item.observation.id, sourceId: item.sourceId, ...(item.sourceType ? { sourceType: item.sourceType } : {}) };
}

function coverage(runtime: RuntimeNavigationDiscoveryGraph): ReconciliationCoverage {
  return { bounded: true, limits: runtime.limits, statesObserved: runtime.nodes.length,
    transitionsObserved: runtime.transitions.length, originBoundaries: runtime.nodes.filter((item) => item.boundary).length,
    mutationStops: runtime.nodes.filter((item) => item.stopReasons.includes("mutation-observed")).length,
    partialStates: runtime.nodes.filter((item) => item.readiness.status === "partial")
      .map((item) => ({ stateId: item.id, readiness: item.readiness })),
    branchStops: runtime.nodes.filter((item) => item.stopReasons.length > 0)
      .map((item) => ({ stateId: item.id, reasons: item.stopReasons })), overallStopReasons: runtime.stopReasons };
}

function summarize(results: ReconciledEvidenceResult[]): Record<ReconciliationDomain, ReconciliationDomainSummary> {
  const empty = () => ({ corroborated: 0, staticOnly: 0, runtimeOnly: 0, ambiguous: 0 });
  const summary = { route: empty(), ui: empty(), navigation: empty(), http: empty(), graphql: empty() };
  for (const item of results) {
    if (item.status === "corroborated") summary[item.domain].corroborated += 1;
    else if (item.status === "static-only") summary[item.domain].staticOnly += 1;
    else if (item.status === "runtime-only") summary[item.domain].runtimeOnly += 1;
    else summary[item.domain].ambiguous += 1;
  }
  return summary;
}

function graphId(graph: ProductEvidenceGraph): string {
  return `static-graph:${stableHash(JSON.stringify({ root: graph.root, nodes: graph.nodes.map((item) => item.id), edges: graph.edges.map((item) => item.id) }))}`;
}
function discoveryId(graph: RuntimeNavigationDiscoveryGraph): string {
  return `runtime-discovery:${stableHash(JSON.stringify({ startUrl: graph.startUrl, nodes: graph.nodes.map((item) => item.id), transitions: graph.transitions.map((item) => item.id) }))}`;
}
function normalizeText(value: string): string { return value.replace(/\s+/g, " ").trim().toLowerCase(); }
function normalizeRoute(value: string): string { const route = value.startsWith("/") ? value : `/${value}`; return route.length > 1 ? route.replace(/\/+$/, "") : route; }
function runtimeRoute(value: string): string {
  const url = new URL(value); return normalizeRoute(url.hash.startsWith("#/") ? url.hash.slice(1).split("?")[0]! : url.pathname);
}
function routeMatches(staticPath: string, runtimePath: string): boolean {
  const pattern = normalizeRoute(staticPath); const actual = normalizeRoute(runtimePath);
  if (pattern === actual) return true;
  const parts = pattern.split("/"); const values = actual.split("/");
  if (parts.length !== values.length && !parts.includes("*")) return false;
  return parts.every((part, index) => part.startsWith(":") || part === "*" || part === values[index]);
}
function httpPath(value: string): string {
  try { const url = new URL(value, "https://runtime.invalid"); return `${url.pathname}${url.search}`; }
  catch { return value; }
}
function readStaticValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return record.kind === "static" && typeof record.value === "string" ? record.value : undefined;
}
function quotedLabel(value: string): string { return /"([\s\S]*)"$/.exec(value)?.[1] ?? ""; }
function compatibleTag(staticTag: string, runtimeTag: string, role: string): boolean {
  const normalized = staticTag.toLowerCase();
  if (normalized === runtimeTag) return true;
  if (/button$/i.test(normalized) && role === "button") return true;
  if (/link$/i.test(normalized) && role === "link") return true;
  return normalized === "input" && runtimeTag === "input";
}
function runtimeTargetText(edge: RuntimeTransitionEdge): string {
  if (!edge.target) return "";
  return edge.target.source === "semantic-element" ? edge.target.accessibleName || edge.target.visibleText || "" : edge.target.accessibleName || edge.target.text;
}
function networkKey(item: RuntimeNetworkDescriptor): string { return `${item.sourceId}|${item.observation.id}`; }
function runtimeRefKey(item: ReconciliationRuntimeReference): string {
  return [item.stateId, item.elementId, item.candidateId, item.transitionId, item.networkObservationId, item.sourceId].join("|");
}
function compareResult(left: ReconciledEvidenceResult, right: ReconciledEvidenceResult): number {
  return `${left.domain}|${left.status}|${left.id}`.localeCompare(`${right.domain}|${right.status}|${right.id}`);
}
function allResults(manifest: ReconciliationManifest): ReconciledEvidenceResult[] {
  return [...manifest.matches, ...manifest.staticOnly, ...manifest.runtimeOnly, ...manifest.ambiguous];
}
function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} ID`);
}
