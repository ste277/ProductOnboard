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

export type RouteCandidateSelection = "selected" | "equally-specific" | "compatible-but-less-specific";

export interface RouteSpecificityEvidence {
  exactLiteralMatch: boolean;
  segmentConstraints: Array<"literal" | "parameter" | "wildcard">;
  literalSegments: number;
  parameterSegments: number;
  wildcardSegments: number;
  constrainedDepth: number;
}

export interface ReconciliationRouteCandidate {
  staticRouteId: string;
  staticRoutePattern: string;
  compatibility: "route-compatible";
  specificity: RouteSpecificityEvidence;
  selection: RouteCandidateSelection;
}

export interface ReconciliationRouteEvidence {
  runtimeStateId: string;
  runtimeUrl: string;
  normalizedApplicationPath: string;
  candidates: ReconciliationRouteCandidate[];
}

export type UiCandidateSelection = "selected" | "equally-compatible";

export interface ReconciliationUiCandidate {
  staticUiId: string;
  staticComponentId?: string;
  staticComponentPath?: string[];
  reasons: string[];
  selection: UiCandidateSelection;
}

export interface ReconciliationUiContextEvidence {
  runtimeStateId: string;
  runtimeTargetId: string;
  runtimeTargetType: "semantic-element" | "interaction-candidate";
  contextStatus: "eligible" | "insufficient-static-ui-context" | "ambiguous-route-context";
  selectedRouteReconciliationId?: string;
  staticRouteId?: string;
  staticComponentIds: string[];
  staticComponentPaths?: Array<{ componentId: string; path: string[]; depth: number }>;
  evaluatedStaticCandidates: number;
  candidates: ReconciliationUiCandidate[];
}

