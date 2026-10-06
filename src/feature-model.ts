import { stableHash } from "./runtime-capture.js";
import type {
  ProductEvidenceEdge,
  ProductEvidenceGraph,
  ProductEvidenceNode,
} from "./product-evidence-graph.js";
import type {
  ReconciledEvidenceResult,
  ReconciliationManifest,
  ReconciliationStatus,
} from "./evidence-reconciliation.js";
import type {
  RuntimeNavigationDiscoveryGraph,
  RuntimeStateNode,
  RuntimeTransitionEdge,
} from "./runtime-discovery.js";

export type FeatureNameSourceType =
  | "navigation-label"
  | "primary-action"
  | "static-heading"
  | "runtime-heading"
  | "component"
  | "route-literal"
  | "route-bound-value"
  | "runtime-route-structure"
  | "route-pattern"
  | "route-segment"
  | "runtime-name";

export interface FeatureNameSource {
  type: FeatureNameSourceType;
  evidenceId: string;
}

export type FeatureRouteBindingClassification = "stable-slug" | "opaque-identifier" | "redacted";

export interface FeatureRouteBinding {
  runtimeStateId: string;
  parameter: string;
  position: number;
  classification: FeatureRouteBindingClassification;
  value?: string;
}

export interface FeatureRouteIdentity {
  selectedReconciliationIds: string[];
  staticRoutePattern: string;
  runtimePaths: string[];
  bindings: FeatureRouteBinding[];
  identityKey: string;
}

export interface FeatureStaticReference {
  nodeId?: string;
  edgeId?: string;
}

export interface FeatureRuntimeReference {
  stateId?: string;
  transitionId?: string;
  elementId?: string;
  candidateId?: string;
  networkObservationId?: string;
}

export interface FeatureEvidenceStatus {
  static: boolean;
  runtime: boolean;
  reconciliation: ReconciliationStatus[];
  screenshot: boolean;
  api: boolean;
}

export interface FeatureEvidenceItem {
  id: string;
  kind: "route" | "component" | "ui" | "action" | "callable" | "http" | "graphql";
  label: string;
  status: ReconciliationStatus | "static" | "runtime";
  static: FeatureStaticReference[];
  runtime: FeatureRuntimeReference[];
  reconciliationIds: string[];
}

export interface FeatureEntryPoint {
  id: string;
  label: string;
  destination?: string;
  staticNodeId?: string;
  transitionId?: string;
}

export interface FeatureScreenshot {
  runtimeStateId: string;
  path: string;
  width: number;
  height: number;
  captured: boolean;
}

export interface FeatureRelationship {
  id: string;
  type: "navigation-to" | "runtime-transition-to";
  fromFeatureId: string;
  toFeatureId: string;
  staticEdgeId?: string;
  runtimeTransitionId?: string;
}

export interface FeatureCandidate {
  id: string;
  name: string;
  nameSource: FeatureNameSource;
  routeIdentity?: FeatureRouteIdentity;
  root: { type: "static-route" | "static-navigation" | "runtime-state"; evidenceId: string };
  entryPoints: FeatureEntryPoint[];
  routes: FeatureEvidenceItem[];
  runtimeStates: string[];
  ui: FeatureEvidenceItem[];
  actions: FeatureEvidenceItem[];
  api: FeatureEvidenceItem[];
  graphql: FeatureEvidenceItem[];
  screenshots: FeatureScreenshot[];
  evidenceStatus: FeatureEvidenceStatus;
  provenance: {
    staticNodeIds: string[];
    staticEdgeIds: string[];
    runtimeStateIds: string[];
    runtimeTransitionIds: string[];
    reconciliationResultIds: string[];
  };
}

export interface UnassignedFeatureEvidence {
  id: string;
  kind: "static-node" | "static-edge" | "runtime-state" | "runtime-transition" | "reconciliation";
  evidenceId: string;
  reason: string;
  status?: ReconciliationStatus;
}

export interface FeatureModelSummary {
  features: number;
  staticAndRuntime: number;
  staticOnly: number;
  runtimeOnly: number;
  relationships: number;
  unassignedEvidence: number;
}

export interface FeatureModel {
  id: string;
  sourceEvidence: {
    staticGraphId: string;
    runtimeDiscoveryId: string;
    reconciliationId: string;
  };
  features: FeatureCandidate[];
  relationships: FeatureRelationship[];
  unassignedEvidence: UnassignedFeatureEvidence[];
  coverage: ReconciliationManifest["coverage"];
  summary: FeatureModelSummary;
  textSummary: string;
}

export interface BuildFeatureModelInput {
  staticGraph: ProductEvidenceGraph;
  runtimeDiscovery: RuntimeNavigationDiscoveryGraph;
  reconciliation: ReconciliationManifest;
}

interface FeatureSeed {
  rootType: FeatureCandidate["root"]["type"];
  rootId: string;
  route?: ProductEvidenceNode;
  navigation?: ProductEvidenceNode;
  states: RuntimeStateNode[];
  identityKey?: string;
}

const USER_FACING_NODE_TYPES = new Set(["route", "navigation", "component", "ui-element", "ui-event"]);

