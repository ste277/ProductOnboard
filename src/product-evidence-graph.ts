import type { ActionBindingManifest } from "./action-binding-analyzer.js";
import type { FunctionCallManifest } from "./function-call-analyzer.js";
import type {
  GraphqlOperationManifest,
  GraphqlOperationType,
} from "./graphql-operation-analyzer.js";
import type { HttpRequestManifest } from "./http-request-analyzer.js";
import type { RepositoryInventory } from "./repository-scanner.js";
import type {
  ProjectSymbolResolutionManifest,
  SymbolResolution,
  UnresolvedSymbolResolution,
} from "./project-symbol-resolver.js";
import type { RouteNavigationManifest } from "./route-navigation-analyzer.js";
import type {
  SourceAnalysisManifest,
  SourceLocation,
} from "./source-analyzer.js";
import type {
  UiElementNode,
  UiNode,
  UiStructureManifest,
} from "./ui-structure-analyzer.js";

export type EvidenceSource =
  | "source-analysis"
  | "ui-structure"
  | "action-binding"
  | "route-navigation"
  | "function-call"
  | "http-request"
  | "graphql-operation"
  | "module-resolution";

export type EvidenceStrength = "direct" | "resolved" | "unresolved";

export interface GraphEvidence {
  source: EvidenceSource;
  strength: EvidenceStrength;
  location?: SourceLocation;
  details?: Record<string, unknown>;
}

export type ProductEvidenceNodeType =
  | "route"
  | "navigation"
  | "component"
  | "ui-element"
  | "ui-event"
  | "callable"
  | "http-request"
  | "graphql-document"
  | "graphql-operation"
  | "graphql-execution";

export interface ProductEvidenceNode {
  id: string;
  type: ProductEvidenceNodeType;
  label: string;
  location: SourceLocation;
  evidence: GraphEvidence[];
  data: Record<string, unknown>;
}

export type ProductEvidenceEdgeType =
  | "ROUTE_RENDERS_COMPONENT"
  | "NAVIGATES_TO"
  | "CONTAINS_ELEMENT"
  | "HAS_EVENT"
  | "BINDS_TO"
  | "CALLS"
  | "PERFORMS_HTTP_REQUEST"
  | "DEFINES_OPERATION"
  | "PERFORMS_GRAPHQL_EXECUTION"
  | "USES_DOCUMENT"
  | "EXECUTES_OPERATION";

export interface ProductEvidenceEdge {
  id: string;
  type: ProductEvidenceEdgeType;
  from: string;
  to: string;
  evidence: GraphEvidence[];
}

export interface UnresolvedRelationship {
  id: string;
  relationship: ProductEvidenceEdgeType;
  from?: string;
  reference: string;
  reason: string;
  evidence: GraphEvidence[];
}

export interface ProductEvidenceGraph {
  root: string;
  nodes: ProductEvidenceNode[];
  edges: ProductEvidenceEdge[];
  unresolved: UnresolvedRelationship[];
}

export interface ProductEvidenceGraphInput {
  inventory: RepositoryInventory;
  sources: SourceAnalysisManifest;
  ui: UiStructureManifest;
  actions: ActionBindingManifest;
  navigation: RouteNavigationManifest;
  calls: FunctionCallManifest;
  http: HttpRequestManifest;
  graphql: GraphqlOperationManifest;
  resolution?: ProjectSymbolResolutionManifest;
}

export interface EvidenceTraceStep {
  depth: number;
  node: ProductEvidenceNode;
  via?: ProductEvidenceEdge;
}

const EDGE_ENDPOINTS: Record<
  ProductEvidenceEdgeType,
  readonly [ProductEvidenceNodeType, ProductEvidenceNodeType]
> = {
  ROUTE_RENDERS_COMPONENT: ["route", "component"],
  NAVIGATES_TO: ["navigation", "route"],
  CONTAINS_ELEMENT: ["component", "ui-element"],
  HAS_EVENT: ["ui-element", "ui-event"],
  BINDS_TO: ["ui-event", "callable"],
  CALLS: ["callable", "callable"],
  PERFORMS_HTTP_REQUEST: ["callable", "http-request"],
  DEFINES_OPERATION: ["graphql-document", "graphql-operation"],
  PERFORMS_GRAPHQL_EXECUTION: ["callable", "graphql-execution"],
  USES_DOCUMENT: ["graphql-execution", "graphql-document"],
  EXECUTES_OPERATION: ["graphql-execution", "graphql-operation"],
};