export interface ReconciledEvidenceResult {
  id: string;
  domain: ReconciliationDomain;
  status: ReconciliationStatus;
  strength?: ReconciliationStrength;
  static: ReconciliationStaticReference[];
  runtime: ReconciliationRuntimeReference[];
  reasons: string[];
  route?: ReconciliationRouteEvidence;
  uiContext?: ReconciliationUiContextEvidence;
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

export interface ReconciliationUiContextMetrics {
  runtimeUiWithEligibleStaticContext: number;
  runtimeUiWithoutStaticContext: number;
  candidatePairsEvaluated: number;
  uniqueMatches: number;
  ambiguousMatches: number;
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
  uiContextMetrics: ReconciliationUiContextMetrics;
  textSummary: string;
}

export interface ReconcileProductEvidenceInput {
  staticGraph: ProductEvidenceGraph;
  runtimeDiscovery: RuntimeNavigationDiscoveryGraph;
}

interface StaticUiDescriptor {
  node: ProductEvidenceNode;
  componentId?: string;
  tag: string;
  text: string;
  ariaLabel: string;
  label: string;
  title: string;
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
  const routeResults = reconcileRoutes(input.staticGraph, input.runtimeDiscovery);
  const results = [
    ...routeResults,
    ...reconcileUi(input.staticGraph, input.runtimeDiscovery, routeResults),
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
    uiContextMetrics: summarizeUiContext(results),
    textSummary: "",
  };
  manifest.textSummary = formatReconciliationSummary(manifest);
  validateReconciliationManifest(manifest, input.staticGraph, input.runtimeDiscovery);
  return manifest;
}

function reconcileRoutes(graph: ProductEvidenceGraph, runtime: RuntimeNavigationDiscoveryGraph): ReconciledEvidenceResult[] {
  const results: ReconciledEvidenceResult[] = [];
  const staticRoutes: Array<{ node: ProductEvidenceNode; path: string }> = [];
  for (const route of graph.nodes.filter((node) => node.type === "route")) {
    const path = readStaticValue(route.data.path);
    if (!path) {
      results.push(result("route", "ambiguous", [staticRef(route)], [], ["dynamic-static-evidence"]));
      continue;
    }
    staticRoutes.push({ node: route, path });
  }

  const compatibleStaticIds = new Set<string>();
  for (const state of runtime.nodes) {
    const applicationPath = runtimeRoute(state.url);
    const compatible = staticRoutes.flatMap((route) => {
      const specificity = routeSpecificity(route.path, applicationPath);
      return specificity ? [{ ...route, specificity }] : [];
    });
    compatible.forEach((candidate) => compatibleStaticIds.add(candidate.node.id));

    if (compatible.length === 0) {
      results.push(result("route", "runtime-only", [], [{ stateId: state.id }], ["no-static-route-match"], undefined,
        routeEvidence(state, applicationPath, [], [])));
      continue;
    }

    const winners = compatible.filter((candidate) => !compatible.some((other) =>
      other.node.id !== candidate.node.id && specificityDominates(other.specificity, candidate.specificity)));
    const routeEvidenceValue = routeEvidence(state, applicationPath, compatible, winners);
    if (winners.length === 1) {
      const winner = winners[0]!;
      const exact = winner.specificity.exactLiteralMatch;
      const reasons = [exact ? (new URL(state.url).hash.startsWith("#/") ? "hash-route-match" : "route-path-exact") :
        "route-parameter-match", "unique-most-specific-route"];
      if (compatible.length > 1) reasons.push("less-specific-compatible-routes-suppressed");
      results.push(result("route", "corroborated", [staticRef(winner.node)], [{ stateId: state.id }], reasons,
        exact ? "exact" : "strong", routeEvidenceValue));
    } else {
      results.push(result("route", "ambiguous", winners.map((candidate) => staticRef(candidate.node)), [{ stateId: state.id }],
        ["multiple-equally-specific-routes", "route-compatibility-proven"], undefined, routeEvidenceValue));
    }
  }

  for (const route of staticRoutes.filter((candidate) => !compatibleStaticIds.has(candidate.node.id))) {
    results.push(result("route", "static-only", [staticRef(route.node)], [],
      ["no-runtime-state-for-route", "runtime-coverage-bounded"]));
  }
  return results;
}

function reconcileUi(graph: ProductEvidenceGraph, runtime: RuntimeNavigationDiscoveryGraph,
  routeResults: ReconciledEvidenceResult[]): ReconciledEvidenceResult[] {
  const staticUi = staticUiDescriptors(graph);
  const runtimeUi = runtimeUiDescriptors(runtime);
  const descriptorById = new Map(staticUi.map((item) => [item.node.id, item]));
  const routeScopes = staticUiRouteScopes(graph, routeResults);
  const selectedRouteByState = new Map(routeResults.filter((item) => item.domain === "route" && item.status === "corroborated" &&
    item.static.length === 1 && item.runtime.length === 1 && item.route)
    .flatMap((item) => item.runtime[0]?.stateId ? [[item.runtime[0].stateId, item] as const] : []));
  const ambiguousRouteStates = new Set(routeResults.filter((item) => item.domain === "route" && item.status === "ambiguous")
    .flatMap((item) => item.runtime.flatMap((ref) => ref.stateId ? [ref.stateId] : [])));
  const results: ReconciledEvidenceResult[] = [];
  const consumedStatic = new Set<string>();
  for (const item of runtimeUi) {
    const selectedRoute = selectedRouteByState.get(item.state.id);
    const routeId = selectedRoute?.static[0]?.nodeId;
    const scope = routeId ? routeScopes.get(routeId) : undefined;
    const contextStatus: ReconciliationUiContextEvidence["contextStatus"] = ambiguousRouteStates.has(item.state.id)
      ? "ambiguous-route-context" : scope && scope.uiIds.length > 0 ? "eligible" : "insufficient-static-ui-context";
    const scopedStatic = contextStatus === "eligible" ? scope!.uiIds.map((id) => descriptorById.get(id)).filter(isStaticUi) : [];
    const candidates = scopedStatic.flatMap((candidate) => {
      const reasons = uiMatchReasons(candidate, item);
      return reasons ? [{ candidate, reasons }] : [];
    });
    const uiContext = makeUiContext(item, contextStatus, selectedRoute, scope?.componentIds ?? [],
      scope?.componentPaths ?? [], scope?.uiPaths ?? new Map(), scopedStatic.length, candidates);
    if (candidates.length === 0) {
      results.push(result("ui", "runtime-only", [], [runtimeUiRef(item)],
        [contextStatus === "eligible" ? "no-compatible-static-ui" : contextStatus], undefined, undefined, uiContext));
    } else if (candidates.length > 1) {
      candidates.forEach(({ candidate }) => consumedStatic.add(candidate.node.id));
      results.push(result("ui", "ambiguous", candidates.map(({ candidate }) => staticRef(candidate.node)), [runtimeUiRef(item)],
        ["multiple-compatible-static-ui", "duplicate-label-ambiguous", "selected-route-context", "route-context-match"],
        undefined, undefined, uiContext));
    } else {
      const match = candidates[0]!;
      consumedStatic.add(match.candidate.node.id);
      results.push(result("ui", "corroborated", [staticRef(match.candidate.node)], [runtimeUiRef(item)],
        ["selected-route-context", "route-context-match", ...match.reasons], match.reasons.includes("exact-text") ? "exact" : "strong",
        undefined, uiContext));
    }
  }
  const scopedStaticIds = new Set([...routeScopes.values()].flatMap((scope) => scope.uiIds));
  for (const item of staticUi.filter((candidate) => !consumedStatic.has(candidate.node.id))) {
    const hasIdentity = staticUiIdentityValues(item).length > 0;
    results.push(result("ui", "static-only", [staticRef(item.node)], [],
      [!hasIdentity ? "dynamic-static-identity" : scopedStaticIds.has(item.node.id)
        ? "no-runtime-element-match" : "insufficient-runtime-route-context", "runtime-coverage-bounded"]));
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
    if (item.route) {
      if (!stateIds.has(item.route.runtimeStateId)) throw new Error(`Missing route runtime state ${item.route.runtimeStateId}`);
      if (!item.route.normalizedApplicationPath.startsWith("/")) {
        throw new Error(`Invalid normalized application path ${item.route.normalizedApplicationPath}`);
      }
      for (const candidate of item.route.candidates) {
        if (!staticIds.has(candidate.staticRouteId)) throw new Error(`Missing route candidate ${candidate.staticRouteId}`);
      }
      const selected = item.route.candidates.filter((candidate) => candidate.selection === "selected");
      const tied = item.route.candidates.filter((candidate) => candidate.selection === "equally-specific");
      if (item.status === "corroborated" && selected.length !== 1) {
        throw new Error(`Corroborated route ${item.id} requires one selected candidate`);
      }
      if (item.status === "ambiguous" && item.runtime.length > 0 && tied.length < 2) {
        throw new Error(`Ambiguous route ${item.id} requires equally specific candidates`);
      }
    }
    if (item.uiContext) {
      if (!stateIds.has(item.uiContext.runtimeStateId)) throw new Error(`Missing UI context state ${item.uiContext.runtimeStateId}`);
      if (item.uiContext.staticRouteId && !staticIds.has(item.uiContext.staticRouteId)) {
        throw new Error(`Missing UI context route ${item.uiContext.staticRouteId}`);
      }
      for (const id of item.uiContext.staticComponentIds) if (!staticIds.has(id)) {
        throw new Error(`Missing UI context component ${id}`);
      }
      for (const entry of item.uiContext.staticComponentPaths ?? []) {
        if (!staticIds.has(entry.componentId) || entry.path.some((id) => !staticIds.has(id))) {
          throw new Error(`Missing UI context component path ${entry.componentId}`);
        }
        if (entry.depth !== entry.path.length - 1) throw new Error(`Invalid UI context depth ${entry.componentId}`);
      }
      for (const candidate of item.uiContext.candidates) {
        if (!staticIds.has(candidate.staticUiId)) throw new Error(`Missing UI candidate ${candidate.staticUiId}`);
        if (candidate.staticComponentId && !staticIds.has(candidate.staticComponentId)) {
          throw new Error(`Missing UI candidate component ${candidate.staticComponentId}`);
        }
      }
      if (item.status === "corroborated" && item.uiContext.candidates.filter((candidate) => candidate.selection === "selected").length !== 1) {
        throw new Error(`Corroborated UI ${item.id} requires one selected candidate`);
      }
    }
  }
  const exactStatic = new Set<string>();
  for (const item of manifest.matches.filter((entry) => entry.strength === "exact")) for (const ref of item.static) {
    const key = `${item.domain}|${ref.nodeId}`;
    if (exactStatic.has(key) && item.domain !== "route" && item.domain !== "ui") throw new Error(`Duplicate exact match for ${ref.nodeId}`);
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
  const ownerByUi = new Map<string, string>();
  const eventUiIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.type === "CONTAINS_ELEMENT" && !ownerByUi.has(edge.to)) ownerByUi.set(edge.to, edge.from);
    if (edge.type === "HAS_EVENT") eventUiIds.add(edge.from);
  }
  return graph.nodes.filter((node) => node.type === "ui-element").map((node) => {
    const props = Array.isArray(node.data.props) ? node.data.props as Array<Record<string, unknown>> : [];
    const prop = (name: string) => props.find((item) => item.name === name && item.valueType === "string")?.value as string | undefined;
    const owner = ownerByUi.get(node.id);
    return { node, ...(owner ? { componentId: owner } : {}), tag: String(node.data.name ?? "").toLowerCase(),
      text: quotedLabel(node.label), ariaLabel: prop("aria-label") ?? "", label: prop("label") ?? "",
      title: prop("title") ?? "", placeholder: prop("placeholder") ?? "",
      inputType: prop("type") ?? "", hasEvent: eventUiIds.has(node.id) };
  });
}