export function buildFeatureModel(input: BuildFeatureModelInput): FeatureModel {
  assertSourcesMatch(input);
  const allReconciliation = reconciliationResults(input.reconciliation);
  const seeds = featureSeeds(input.staticGraph, input.runtimeDiscovery, allReconciliation);
  const features = seeds.map((seed) => buildFeature(seed, input, allReconciliation)).sort(compareFeature);
  const relationships = buildRelationships(features, input.staticGraph, input.runtimeDiscovery);
  const unassignedEvidence = collectUnassigned(features, relationships, input, allReconciliation);
  const model: FeatureModel = {
    id: `feature-model:${stableHash(JSON.stringify({
      staticGraphId: input.reconciliation.staticGraphId,
      runtimeDiscoveryId: input.reconciliation.runtimeDiscoveryId,
      reconciliationId: input.reconciliation.id,
      features: features.map((item) => item.id),
    }))}`,
    sourceEvidence: {
      staticGraphId: input.reconciliation.staticGraphId,
      runtimeDiscoveryId: input.reconciliation.runtimeDiscoveryId,
      reconciliationId: input.reconciliation.id,
    },
    features,
    relationships,
    unassignedEvidence,
    coverage: structuredClone(input.reconciliation.coverage),
    summary: summarize(features, relationships, unassignedEvidence),
    textSummary: "",
  };
  model.textSummary = formatFeatureModel(model);
  validateFeatureModel(model, input.staticGraph, input.runtimeDiscovery, input.reconciliation);
  return model;
}

function featureSeeds(graph: ProductEvidenceGraph, runtime: RuntimeNavigationDiscoveryGraph,
  reconciliation: ReconciledEvidenceResult[]): FeatureSeed[] {
  const seeds: FeatureSeed[] = [];
  const assignedStates = new Set<string>();
  const rootedRoutes = new Set<string>();
  for (const route of graph.nodes.filter((node) => node.type === "route" && staticValue(node.data.path))) {
    const routeKey = normalizedRoute(route);
    if (rootedRoutes.has(routeKey)) continue;
    rootedRoutes.add(routeKey);
    const states = reconciliation.filter((item) => item.domain === "route" &&
      item.static.some((ref) => ref.nodeId === route.id) && item.status === "corroborated")
      .flatMap((item) => item.runtime.map((ref) => ref.stateId).filter((id): id is string => Boolean(id)))
      .map((id) => runtime.nodes.find((state) => state.id === id)).filter((state): state is RuntimeStateNode => Boolean(state));
    const uniqueStates = uniqueBy(states, (state) => state.id);
    uniqueStates.forEach((state) => assignedStates.add(state.id));
    if (uniqueStates.length <= 1) seeds.push({ rootType: "static-route", rootId: route.id, route, states: uniqueStates });
    else if (routeKey.includes(":")) {
      const groups = new Map<string, RuntimeStateNode[]>();
      for (const state of uniqueStates) {
        const selected = selectedRouteResult(route.id, state.id, reconciliation);
        const key = selected ? routeStructureKey(routeKey, selected.route?.normalizedApplicationPath ?? runtimeRoute(state.url)) : state.id;
        groups.set(key, [...(groups.get(key) ?? []), state]);
      }
      for (const [identityKey, states] of groups) seeds.push({ rootType: "static-route",
        rootId: `${route.id}|${identityKey}`, route, states, identityKey });
    } else for (const state of uniqueStates) seeds.push({ rootType: "static-route", rootId: `${route.id}|${state.id}`, route, states: [state] });
  }
  for (const navigation of graph.nodes.filter((item) => item.type === "navigation" && staticValue(item.data.label))) {
    if (outgoing(graph, navigation.id, "NAVIGATES_TO").length > 0) continue;
    const destination = staticValue(navigation.data.destination);
    const states = destination ? runtime.nodes.filter((state) => runtimeRoute(state.url) === normalizeRoute(destination)) : [];
    states.forEach((state) => assignedStates.add(state.id));
    seeds.push({ rootType: "static-navigation", rootId: navigation.id, navigation, states });
  }
  for (const state of runtime.nodes.filter((item) => !assignedStates.has(item.id) && meaningfulRuntimeState(item))) {
    seeds.push({ rootType: "runtime-state", rootId: state.id, states: [state] });
  }
  return seeds;
}