export function buildProductEvidenceGraph(
  input: ProductEvidenceGraphInput,
): ProductEvidenceGraph {
  assertMatchingRoots(input);
  const graph: ProductEvidenceGraph = {
    root: input.inventory.root,
    nodes: [],
    edges: [],
    unresolved: [],
  };
  const ids = new IdFactory();
  const componentIds = new Map<string, string>();
  const elementIds = new Map<string, string>();
  const callableIds = new Map<string, string>();
  const routeIdsByPath = new Map<string, string[]>();
  const documentIds = new Map<string, string>();
  const operationIds = new Map<string, string[]>();

  for (const component of input.ui.components) {
    const id = ids.node("component", locationKey(component.location), component.name);
    addNode(graph, id, "component", component.name, component.location, "ui-structure", {
      name: component.name,
      exportStatus: component.exportStatus,
    });
    componentIds.set(componentKey(component.name, component.location), id);
    addUiTree(graph, ids, component.name, component.root, id, elementIds);
  }

  for (const callable of input.calls.callers) {
    const id = `callable:${callable.id}`;
    addNode(graph, id, "callable", callable.name, callable.location, "function-call", {
      callableId: callable.id,
      name: callable.name,
      kind: callable.kind,
      async: callable.async,
      ...(callable.parentId ? { parentId: callable.parentId } : {}),
    });
    callableIds.set(callable.id, id);
  }

  for (const route of input.navigation.routes) {
    const label = route.path.kind === "static" ? route.path.value : route.path.expression;
    const id = ids.node("route", locationKey(route.location), `${route.source}:${label}`);
    addNode(graph, id, "route", label, route.location, "route-navigation", {
      source: route.source,
      path: route.path,
      declaredPath: route.declaredPath,
      ...(route.parent ? { parent: route.parent } : {}),
      ...(route.component ? { component: route.component } : {}),
    });
    if (route.path.kind === "static") {
      const matches = routeIdsByPath.get(route.path.value) ?? [];
      matches.push(id);
      routeIdsByPath.set(route.path.value, matches);
    }
    if (route.component && route.componentLocation) {
      let componentId = resolveComponent(
        input.ui,
        componentIds,
        route.component,
        route.componentLocation,
      );
      const symbol = input.resolution && findImportResolution(
        input.resolution,
        route.location.path,
        route.component,
      );
      if (!componentId && symbol) {
        componentId = resolveComponentTarget(input.ui, componentIds, symbol);
      }
      if (componentId) {
        addEdge(graph, ids, "ROUTE_RENDERS_COMPONENT", id, componentId, [{
          source: "route-navigation",
          strength: "resolved",
          location: route.componentLocation,
        }, ...(symbol ? resolutionEvidence(symbol) : [])]);
      } else {
        const failure = input.resolution && findUnresolvedImport(
          input.resolution,
          route.location.path,
          route.component,
        );
        addUnresolved(graph, ids, "ROUTE_RENDERS_COMPONENT", id, route.component,
          failure ? `Module resolution failed: ${failure.reason}` :
            "Associated route component is not a same-file UI component", "route-navigation",
          route.componentLocation);
      }
    }
  }

  for (const navigation of input.navigation.navigation) {
    const label = navigation.label.kind === "static"
      ? navigation.label.value
      : navigation.label.expression;
    const destination = navigation.destination.kind === "static"
      ? navigation.destination.value
      : navigation.destination.expression;
    const id = ids.node("navigation", locationKey(navigation.location), `${navigation.element}:${destination}`);
    addNode(graph, id, "navigation", label || navigation.element, navigation.location,
      "route-navigation", {
        component: navigation.component,
        element: navigation.element,
        label: navigation.label,
        destination: navigation.destination,
      });
    if (navigation.destination.kind === "dynamic") {
      addUnresolved(graph, ids, "NAVIGATES_TO", id, destination,
        "Navigation destination is dynamic", "route-navigation",
        navigation.destinationLocation);
      continue;
    }
    const routes = routeIdsByPath.get(navigation.destination.value) ?? [];
    if (routes.length === 1) {
      addEdge(graph, ids, "NAVIGATES_TO", id, routes[0]!, {
        source: "route-navigation",
        strength: "resolved",
        location: navigation.destinationLocation,
      });
    } else {
      addUnresolved(graph, ids, "NAVIGATES_TO", id, navigation.destination.value,
        routes.length === 0 ? "No discovered route has this path" : "Multiple routes have this path",
        "route-navigation", navigation.destinationLocation);
    }
  }

  for (const action of input.actions.actions) {
    const elementId = elementIds.get(elementKey(action.component, action.element.location));
    if (!elementId) continue;
    const eventId = ids.node("ui-event", locationKey(action.eventLocation), action.event);
    addNode(graph, eventId, "ui-event", action.event, action.eventLocation, "action-binding", {
      event: action.event,
      bindingType: action.bindingType,
    });
    addEdge(graph, ids, "HAS_EVENT", elementId, eventId, {
      source: "action-binding",
      strength: "direct",
      location: action.eventLocation,
    });

    if (action.bindingType === "local") {
      const callable = findCallableByLocation(
        input.calls,
        action.handler.name,
        action.handler.location,
      );
      if (callable) {
        addEdge(graph, ids, "BINDS_TO", eventId, callableIds.get(callable.id)!, {
          source: "action-binding",
          strength: "resolved",
          location: action.handler.location,
        });
      } else {
        addUnresolved(graph, ids, "BINDS_TO", eventId, action.handler.name,
          "Local handler has no matching callable identity", "action-binding",
          action.handler.location);
      }
    } else if (action.bindingType === "inline") {
      const callable = findCallableByLocation(
        input.calls,
        "<inline-callback>",
        action.handler.location,
      );
      if (callable) {
        addEdge(graph, ids, "BINDS_TO", eventId, callableIds.get(callable.id)!, {
          source: "action-binding",
          strength: "resolved",
          location: action.handler.location,
        });
      } else {
        addUnresolved(graph, ids, "BINDS_TO", eventId, action.handler.expression,
          "Inline handler has no matching callable identity", "action-binding",
          action.handler.location);
      }
    } else {
      if (action.bindingType === "imported" && input.resolution) {
        const symbol = findImportResolution(
          input.resolution,
          action.eventLocation.path,
          action.handler.name,
          action.handler.source,
        );
        const callableId = symbol?.target.kind === "callable"
          ? callableIds.get(symbol.target.id)
          : undefined;
        if (symbol && callableId) {
          addEdge(graph, ids, "BINDS_TO", eventId, callableId, [{
            source: "action-binding",
            strength: "resolved",
            location: action.eventLocation,
          }, ...resolutionEvidence(symbol)]);
          continue;
        }
        const failure = findUnresolvedImport(
          input.resolution,
          action.eventLocation.path,
          action.handler.name,
          action.handler.source,
        );
        addUnresolved(graph, ids, "BINDS_TO", eventId,
          `${action.handler.name} from ${action.handler.source}`,
          failure ? `Module resolution failed: ${failure.reason}` :
            "Imported handler did not resolve to a callable",
          "module-resolution", action.eventLocation);
      } else {
        const reference = action.bindingType === "imported"
          ? `${action.handler.name} from ${action.handler.source}`
          : action.expression;
        addUnresolved(graph, ids, "BINDS_TO", eventId, reference,
          `Handler binding is ${action.bindingType}`, "action-binding", action.eventLocation);
      }
    }
  }

  for (const caller of input.calls.callers) {
    const from = callableIds.get(caller.id)!;
    for (const call of caller.calls) {
      if (call.bindingType === "local" && callableIds.has(call.callee.id)) {
        addEdge(graph, ids, "CALLS", from, callableIds.get(call.callee.id)!, {
          source: "function-call",
          strength: "direct",
          location: call.location,
        });
      } else if (call.bindingType === "imported" && input.resolution) {
        const symbol = findImportResolution(
          input.resolution,
          call.location.path,
          call.localName,
          call.source,
        );
        const target = symbol?.target.kind === "callable"
          ? callableIds.get(symbol.target.id)
          : undefined;
        if (symbol && target) {
          addEdge(graph, ids, "CALLS", from, target, [{
            source: "function-call",
            strength: "direct",
            location: call.location,
          }, ...resolutionEvidence(symbol)]);
        } else {
          const failure = findUnresolvedImport(
            input.resolution,
            call.location.path,
            call.localName,
            call.source,
          );
          addUnresolved(graph, ids, "CALLS", from,
            `${call.localName} from ${call.source}`,
            failure ? `Module resolution failed: ${failure.reason}` :
              "Imported call did not resolve to a callable",
            "module-resolution", call.location);
        }
      } else if (call.bindingType === "member-expression" && input.resolution) {
        const symbol = findNamespaceResolution(input.resolution, call.location);
        const target = symbol?.target.kind === "callable"
          ? callableIds.get(symbol.target.id)
          : undefined;
        if (symbol && target) {
          addEdge(graph, ids, "CALLS", from, target, [{
            source: "function-call",
            strength: "direct",
            location: call.location,
          }, ...resolutionEvidence(symbol)]);
        } else {
          addUnresolved(graph, ids, "CALLS", from, call.expression,
            "Member call could not be resolved as a local namespace import",
            "module-resolution", call.location);
        }
      } else if (call.bindingType !== "local") {
        const reference = call.bindingType === "imported"
          ? `${call.localName} from ${call.source}`
          : call.expression;
        addUnresolved(graph, ids, "CALLS", from, reference,
          `Call binding is ${call.bindingType}`, "function-call", call.location);
      }
    }
  }

  for (const request of input.http.requests) {
    const method = request.method.kind === "static" ? request.method.value : request.method.expression;
    const url = request.effectiveUrl?.value ??
      (request.url.kind === "static" ? request.url.value : request.url.expression);
    const id = ids.node("http-request", locationKey(request.location), `${method}:${url}`);
    addNode(graph, id, "http-request", `${method} ${url}`, request.location, "http-request", {
      method: request.method,
      url: request.url,
      ...(request.effectiveUrl ? { effectiveUrl: request.effectiveUrl } : {}),
      client: request.client,
      scope: request.scope,
    });
    if (request.caller && callableIds.has(request.caller.id)) {
      addEdge(graph, ids, "PERFORMS_HTTP_REQUEST", callableIds.get(request.caller.id)!, id, {
        source: "http-request",
        strength: "direct",
        location: request.location,
      });
    }
  }

  for (const document of input.graphql.documents) {
    const id = `graphql-document:${document.id}`;
    addNode(graph, id, "graphql-document", document.name, document.declarationLocation,
      "graphql-operation", { documentId: document.id, status: document.status, tag: document.tag });
    documentIds.set(document.id, id);
    if (document.status !== "ok") continue;
    document.operations.forEach((operation, index) => {
      const operationId = `${id}:operation:${index}:${operation.type}:${operation.name ?? "anonymous"}`;
      addNode(graph, operationId, "graphql-operation",
        `${operation.type} ${operation.name ?? "<anonymous>"}`, operation.location,
        "graphql-operation", {
          documentId: document.id,
          operationIndex: index,
          operationType: operation.type,
          ...(operation.name ? { name: operation.name } : {}),
        });
      const byType = operationIds.get(operationKey(document.id, operation.type)) ?? [];
      byType.push(operationId);
      operationIds.set(operationKey(document.id, operation.type), byType);
      addEdge(graph, ids, "DEFINES_OPERATION", id, operationId, {
        source: "graphql-operation",
        strength: "direct",
        location: operation.location,
      });
    });
  }

  for (const execution of input.graphql.executions) {
    const id = ids.node("graphql-execution", locationKey(execution.location),
      `${execution.phase}:${execution.executor}`);
    addNode(graph, id, "graphql-execution", execution.executor, execution.location,
      "graphql-operation", {
        phase: execution.phase,
        operationType: execution.operationType,
        document: execution.document,
        scope: execution.scope,
        ...(execution.transport ? { transport: execution.transport } : {}),
      });
    if (execution.caller && callableIds.has(execution.caller.id)) {
      addEdge(graph, ids, "PERFORMS_GRAPHQL_EXECUTION",
        callableIds.get(execution.caller.id)!, id, {
          source: "graphql-operation",
          strength: "direct",
          location: execution.location,
        });
    }
    if (execution.document.kind === "dynamic") {
      addUnresolved(graph, ids, "USES_DOCUMENT", id, execution.document.expression,
        "GraphQL document reference is dynamic", "graphql-operation", execution.location);
      continue;
    }
    const documentId = documentIds.get(execution.document.documentId);
    if (!documentId) {
      addUnresolved(graph, ids, "USES_DOCUMENT", id, execution.document.documentId,
        "Referenced GraphQL document is absent", "graphql-operation", execution.document.location);
      continue;
    }
    addEdge(graph, ids, "USES_DOCUMENT", id, documentId, {
      source: "graphql-operation",
      strength: "resolved",
      location: execution.document.location,
    });
    const operations = operationIds.get(
      operationKey(execution.document.documentId, execution.operationType),
    ) ?? [];
    if (operations.length === 1) {
      addEdge(graph, ids, "EXECUTES_OPERATION", id, operations[0]!, {
        source: "graphql-operation",
        strength: "resolved",
        location: execution.location,
      });
    } else {
      addUnresolved(graph, ids, "EXECUTES_OPERATION", id, execution.operationType,
        operations.length === 0
          ? "Document has no matching operation"
          : "Document has multiple matching operations",
        "graphql-operation", execution.location);
    }
  }

  sortGraph(graph);
  validateProductEvidenceGraph(graph);
  return graph;
}