interface StaticUiRouteScope {
  componentIds: string[];
  componentPaths: Array<{ componentId: string; path: string[]; depth: number }>;
  uiIds: string[];
  uiPaths: Map<string, string[]>;
}

const MAX_COMPONENT_RENDER_DEPTH = 32;

function staticUiRouteScopes(graph: ProductEvidenceGraph,
  routeResults: ReconciledEvidenceResult[]): Map<string, StaticUiRouteScope> {
  const selectedRouteIds = new Set(routeResults.filter((item) => item.domain === "route" && item.status === "corroborated")
    .flatMap((item) => item.static.map((ref) => ref.nodeId)));
  const contains = new Map<string, string[]>();
  for (const edge of graph.edges.filter((item) => item.type === "CONTAINS_ELEMENT")) {
    contains.set(edge.from, [...(contains.get(edge.from) ?? []), edge.to]);
  }
  const renders = new Map<string, string[]>();
  for (const edge of graph.edges.filter((item) => item.type === "COMPONENT_RENDERS_COMPONENT")) {
    renders.set(edge.from, [...(renders.get(edge.from) ?? []), edge.to]);
  }
  const nodeTypes = new Map(graph.nodes.map((item) => [item.id, item.type]));
  const scopes = new Map<string, StaticUiRouteScope>();
  for (const routeId of selectedRouteIds) {
    const roots = graph.edges.filter((edge) => edge.type === "ROUTE_RENDERS_COMPONENT" && edge.from === routeId)
      .map((edge) => edge.to).sort();
    const visited = new Set<string>();
    const queue = roots.map((id) => ({ id, path: [id], depth: 0 }));
    const uiIds: string[] = [];
    const uiPaths = new Map<string, string[]>();
    const componentPaths = new Map<string, string[]>();
    while (queue.length) {
      const current = queue.shift()!; if (visited.has(current.id)) continue; visited.add(current.id);
      if (nodeTypes.get(current.id) === "component") componentPaths.set(current.id, current.path);
      for (const child of contains.get(current.id) ?? []) {
        if (nodeTypes.get(child) === "ui-element") {
          uiIds.push(child);
          uiPaths.set(child, current.path);
          if (!visited.has(child)) queue.push({ ...current, id: child });
        }
      }
      if (nodeTypes.get(current.id) === "component" && current.depth < MAX_COMPONENT_RENDER_DEPTH) {
        for (const child of [...(renders.get(current.id) ?? [])].sort()) {
          if (!visited.has(child)) queue.push({ id: child, path: [...current.path, child], depth: current.depth + 1 });
        }
      }
    }
    scopes.set(routeId, {
      componentIds: [...componentPaths.keys()].sort(),
      componentPaths: [...componentPaths].map(([componentId, componentPath]) => ({
        componentId, path: componentPath, depth: componentPath.length - 1,
      })).sort((left, right) => left.componentId.localeCompare(right.componentId)),
      uiIds: unique(uiIds).sort(), uiPaths,
    });
  }
  return scopes;
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

function uiMatchReasons(item: StaticUiDescriptor, candidate: RuntimeUiDescriptor): string[] | undefined {
  const kindReason = compatibleUiKind(item.tag, candidate.tag, candidate.role);
  if (!kindReason) return undefined;
  if (item.inputType && candidate.inputType && item.inputType.toLowerCase() !== candidate.inputType.toLowerCase()) return undefined;
  const reasons = [kindReason, "element-type-match"];
  const runtimeName = normalizeText(candidate.name);
  const runtimeText = normalizeText(candidate.visibleText);
  if (normalizeText(item.ariaLabel) && normalizeText(item.ariaLabel) === runtimeName) {
    reasons.push("exact-accessible-name", "accessible-name-exact", "aria-label-match");
  }
  if (normalizeText(item.text) && (normalizeText(item.text) === runtimeText || normalizeText(item.text) === runtimeName)) {
    if (normalizeText(item.text) === runtimeText) reasons.push("exact-text", "element-text-exact");
    if (normalizeText(item.text) === runtimeName) reasons.push("exact-accessible-name", "accessible-name-exact");
  }
  if ([item.label, item.title].map(normalizeText).filter(Boolean).includes(runtimeName)) reasons.push("exact-label");
  if (normalizeText(item.placeholder) && normalizeText(item.placeholder) === normalizeText(candidate.placeholder)) {
    reasons.push("exact-placeholder", "placeholder-match");
  }
  const identityReasons = reasons.filter((reason) => reason.startsWith("exact-"));
  if (identityReasons.length === 0) return undefined;
  if (item.inputType && candidate.inputType && item.inputType.toLowerCase() === candidate.inputType.toLowerCase()) reasons.push("input-type-match");
  if (item.hasEvent && candidate.strongInteraction) reasons.push("event-compatible", "interaction-evidence-match");
  return unique(reasons);
}

function staticUiIdentityValues(item: StaticUiDescriptor): string[] {
  return [item.text, item.ariaLabel, item.label, item.title, item.placeholder].map(normalizeText).filter(Boolean);
}

function makeUiContext(item: RuntimeUiDescriptor, contextStatus: ReconciliationUiContextEvidence["contextStatus"],
  selectedRoute: ReconciledEvidenceResult | undefined, componentIds: string[],
  componentPaths: Array<{ componentId: string; path: string[]; depth: number }>, uiPaths: Map<string, string[]>,
  evaluatedStaticCandidates: number,
  candidates: Array<{ candidate: StaticUiDescriptor; reasons: string[] }>): ReconciliationUiContextEvidence {
  return { runtimeStateId: item.state.id, runtimeTargetId: item.id,
    runtimeTargetType: item.kind === "semantic" ? "semantic-element" : "interaction-candidate", contextStatus,
    ...(selectedRoute ? { selectedRouteReconciliationId: selectedRoute.id,
      staticRouteId: selectedRoute.static[0]!.nodeId } : {}), staticComponentIds: componentIds,
    ...(componentPaths.length ? { staticComponentPaths: componentPaths } : {}), evaluatedStaticCandidates,
    candidates: candidates.map(({ candidate, reasons }) => {
      const componentPath = uiPaths.get(candidate.node.id);
      return { staticUiId: candidate.node.id,
        ...(candidate.componentId ? { staticComponentId: candidate.componentId } : {}),
        ...(componentPath ? { staticComponentPath: componentPath } : {}), reasons,
        selection: candidates.length === 1 ? "selected" as const : "equally-compatible" as const };
    }) };
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
  reasons: string[], strength?: ReconciliationStrength, route?: ReconciliationRouteEvidence,
  uiContext?: ReconciliationUiContextEvidence): ReconciledEvidenceResult {
  const identity = JSON.stringify({ domain, status, static: staticReferences.map((item) => item.nodeId).sort(),
    runtime: runtimeReferences.map(runtimeRefKey).sort(), reasons: [...reasons].sort() });
  return { id: `reconciliation-result:${stableHash(identity)}`, domain, status,
    ...(strength ? { strength } : {}), static: staticReferences, runtime: runtimeReferences, reasons,
    ...(route ? { route } : {}), ...(uiContext ? { uiContext } : {}) };
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

function summarizeUiContext(results: ReconciledEvidenceResult[]): ReconciliationUiContextMetrics {
  const ui = results.filter((item) => item.domain === "ui" && item.uiContext);
  return { runtimeUiWithEligibleStaticContext: ui.filter((item) => item.uiContext!.contextStatus === "eligible").length,
    runtimeUiWithoutStaticContext: ui.filter((item) => item.uiContext!.contextStatus !== "eligible").length,
    candidatePairsEvaluated: ui.reduce((sum, item) => sum + item.uiContext!.evaluatedStaticCandidates, 0),
    uniqueMatches: ui.filter((item) => item.status === "corroborated").length,
    ambiguousMatches: ui.filter((item) => item.status === "ambiguous").length };
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
  return routeSpecificity(staticPath, runtimePath) !== undefined;
}

function routeSpecificity(staticPath: string, runtimePath: string): RouteSpecificityEvidence | undefined {
  const pattern = normalizeRoute(staticPath);
  const actual = normalizeRoute(runtimePath);
  const parts = routeSegments(pattern);
  const values = routeSegments(actual);
  const constraints: RouteSpecificityEvidence["segmentConstraints"] = [];
  let valueIndex = 0;
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex]!;
    if (isWildcardSegment(part)) {
      const minimum = part.endsWith("+") ? 1 : 0;
      if (values.length - valueIndex < minimum) return undefined;
      while (valueIndex < values.length) { constraints.push("wildcard"); valueIndex += 1; }
      if (valueIndex === values.length && minimum === 0 && constraints.length === 0) constraints.push("wildcard");
      if (partIndex !== parts.length - 1) return undefined;
      break;
    }
    if (isOptionalParameter(part) && valueIndex >= values.length) continue;
    if (valueIndex >= values.length) return undefined;
    if (part.startsWith(":")) constraints.push("parameter");
    else {
      if (part !== values[valueIndex]) return undefined;
      constraints.push("literal");
    }
    valueIndex += 1;
  }
  if (valueIndex !== values.length) return undefined;
  const literalSegments = constraints.filter((item) => item === "literal").length;
  const parameterSegments = constraints.filter((item) => item === "parameter").length;
  const wildcardSegments = constraints.filter((item) => item === "wildcard").length;
  return { exactLiteralMatch: pattern === actual && parameterSegments === 0 && wildcardSegments === 0,
    segmentConstraints: constraints, literalSegments, parameterSegments, wildcardSegments,
    constrainedDepth: literalSegments + parameterSegments };
}