function buildFeature(seed: FeatureSeed, input: BuildFeatureModelInput,
  reconciliation: ReconciledEvidenceResult[]): FeatureCandidate {
  const routeId = seed.route?.id;
  const componentIds = routeId ? outgoing(input.staticGraph, routeId, "ROUTE_RENDERS_COMPONENT").map((edge) => edge.to) : [];
  const uiIds = componentIds.flatMap((id) => outgoing(input.staticGraph, id, "CONTAINS_ELEMENT").map((edge) => edge.to));
  const eventIds = uiIds.flatMap((id) => outgoing(input.staticGraph, id, "HAS_EVENT").map((edge) => edge.to));
  const directCallableIds = eventIds.flatMap((id) => outgoing(input.staticGraph, id, "BINDS_TO").map((edge) => edge.to));
  const callableIds = callableClosure(input.staticGraph, directCallableIds);
  const httpIds = callableIds.flatMap((id) => outgoing(input.staticGraph, id, "PERFORMS_HTTP_REQUEST").map((edge) => edge.to));
  const graphqlExecutionIds = callableIds.flatMap((id) => outgoing(input.staticGraph, id, "PERFORMS_GRAPHQL_EXECUTION").map((edge) => edge.to));
  const graphqlIds = unique([...graphqlExecutionIds, ...graphqlExecutionIds.flatMap((id) =>
    outgoing(input.staticGraph, id).filter((edge) => edge.type === "USES_DOCUMENT" || edge.type === "EXECUTES_OPERATION").map((edge) => edge.to))]);
  const navigationNodes = seed.navigation ? [seed.navigation] : routeId ? incoming(input.staticGraph, routeId, "NAVIGATES_TO")
    .map((edge) => input.staticGraph.nodes.find((node) => node.id === edge.from)).filter(isNode) : [];
  const transitionIds = input.runtimeDiscovery.transitions.filter((edge) =>
    seed.states.some((state) => edge.to === state.id || edge.from === state.id)).map((edge) => edge.id);
  const relevantNodeIds = unique([...(routeId ? [routeId] : []), ...navigationNodes.map((node) => node.id),
    ...componentIds, ...uiIds, ...eventIds, ...callableIds, ...httpIds, ...graphqlIds]);
  const relevantResults = reconciliation.filter((result) => result.status !== "ambiguous" &&
    (result.static.some((ref) => relevantNodeIds.includes(ref.nodeId)) ||
    result.runtime.some((ref) => seed.states.some((state) => ref.stateId === state.id) ||
      Boolean(ref.transitionId && transitionIds.includes(ref.transitionId)))));
  const routeIdentity = buildRouteIdentity(seed, reconciliation);
  const name = chooseName(seed, navigationNodes, input.staticGraph, uiIds, eventIds, routeIdentity);
  const id = `feature:${stableHash(JSON.stringify({ root: seed.rootType,
    route: seed.route ? normalizedRoute(seed.route) : staticValue(seed.navigation?.data.destination) ?? "",
    state: seed.identityKey ? seed.identityKey : seed.rootType === "runtime-state" || seed.rootId !== seed.route?.id
      ? seed.states.map((item) => item.fingerprint).sort() : [] }))}`;
  const routes = seed.route ? [evidenceItem(seed.route, "route", relevantResults)] : [];
  const ui = uiIds.map((nodeId) => evidenceItem(node(input.staticGraph, nodeId), "ui", relevantResults));
  for (const state of seed.states) {
    for (const element of state.semanticElements) if (!ui.some((item) => item.runtime.some((ref) => ref.elementId === element.id))) {
      const result = relevantResults.find((item) => item.runtime.some((ref) => ref.stateId === state.id && ref.elementId === element.id));
      ui.push(runtimeItem("ui", element.id, element.accessibleName || element.visibleText || element.type, state.id,
        { elementId: element.id }, result));
    }
    for (const candidate of state.interactionCandidates) if (!ui.some((item) => item.runtime.some((ref) => ref.candidateId === candidate.id))) {
      const result = relevantResults.find((item) => item.runtime.some((ref) => ref.stateId === state.id && ref.candidateId === candidate.id));
      ui.push(runtimeItem("ui", candidate.id, candidate.accessibleName || candidate.text || candidate.tag, state.id,
        { candidateId: candidate.id }, result));
    }
  }
  const actions = [...eventIds.map((nodeId) => evidenceItem(node(input.staticGraph, nodeId), "action", relevantResults)),
    ...callableIds.map((nodeId) => evidenceItem(node(input.staticGraph, nodeId), "callable", relevantResults))];
  const api = httpIds.map((nodeId) => evidenceItem(node(input.staticGraph, nodeId), "http", relevantResults));
  const graphql = graphqlIds.map((nodeId) => evidenceItem(node(input.staticGraph, nodeId), "graphql", relevantResults));
  const staticEdges = input.staticGraph.edges.filter((edge) => relevantNodeIds.includes(edge.from) && relevantNodeIds.includes(edge.to));
  const reconciliationIds = unique(relevantResults.map((item) => item.id));
  const statuses = unique(relevantResults.map((item) => item.status)).sort() as ReconciliationStatus[];
  const screenshots = seed.states.filter((state) => state.screenshot.captured).map((state) => ({ runtimeStateId: state.id,
    path: state.screenshot.path, width: state.screenshot.width, height: state.screenshot.height, captured: true }));
  return {
    id, name: name.name, nameSource: name.source, ...(routeIdentity ? { routeIdentity } : {}),
    root: { type: seed.rootType, evidenceId: seed.rootId },
    entryPoints: entryPoints(navigationNodes, seed.states, input.runtimeDiscovery), routes,
    runtimeStates: seed.states.map((state) => state.id).sort(), ui: ui.sort(compareItem), actions: actions.sort(compareItem),
    api: api.sort(compareItem), graphql: graphql.sort(compareItem), screenshots,
    evidenceStatus: { static: relevantNodeIds.length > 0, runtime: seed.states.length > 0,
      reconciliation: statuses, screenshot: screenshots.length > 0, api: api.length > 0 || graphql.length > 0 },
    provenance: { staticNodeIds: relevantNodeIds.sort(), staticEdgeIds: staticEdges.map((edge) => edge.id).sort(),
      runtimeStateIds: seed.states.map((state) => state.id).sort(), runtimeTransitionIds: transitionIds.sort(),
      reconciliationResultIds: reconciliationIds.sort() },
  };
}