export function validateProductEvidenceGraph(graph: ProductEvidenceGraph): void {
  assertUnique(graph.nodes.map((node) => node.id), "node");
  assertUnique(graph.edges.map((edge) => edge.id), "edge");
  assertUnique(graph.unresolved.map((item) => item.id), "unresolved relationship");
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) {
      throw new Error(`Edge ${edge.id} references a missing node`);
    }
    const expected = EDGE_ENDPOINTS[edge.type];
    const validContainment = edge.type === "CONTAINS_ELEMENT" &&
      (from.type === "component" || from.type === "ui-element") &&
      to.type === "ui-element";
    if (!validContainment && (from.type !== expected[0] || to.type !== expected[1])) {
      throw new Error(
        `Edge ${edge.id} requires ${expected[0]} -> ${expected[1]}, got ${from.type} -> ${to.type}`,
      );
    }
  }
  for (const item of graph.unresolved) {
    if (item.from && !nodes.has(item.from)) {
      throw new Error(`Unresolved relationship ${item.id} references a missing source node`);
    }
  }
}

export function getEvidenceNode(
  graph: ProductEvidenceGraph,
  nodeId: string,
): ProductEvidenceNode | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

export function getOutgoingEvidenceEdges(
  graph: ProductEvidenceGraph,
  nodeId: string,
): ProductEvidenceEdge[] {
  return graph.edges.filter((edge) => edge.from === nodeId);
}