function specificityDominates(left: RouteSpecificityEvidence, right: RouteSpecificityEvidence): boolean {
  if (left.exactLiteralMatch !== right.exactLiteralMatch) return left.exactLiteralMatch;
  const rank = (value: RouteSpecificityEvidence["segmentConstraints"][number] | undefined) =>
    value === "literal" ? 2 : value === "parameter" ? 1 : 0;
  const depth = Math.max(left.segmentConstraints.length, right.segmentConstraints.length);
  let strictlyMoreSpecific = false;
  for (let index = 0; index < depth; index += 1) {
    const leftRank = rank(left.segmentConstraints[index]);
    const rightRank = rank(right.segmentConstraints[index]);
    if (leftRank < rightRank) return false;
    if (leftRank > rightRank) strictlyMoreSpecific = true;
  }
  return strictlyMoreSpecific;
}

function routeEvidence(
  state: RuntimeStateNode,
  applicationPath: string,
  compatible: Array<{ node: ProductEvidenceNode; path: string; specificity: RouteSpecificityEvidence }>,
  winners: Array<{ node: ProductEvidenceNode }>,
): ReconciliationRouteEvidence {
  const winnerIds = new Set(winners.map((item) => item.node.id));
  return { runtimeStateId: state.id, runtimeUrl: state.url, normalizedApplicationPath: applicationPath,
    candidates: compatible.map((candidate) => ({ staticRouteId: candidate.node.id,
      staticRoutePattern: normalizeRoute(candidate.path), compatibility: "route-compatible",
      specificity: candidate.specificity, selection: winnerIds.has(candidate.node.id)
        ? winners.length === 1 ? "selected" : "equally-specific"
        : "compatible-but-less-specific" })) };
}