function chooseName(seed: FeatureSeed, navigation: ProductEvidenceNode[], graph: ProductEvidenceGraph,
  uiIds: string[], eventIds: string[], routeIdentity?: FeatureRouteIdentity): { name: string; source: FeatureNameSource } {
  const nav = navigation.find((item) => staticValue(item.data.label));
  if (nav) return named(staticValue(nav.data.label)!, "navigation-label", nav.id);
  const actionUi = uiIds.map((id) => node(graph, id)).find((item) =>
    outgoing(graph, item.id, "HAS_EVENT").some((edge) => eventIds.includes(edge.to)) && displayLabel(item));
  if (actionUi) return named(displayLabel(actionUi)!, "primary-action", actionUi.id);
  const staticHeading = uiIds.map((id) => node(graph, id)).find((item) => headingNode(item) && displayLabel(item));
  if (staticHeading) return named(displayLabel(staticHeading)!, "static-heading", staticHeading.id);
  for (const state of seed.states) {
    const heading = state.semanticElements.find((item) => item.role === "heading" && (item.accessibleName || item.visibleText));
    if (heading) return named(heading.accessibleName || heading.visibleText!, "runtime-heading", heading.id);
  }
  const componentId = seed.route && outgoing(graph, seed.route.id, "ROUTE_RENDERS_COMPONENT")[0]?.to;
  if (componentId) return named(node(graph, componentId).label, "component", componentId);
  if (routeIdentity) return routeIdentityName(routeIdentity);
  if (seed.route) return named(routeName(normalizedRoute(seed.route)), "route-segment", seed.route.id);
  const state = seed.states[0]!;
  const runtimeName = state.semanticElements.find((item) => item.accessibleName || item.visibleText) ?? state.interactionCandidates[0];
  const label = runtimeName && "type" in runtimeName
    ? runtimeName.accessibleName || runtimeName.visibleText || runtimeName.type
    : runtimeName?.accessibleName || runtimeName?.text || state.title;
  return named(label, "runtime-name", runtimeName?.id ?? state.id);
}

function evidenceItem(item: ProductEvidenceNode, kind: FeatureEvidenceItem["kind"],
  results: ReconciledEvidenceResult[]): FeatureEvidenceItem {
  const matched = results.filter((result) => result.static.some((ref) => ref.nodeId === item.id));
  return { id: `feature-evidence:${stableHash(`${kind}|${item.id}`)}`, kind, label: displayLabel(item) || item.label,
    status: evidenceStatus(matched), static: [{ nodeId: item.id }], runtime: matched.flatMap((result) =>
      result.runtime.map((ref) => ({ ...(ref.stateId ? { stateId: ref.stateId } : {}),
        ...(ref.transitionId ? { transitionId: ref.transitionId } : {}), ...(ref.elementId ? { elementId: ref.elementId } : {}),
        ...(ref.candidateId ? { candidateId: ref.candidateId } : {}),
        ...(ref.networkObservationId ? { networkObservationId: ref.networkObservationId } : {}) }))),
    reconciliationIds: matched.map((result) => result.id) };
}

function runtimeItem(kind: FeatureEvidenceItem["kind"], evidenceId: string, label: string, stateId: string,
  ref: Partial<FeatureRuntimeReference>, result?: ReconciledEvidenceResult): FeatureEvidenceItem {
  return { id: `feature-evidence:${stableHash(`${kind}|${stateId}|${evidenceId}`)}`, kind, label,
    status: result?.status ?? "runtime", static: [], runtime: [{ stateId, ...ref }],
    reconciliationIds: result ? [result.id] : [] };
}

function buildRelationships(features: FeatureCandidate[], graph: ProductEvidenceGraph,
  runtime: RuntimeNavigationDiscoveryGraph): FeatureRelationship[] {
  const result: FeatureRelationship[] = [];
  const byRouteNode = new Map(features.flatMap((feature) => feature.routes.flatMap((route) =>
    route.static.flatMap((ref) => ref.nodeId ? [[ref.nodeId, feature] as const] : []))));
  for (const edge of graph.edges.filter((item) => item.type === "NAVIGATES_TO")) {
    const target = byRouteNode.get(edge.to); if (!target) continue;
    const sourceNavigation = node(graph, edge.from);
    const source = features.find((feature) => feature.provenance.staticNodeIds.includes(sourceNavigation.id)) ??
      features.find((feature) => feature.runtimeStates.some((stateId) => runtime.transitions.some((transition) =>
        transition.from === stateId && transition.to && target.runtimeStates.includes(transition.to))));
    if (source && source.id !== target.id) result.push(relationship("navigation-to", source.id, target.id, edge.id));
  }
  for (const edge of runtime.transitions.filter((item) => item.to)) {
    const from = features.find((feature) => feature.runtimeStates.includes(edge.from));
    const to = features.find((feature) => feature.runtimeStates.includes(edge.to!));
    if (from && to && from.id !== to.id) result.push(relationship("runtime-transition-to", from.id, to.id, undefined, edge.id));
  }
  return uniqueBy(result, (item) => item.id).sort((a, b) => a.id.localeCompare(b.id));
}