export function getIncomingEvidenceEdges(
  graph: ProductEvidenceGraph,
  nodeId: string,
): ProductEvidenceEdge[] {
  return graph.edges.filter((edge) => edge.to === nodeId);
}

export function traceEvidence(
  graph: ProductEvidenceGraph,
  nodeId: string,
): EvidenceTraceStep[] {
  const start = getEvidenceNode(graph, nodeId);
  if (!start) return [];
  const result: EvidenceTraceStep[] = [{ depth: 0, node: start }];
  const visited = new Set([nodeId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of getOutgoingEvidenceEdges(graph, current.id)) {
      if (visited.has(edge.to)) continue;
      const node = getEvidenceNode(graph, edge.to);
      if (!node) continue;
      visited.add(edge.to);
      result.push({ depth: current.depth + 1, node, via: edge });
      queue.push({ id: edge.to, depth: current.depth + 1 });
    }
  }
  return result;
}

function addUiTree(
  graph: ProductEvidenceGraph,
  ids: IdFactory,
  component: string,
  node: UiNode,
  parentId: string,
  elementIds: Map<string, string>,
): void {
  if (node.kind === "text" || node.kind === "dynamic") return;
  let childParent = parentId;
  if (node.kind === "element") {
    const id = ids.node("ui-element", locationKey(node.location), node.name);
    addNode(graph, id, "ui-element", elementLabel(node), node.location, "ui-structure", {
      component,
      name: node.name,
      props: node.props,
    });
    elementIds.set(elementKey(component, node.location), id);
    addEdge(graph, ids, "CONTAINS_ELEMENT", parentId, id, {
      source: "ui-structure",
      strength: "direct",
      location: node.location,
    });
    childParent = id;
  }
  for (const child of node.children) {
    addUiTree(graph, ids, component, child, childParent, elementIds);
  }
}