function routeSegments(value: string): string[] { return value === "/" ? [] : value.slice(1).split("/"); }
function isWildcardSegment(value: string): boolean {
  return value === "*" || (value.startsWith(":") && (value.endsWith("*") || value.endsWith("+")));
}
function isOptionalParameter(value: string): boolean { return value.startsWith(":") && value.endsWith("?"); }
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
function compatibleUiKind(staticTag: string, runtimeTag: string, role: string): string | undefined {
  const normalized = staticTag.toLowerCase();
  if (normalized === runtimeTag) return "compatible-element-kind";
  if (normalized === "button" && role === "button") return "compatible-role";
  if ((normalized === "a" || normalized === "link") && role === "link") return "compatible-role";
  if (normalized === "input" && ["textbox", "checkbox", "radio", "spinbutton", "searchbox"].includes(role)) return "compatible-role";
  if (normalized === "textarea" && role === "textbox") return "compatible-role";
  if (normalized === "select" && role === "combobox") return "compatible-role";
  if (/^h[1-6]$/.test(normalized) && role === "heading") return "compatible-role";
  return undefined;
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
function unique(values: string[]): string[] { return [...new Set(values)]; }
function isStaticUi(value: StaticUiDescriptor | undefined): value is StaticUiDescriptor { return Boolean(value); }