function collectUnassigned(features: FeatureCandidate[], relationships: FeatureRelationship[], input: BuildFeatureModelInput,
  reconciliation: ReconciledEvidenceResult[]): UnassignedFeatureEvidence[] {
  const nodes = new Set(features.flatMap((item) => item.provenance.staticNodeIds));
  const edges = new Set(features.flatMap((item) => item.provenance.staticEdgeIds));
  const states = new Set(features.flatMap((item) => item.runtimeStates));
  const transitions = new Set(features.flatMap((item) => item.provenance.runtimeTransitionIds));
  const results = new Set(features.flatMap((item) => item.provenance.reconciliationResultIds));
  const output: UnassignedFeatureEvidence[] = [];
  for (const item of input.staticGraph.nodes.filter((item) => !nodes.has(item.id))) output.push(unassigned("static-node", item.id,
    USER_FACING_NODE_TYPES.has(item.type) ? "no-deterministic-feature-context" : "internal-evidence-without-feature-root"));
  for (const item of input.staticGraph.edges.filter((item) => !edges.has(item.id))) output.push(unassigned("static-edge", item.id,
    "edge-not-contained-by-feature-context"));
  for (const item of input.runtimeDiscovery.nodes.filter((item) => !states.has(item.id))) output.push(unassigned("runtime-state", item.id,
    "runtime-state-without-meaningful-user-facing-root"));
  for (const item of input.runtimeDiscovery.transitions.filter((item) => !transitions.has(item.id) &&
    !relationships.some((relationship) => relationship.runtimeTransitionId === item.id))) output.push(unassigned("runtime-transition", item.id,
    "transition-not-associated-with-feature"));
  for (const item of reconciliation.filter((item) => !results.has(item.id))) output.push({ ...unassigned("reconciliation", item.id,
    item.status === "ambiguous" ? "ambiguous-evidence-not-force-assigned" : "evidence-not-related-to-feature"), status: item.status });
  return output.sort((a, b) => `${a.kind}|${a.evidenceId}`.localeCompare(`${b.kind}|${b.evidenceId}`));
}

export function validateFeatureModel(model: FeatureModel, graph: ProductEvidenceGraph,
  runtime: RuntimeNavigationDiscoveryGraph, reconciliation: ReconciliationManifest): void {
  assertUnique(model.features.map((item) => item.id), "feature");
  assertUnique(model.relationships.map((item) => item.id), "feature relationship");
  const nodeIds = new Set(graph.nodes.map((item) => item.id));
  const edgeIds = new Set(graph.edges.map((item) => item.id));
  const stateIds = new Set(runtime.nodes.map((item) => item.id));
  const transitionIds = new Set(runtime.transitions.map((item) => item.id));
  const reconciliationIds = new Set(reconciliationResults(reconciliation).map((item) => item.id));
  for (const feature of model.features) {
    if (!feature.name.trim()) throw new Error(`Invalid feature name for ${feature.id}`);
    if (!validNameSource(feature, nodeIds, stateIds, runtime)) throw new Error(`Invalid name source for ${feature.id}`);
    if (feature.routeIdentity) {
      if (!feature.routes.some((item) => item.label === feature.routeIdentity!.staticRoutePattern)) {
        throw new Error(`Invalid route identity pattern for ${feature.id}`);
      }
      for (const id of feature.routeIdentity.selectedReconciliationIds) if (!reconciliationIds.has(id)) {
        throw new Error(`Invalid route identity reconciliation ${id}`);
      }
      for (const binding of feature.routeIdentity.bindings) {
        if (!feature.runtimeStates.includes(binding.runtimeStateId)) throw new Error(`Invalid route binding state ${binding.runtimeStateId}`);
        if (binding.classification !== "stable-slug" && binding.value !== undefined) {
          throw new Error(`Sensitive route binding value retained for ${feature.id}`);
        }
      }
    }
    for (const id of feature.provenance.staticNodeIds) if (!nodeIds.has(id)) throw new Error(`Invalid static reference ${id}`);
    for (const id of feature.provenance.staticEdgeIds) if (!edgeIds.has(id)) throw new Error(`Invalid static edge reference ${id}`);
    for (const id of feature.runtimeStates) if (!stateIds.has(id)) throw new Error(`Invalid runtime reference ${id}`);
    for (const id of feature.provenance.runtimeTransitionIds) if (!transitionIds.has(id)) throw new Error(`Invalid runtime transition ${id}`);
    for (const id of feature.provenance.reconciliationResultIds) if (!reconciliationIds.has(id)) {
      throw new Error(`Invalid reconciliation reference ${id}`);
    }
    for (const entry of feature.entryPoints) {
      if (entry.staticNodeId && !nodeIds.has(entry.staticNodeId)) throw new Error(`Invalid static reference ${entry.staticNodeId}`);
      if (entry.transitionId && !transitionIds.has(entry.transitionId)) throw new Error(`Invalid runtime transition ${entry.transitionId}`);
    }
    for (const item of [...feature.routes, ...feature.ui, ...feature.actions, ...feature.api, ...feature.graphql]) {
      for (const ref of item.static) {
        if (ref.nodeId && !nodeIds.has(ref.nodeId)) throw new Error(`Invalid static reference ${ref.nodeId}`);
        if (ref.edgeId && !edgeIds.has(ref.edgeId)) throw new Error(`Invalid static edge reference ${ref.edgeId}`);
      }
      for (const ref of item.runtime) {
        if (ref.stateId && !stateIds.has(ref.stateId)) throw new Error(`Invalid runtime reference ${ref.stateId}`);
        if (ref.transitionId && !transitionIds.has(ref.transitionId)) throw new Error(`Invalid runtime transition ${ref.transitionId}`);
      }
      for (const id of item.reconciliationIds) if (!reconciliationIds.has(id)) {
        throw new Error(`Invalid reconciliation reference ${id}`);
      }
    }
    for (const screenshot of feature.screenshots) {
      const state = runtime.nodes.find((item) => item.id === screenshot.runtimeStateId);
      if (!state || !feature.runtimeStates.includes(state.id) || state.screenshot.path !== screenshot.path) {
        throw new Error(`Invalid screenshot/state association ${screenshot.runtimeStateId}`);
      }
    }
  }
  for (const relationship of model.relationships) {
    if (!model.features.some((item) => item.id === relationship.fromFeatureId) ||
      !model.features.some((item) => item.id === relationship.toFeatureId)) throw new Error(`Invalid feature relationship ${relationship.id}`);
    if (relationship.staticEdgeId && !edgeIds.has(relationship.staticEdgeId)) throw new Error(`Invalid static edge reference ${relationship.staticEdgeId}`);
    if (relationship.runtimeTransitionId && !transitionIds.has(relationship.runtimeTransitionId)) {
      throw new Error(`Invalid runtime transition ${relationship.runtimeTransitionId}`);
    }
  }
}