function elementLabel(node: UiElementNode): string {
  const text = node.children
    .filter((child) => child.kind === "text")
    .map((child) => child.value)
    .join(" ");
  return text ? `${node.name} "${text}"` : node.name;
}

function addNode(
  graph: ProductEvidenceGraph,
  id: string,
  type: ProductEvidenceNodeType,
  label: string,
  location: SourceLocation,
  source: EvidenceSource,
  data: Record<string, unknown>,
): void {
  graph.nodes.push({
    id,
    type,
    label,
    location,
    evidence: [{ source, strength: "direct", location }],
    data,
  });
}

function addEdge(
  graph: ProductEvidenceGraph,
  ids: IdFactory,
  type: ProductEvidenceEdgeType,
  from: string,
  to: string,
  evidence: GraphEvidence | GraphEvidence[],
): void {
  graph.edges.push({
    id: ids.edge(type, from, to),
    type,
    from,
    to,
    evidence: Array.isArray(evidence) ? evidence : [evidence],
  });
}

function addUnresolved(
  graph: ProductEvidenceGraph,
  ids: IdFactory,
  relationship: ProductEvidenceEdgeType,
  from: string | undefined,
  reference: string,
  reason: string,
  source: EvidenceSource,
  location?: SourceLocation,
): void {
  graph.unresolved.push({
    id: ids.unresolved(relationship, from ?? "none", reference),
    relationship,
    ...(from ? { from } : {}),
    reference,
    reason,
    evidence: [{ source, strength: "unresolved", ...(location ? { location } : {}) }],
  });
}

class IdFactory {
  private readonly counts = new Map<string, number>();

  node(type: ProductEvidenceNodeType, location: string, label: string): string {
    return this.unique(`${type}:${location}:${encode(label)}`);
  }

  edge(type: ProductEvidenceEdgeType, from: string, to: string): string {
    return this.unique(`edge:${type}:${from}->${to}`);
  }

  unresolved(type: ProductEvidenceEdgeType, from: string, reference: string): string {
    return this.unique(`unresolved:${type}:${from}:${encode(reference)}`);
  }

  private unique(base: string): string {
    const count = this.counts.get(base) ?? 0;
    this.counts.set(base, count + 1);
    return count === 0 ? base : `${base}#${count + 1}`;
  }
}

function resolveComponent(
  ui: UiStructureManifest,
  ids: Map<string, string>,
  name: string,
  location: SourceLocation,
): string | undefined {
  const exact = ids.get(componentKey(name, location));
  if (exact) return exact;
  const sameFile = ui.components.filter(
    (component) => component.name === name && component.location.path === location.path,
  );
  return sameFile.length === 1
    ? ids.get(componentKey(sameFile[0]!.name, sameFile[0]!.location))
    : undefined;
}

function resolveComponentTarget(
  ui: UiStructureManifest,
  ids: Map<string, string>,
  resolution: SymbolResolution,
): string | undefined {
  const matches = ui.components.filter(
    (component) => sameLocation(component.location, resolution.target.location),
  );
  return matches.length === 1
    ? ids.get(componentKey(matches[0]!.name, matches[0]!.location))
    : undefined;
}