export function getFeature(model: FeatureModel, featureId: string): FeatureCandidate | undefined {
  return model.features.find((item) => item.id === featureId);
}

export function getFeaturesByRoute(model: FeatureModel, route: string): FeatureCandidate[] {
  const normalized = normalizeRoute(route);
  return model.features.filter((feature) => feature.routes.some((item) => normalizeRoute(item.label) === normalized));
}

export function getFeaturesByEvidenceStatus(model: FeatureModel,
  status: "static-only" | "runtime-only" | "static-and-runtime" | ReconciliationStatus): FeatureCandidate[] {
  return model.features.filter((feature) => status === "static-only" ? feature.evidenceStatus.static && !feature.evidenceStatus.runtime :
    status === "runtime-only" ? feature.evidenceStatus.runtime && !feature.evidenceStatus.static :
      status === "static-and-runtime" ? feature.evidenceStatus.static && feature.evidenceStatus.runtime :
        feature.evidenceStatus.reconciliation.includes(status));
}

export function formatFeatureModel(model: FeatureModel): string {
  const lines: string[] = [];
  for (const feature of model.features) {
    lines.push(`FEATURE: ${feature.name}`, "", "ENTRY POINT");
    lines.push(...(feature.entryPoints.length ? feature.entryPoints.map((item) =>
      `${item.label}${item.destination ? ` -> ${item.destination}` : ""}`) : ["none"]));
    if (feature.routes.length) lines.push("", "ROUTE", ...feature.routes.map((item) => `${item.label} - ${item.status}`));
    if (feature.ui.length) lines.push("", "UI", ...feature.ui.map((item) => `${item.label} - ${item.status}`));
    if (feature.actions.length) lines.push("", "ACTION", ...feature.actions.map((item) => item.label));
    if (feature.api.length) lines.push("", "API", ...feature.api.map((item) => `${item.label} - ${item.status}`));
    if (feature.graphql.length) lines.push("", "GRAPHQL", ...feature.graphql.map((item) => `${item.label} - ${item.status}`));
    lines.push("", "RUNTIME", ...(feature.runtimeStates.length ? feature.runtimeStates : ["not observed"]), "", "SCREENSHOT",
      feature.screenshots.length ? "available" : "not available", "");
  }
  return lines.join("\n").trimEnd();
}

function entryPoints(navigation: ProductEvidenceNode[], states: RuntimeStateNode[], runtime: RuntimeNavigationDiscoveryGraph): FeatureEntryPoint[] {
  const items: FeatureEntryPoint[] = navigation.map((item) => {
    const destination = staticValue(item.data.destination);
    return { id: `entry:${item.id}`, label: staticValue(item.data.label) || item.label,
      ...(destination ? { destination } : {}), staticNodeId: item.id };
  });
  for (const edge of runtime.transitions.filter((item) => item.to && states.some((state) => state.id === item.to))) {
    const label = transitionLabel(edge); if (!label) continue;
    const destination = edge.transition?.afterUrl;
    items.push({ id: `entry:${edge.id}`, label, ...(destination ? { destination } : {}), transitionId: edge.id });
  }
  return uniqueBy(items, (item) => item.id).sort((a, b) => a.id.localeCompare(b.id));
}

function relationship(type: FeatureRelationship["type"], from: string, to: string, staticEdgeId?: string,
  runtimeTransitionId?: string): FeatureRelationship {
  return { id: `feature-relationship:${stableHash([type, from, to, staticEdgeId, runtimeTransitionId].join("|"))}`,
    type, fromFeatureId: from, toFeatureId: to, ...(staticEdgeId ? { staticEdgeId } : {}),
    ...(runtimeTransitionId ? { runtimeTransitionId } : {}) };
}

function callableClosure(graph: ProductEvidenceGraph, roots: string[]): string[] {
  const visited = new Set<string>(); const queue = [...roots];
  while (queue.length) { const id = queue.shift()!; if (visited.has(id)) continue; visited.add(id);
    queue.push(...outgoing(graph, id, "CALLS").map((edge) => edge.to)); }
  return [...visited];
}

function meaningfulRuntimeState(state: RuntimeStateNode): boolean {
  return state.semanticElements.some((item) => Boolean(item.accessibleName || item.visibleText)) ||
    state.interactionCandidates.some((item) => Boolean(item.accessibleName || item.text));
}

function buildRouteIdentity(seed: FeatureSeed, reconciliation: ReconciledEvidenceResult[]): FeatureRouteIdentity | undefined {
  if (!seed.route || seed.states.length === 0) return undefined;
  const pattern = normalizedRoute(seed.route);
  const selected = seed.states.map((state) => ({ state, result: selectedRouteResult(seed.route!.id, state.id, reconciliation) }))
    .filter((item): item is { state: RuntimeStateNode; result: ReconciledEvidenceResult } => Boolean(item.result?.route));
  if (selected.length !== seed.states.length) return undefined;
  const bindings = selected.flatMap(({ state, result }) => routeBindings(pattern,
    result.route!.normalizedApplicationPath, state.id));
  const paths = selected.map(({ result }) => sanitizedRuntimePath(pattern, result.route!.normalizedApplicationPath));
  return { selectedReconciliationIds: selected.map(({ result }) => result.id).sort(), staticRoutePattern: pattern,
    runtimePaths: unique(paths).sort(), bindings, identityKey: seed.identityKey ?? routeStructureKey(pattern,
      selected[0]!.result.route!.normalizedApplicationPath) };
}

function selectedRouteResult(routeId: string, stateId: string,
  reconciliation: ReconciledEvidenceResult[]): ReconciledEvidenceResult | undefined {
  return reconciliation.find((item) => item.domain === "route" && item.status === "corroborated" &&
    item.static.length === 1 && item.static[0]?.nodeId === routeId &&
    item.runtime.some((ref) => ref.stateId === stateId) &&
    item.route?.candidates.some((candidate) => candidate.staticRouteId === routeId && candidate.selection === "selected"));
}

function routeBindings(pattern: string, runtimePath: string, stateId: string): FeatureRouteBinding[] {
  const patternSegments = pathSegments(pattern);
  const runtimeSegments = pathSegments(runtimePath);
  return patternSegments.flatMap((segment, position) => {
    if (!segment.startsWith(":")) return [];
    const raw = runtimeSegments[position];
    if (!raw) return [];
    const classification = classifyRouteValue(raw);
    return [{ runtimeStateId: stateId, parameter: segment.replace(/^:/, "").replace(/[?*+]$/, ""), position,
      classification, ...(classification === "stable-slug" ? { value: raw } : {}) }];
  });
}

function routeIdentityName(identity: FeatureRouteIdentity): { name: string; source: FeatureNameSource } {
  if (identity.staticRoutePattern === "/") {
    return named("Root", "route-literal", identity.selectedReconciliationIds[0]!);
  }
  const literals = pathSegments(identity.staticRoutePattern).filter((segment) => !segment.startsWith(":") && segment !== "*");
  const values = unique(identity.bindings.filter((binding) => binding.classification === "stable-slug" && binding.value)
    .map((binding) => binding.value!));
  const evidenceId = identity.selectedReconciliationIds[0]!;
  if (literals.length > 0) {
    const parts = compactIdentityParts([...literals, ...values]);
    return named(parts.map(humanizeRouteSegment).join(" / "), values.length ? "route-bound-value" : "route-literal", evidenceId);
  }
  if (values.length > 0) {
    const parts = compactIdentityParts(values);
    return named(parts.map(humanizeRouteSegment).join(" / "), parts.length > 1 ? "runtime-route-structure" : "route-bound-value", evidenceId);
  }
  return named(identity.staticRoutePattern, "route-pattern", evidenceId);
}

function compactIdentityParts(parts: string[]): string[] {
  const distinct = unique(parts);
  return distinct.length <= 2 ? distinct : [distinct[0]!, distinct.at(-1)!];
}

function routeStructureKey(pattern: string, runtimePath: string): string {
  const patternSegments = pathSegments(pattern);
  const runtimeSegments = pathSegments(runtimePath);
  const segments = runtimeSegments.map((segment, index) => {
    const patternSegment = patternSegments[index];
    if (!patternSegment?.startsWith(":")) return segment;
    return classifyRouteValue(segment) === "stable-slug" ? segment.toLowerCase() : ":opaque";
  });
  return `${pattern}|/${segments.join("/")}`;
}

function sanitizedRuntimePath(pattern: string, runtimePath: string): string {
  const patternSegments = pathSegments(pattern);
  return `/${pathSegments(runtimePath).map((segment, index) => patternSegments[index]?.startsWith(":") &&
    classifyRouteValue(segment) !== "stable-slug" ? "[opaque]" : segment).join("/")}`;
}

function classifyRouteValue(value: string): FeatureRouteBindingClassification {
  const decoded = decodeURIComponentSafe(value);
  if (/redact|masked|hidden|^\*+$/i.test(decoded) || /^\[[^\]]+\]$/.test(decoded)) return "redacted";
  if (/^\d+$/.test(decoded) || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded) ||
    /^[0-9a-f]{16,}$/i.test(decoded) || (decoded.length >= 20 && /[a-z]/i.test(decoded) && /\d/.test(decoded) && /^[a-z0-9_-]+$/i.test(decoded))) {
    return "opaque-identifier";
  }
  return /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/i.test(decoded) && decoded.length <= 64
    ? "stable-slug" : "opaque-identifier";
}