function findImportResolution(
  manifest: ProjectSymbolResolutionManifest,
  importingFile: string,
  localName: string,
  moduleSpecifier?: string,
): SymbolResolution | undefined {
  const matches = manifest.resolutions.filter(
    (item) => item.kind === "import" && item.importingFile === importingFile &&
      item.localName === localName &&
      (moduleSpecifier === undefined || item.moduleSpecifier === moduleSpecifier),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function findNamespaceResolution(
  manifest: ProjectSymbolResolutionManifest,
  location: SourceLocation,
): SymbolResolution | undefined {
  const matches = manifest.resolutions.filter(
    (item) => item.kind === "namespace-member" && item.usageLocation &&
      sameLocation(item.usageLocation, location),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function findUnresolvedImport(
  manifest: ProjectSymbolResolutionManifest,
  importingFile: string,
  localName: string,
  moduleSpecifier?: string,
): UnresolvedSymbolResolution | undefined {
  return manifest.unresolved.find(
    (item) => item.kind === "import" && item.importingFile === importingFile &&
      item.localName === localName &&
      (moduleSpecifier === undefined || item.moduleSpecifier === moduleSpecifier),
  );
}

function resolutionEvidence(resolution: SymbolResolution): GraphEvidence[] {
  return resolution.evidence.map((entry) => ({
    source: "module-resolution",
    strength: "resolved",
    ...(entry.location ? { location: entry.location } : {}),
    details: {
      kind: entry.kind,
      path: entry.path,
      ...(entry.moduleSpecifier ? { moduleSpecifier: entry.moduleSpecifier } : {}),
      ...(entry.name ? { name: entry.name } : {}),
      resolutionStrength: resolution.strength,
    },
  }));
}

function findCallableByLocation(
  calls: FunctionCallManifest,
  name: string,
  location: SourceLocation,
) {
  const matches = calls.callers.filter(
    (callable) => callable.name === name && sameLocation(callable.location, location),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function assertMatchingRoots(input: ProductEvidenceGraphInput): void {
  const roots = [
    input.inventory.root,
    input.sources.root,
    input.ui.root,
    input.actions.root,
    input.navigation.root,
    input.calls.root,
    input.http.root,
    input.graphql.root,
    ...(input.resolution ? [input.resolution.root] : []),
  ];
  if (!roots.every((root) => root === roots[0])) {
    throw new Error("All Product Evidence Graph manifests must have the same repository root");
  }
}

function assertUnique(values: string[], kind: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${kind} ID: ${value}`);
    seen.add(value);
  }
}

function sortGraph(graph: ProductEvidenceGraph): void {
  graph.nodes.sort((left, right) => compareText(left.id, right.id));
  graph.edges.sort((left, right) => compareText(left.id, right.id));
  graph.unresolved.sort((left, right) => compareText(left.id, right.id));
  for (const node of graph.nodes) node.evidence.sort(compareEvidence);
  for (const edge of graph.edges) edge.evidence.sort(compareEvidence);
  for (const item of graph.unresolved) item.evidence.sort(compareEvidence);
}

function compareEvidence(left: GraphEvidence, right: GraphEvidence): number {
  return compareText(left.source, right.source) ||
    compareText(left.location ? locationKey(left.location) : "", right.location ? locationKey(right.location) : "");
}

function componentKey(name: string, location: SourceLocation): string {
  return `${name}:${locationKey(location)}`;
}

function elementKey(component: string, location: SourceLocation): string {
  return `${component}:${locationKey(location)}`;
}

function operationKey(documentId: string, type: GraphqlOperationType): string {
  return `${documentId}:${type}`;
}

function locationKey(location: SourceLocation): string {
  return `${location.path}:${location.startLine}-${location.endLine}`;
}

function sameLocation(left: SourceLocation, right: SourceLocation): boolean {
  return left.path === right.path && left.startLine === right.startLine && left.endLine === right.endLine;
}

function encode(value: string): string {
  return encodeURIComponent(value).replaceAll("%2F", "/");
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