function decodeURIComponentSafe(value: string): string { try { return decodeURIComponent(value); } catch { return value; } }
function pathSegments(value: string): string[] { return normalizeRoute(value).split("/").filter(Boolean); }
function humanizeRouteSegment(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
function named(name: string, type: FeatureNameSourceType, evidenceId: string) {
  return { name: name.trim(), source: { type, evidenceId } };
}
function headingNode(item: ProductEvidenceNode): boolean {
  const name = String(item.data.name ?? "").toLowerCase(); return /^h[1-6]$/.test(name) || name === "heading";
}
function displayLabel(item: ProductEvidenceNode): string {
  const props = Array.isArray(item.data.props) ? item.data.props as Array<Record<string, unknown>> : [];
  for (const name of ["aria-label", "placeholder"]) { const prop = props.find((value) => value.name === name && value.valueType === "string");
    if (typeof prop?.value === "string") return prop.value; }
  return /["']([^"']+)["']$/.exec(item.label)?.[1] ?? (item.type === "ui-element" ? "" : item.label);
}
function routeName(route: string): string {
  const segment = route.split("/").filter(Boolean).at(-1) ?? "Root";
  return segment.replace(/^:/, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (value) => value.toUpperCase());
}
function normalizedRoute(route: ProductEvidenceNode): string { return normalizeRoute(staticValue(route.data.path) ?? route.label); }
function normalizeRoute(value: string): string { const route = value.startsWith("/") ? value : `/${value}`; return route.length > 1 ? route.replace(/\/+$/, "") : route; }
function runtimeRoute(value: string): string { const url = new URL(value);
  return normalizeRoute(url.hash.startsWith("#/") ? url.hash.slice(1).split("?")[0]! : url.pathname); }
function staticValue(value: unknown): string | undefined { if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>; return item.kind === "static" && typeof item.value === "string" ? item.value : undefined; }
function transitionLabel(edge: RuntimeTransitionEdge): string { if (!edge.target) return "";
  return edge.target.source === "semantic-element" ? edge.target.accessibleName || edge.target.visibleText || "" : edge.target.accessibleName || edge.target.text; }
function evidenceStatus(results: ReconciledEvidenceResult[]): FeatureEvidenceItem["status"] {
  if (results.some((item) => item.status === "corroborated")) return "corroborated";
  if (results.some((item) => item.status === "ambiguous")) return "ambiguous";
  if (results.some((item) => item.status === "runtime-only")) return "runtime-only";
  if (results.some((item) => item.status === "static-only")) return "static-only";
  return "static";
}
function reconciliationResults(manifest: ReconciliationManifest): ReconciledEvidenceResult[] {
  return [...manifest.matches, ...manifest.staticOnly, ...manifest.runtimeOnly, ...manifest.ambiguous];
}
function node(graph: ProductEvidenceGraph, id: string): ProductEvidenceNode { const result = graph.nodes.find((item) => item.id === id);
  if (!result) throw new Error(`Missing static node ${id}`); return result; }
function isNode(value: ProductEvidenceNode | undefined): value is ProductEvidenceNode { return Boolean(value); }
function outgoing(graph: ProductEvidenceGraph, id: string, type?: ProductEvidenceEdge["type"]): ProductEvidenceEdge[] {
  return graph.edges.filter((edge) => edge.from === id && (!type || edge.type === type)); }
function incoming(graph: ProductEvidenceGraph, id: string, type?: ProductEvidenceEdge["type"]): ProductEvidenceEdge[] {
  return graph.edges.filter((edge) => edge.to === id && (!type || edge.type === type)); }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function uniqueBy<T>(values: T[], key: (value: T) => string): T[] { const seen = new Set<string>();
  return values.filter((value) => { const id = key(value); if (seen.has(id)) return false; seen.add(id); return true; }); }
function compareItem(a: FeatureEvidenceItem, b: FeatureEvidenceItem): number { return `${a.kind}|${a.label}|${a.id}`.localeCompare(`${b.kind}|${b.label}|${b.id}`); }
function compareFeature(a: FeatureCandidate, b: FeatureCandidate): number {
  const routeA = a.routes[0]?.label ?? "~"; const routeB = b.routes[0]?.label ?? "~";
  return `${routeA}|${a.name}|${a.id}`.localeCompare(`${routeB}|${b.name}|${b.id}`);
}
function unassigned(kind: UnassignedFeatureEvidence["kind"], evidenceId: string, reason: string): UnassignedFeatureEvidence {
  return { id: `unassigned:${stableHash(`${kind}|${evidenceId}|${reason}`)}`, kind, evidenceId, reason };
}
function summarize(features: FeatureCandidate[], relationships: FeatureRelationship[], unassignedEvidence: UnassignedFeatureEvidence[]): FeatureModelSummary {
  return { features: features.length, staticAndRuntime: features.filter((item) => item.evidenceStatus.static && item.evidenceStatus.runtime).length,
    staticOnly: features.filter((item) => item.evidenceStatus.static && !item.evidenceStatus.runtime).length,
    runtimeOnly: features.filter((item) => !item.evidenceStatus.static && item.evidenceStatus.runtime).length,
    relationships: relationships.length, unassignedEvidence: unassignedEvidence.length };
}
function validNameSource(feature: FeatureCandidate, nodes: Set<string>, states: Set<string>, runtime: RuntimeNavigationDiscoveryGraph): boolean {
  if (["navigation-label", "primary-action", "static-heading", "component", "route-segment"].includes(feature.nameSource.type)) {
    return nodes.has(feature.nameSource.evidenceId);
  }
  if (["route-literal", "route-bound-value", "runtime-route-structure", "route-pattern"].includes(feature.nameSource.type)) {
    return feature.routeIdentity?.selectedReconciliationIds.includes(feature.nameSource.evidenceId) ?? false;
  }
  if (states.has(feature.nameSource.evidenceId)) return true;
  return runtime.nodes.some((state) => state.semanticElements.some((item) => item.id === feature.nameSource.evidenceId) ||
    state.interactionCandidates.some((item) => item.id === feature.nameSource.evidenceId));
}
function assertSourcesMatch(input: BuildFeatureModelInput): void {
  if (!input.reconciliation.staticGraphId || !input.reconciliation.runtimeDiscoveryId) throw new Error("Reconciliation source IDs are required");
}
function assertUnique(values: string[], label: string): void { if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} ID`); }
