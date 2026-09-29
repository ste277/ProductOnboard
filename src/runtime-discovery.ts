import path from "node:path";
import {
  probeRuntimeNavigation,
  type RuntimeNavigationProbeResult,
  type RuntimeProbeSafety,
  type RuntimeProbeTarget,
  type RuntimeProbeTransition,
} from "./navigation-probe.js";
import {
  captureRuntimePage,
  sanitizeRuntimeUrl,
  stableHash,
  type RuntimeCaptureManifest,
  type RuntimeInteractiveElement,
  type RuntimeInteractionCandidate,
} from "./runtime-capture.js";

export interface RuntimeDiscoveryLimits {
  maxDepth: number;
  maxStates: number;
  maxTransitions: number;
  maxTargetsPerState: number;
}

export interface RuntimeNavigationDiscoveryOptions {
  startUrl: string;
  storageStatePath?: string;
  outputDirectory?: string;
  allowedOrigins?: string[];
  limits?: Partial<RuntimeDiscoveryLimits>;
  timeoutMs?: number;
  readinessTimeoutMs?: number;
  candidateTimeoutMs?: number;
  settleTimeoutMs?: number;
}

export type RuntimeDiscoveryBranchStopReason =
  | "visited"
  | "origin-boundary"
  | "form-state"
  | "session-expired"
  | "mutation-observed"
  | "probe-failed"
  | "target-limit"
  | "max-depth";

export interface RuntimeStateNode {
  id: string;
  fingerprint: string;
  url: string;
  title: string;
  depth: number;
  boundary: boolean;
  expandable: boolean;
  stopReasons: RuntimeDiscoveryBranchStopReason[];
  screenshot: RuntimeCaptureManifest["screenshot"];
  readiness: RuntimeCaptureManifest["readiness"];
  semanticElements: RuntimeInteractiveElement[];
  interactionCandidates: RuntimeInteractionCandidate[];
  accessibility: RuntimeCaptureManifest["accessibility"];
  visibleText: RuntimeCaptureManifest["text"];
  runtimeCaptureId: string;
  network: RuntimeCaptureManifest["network"];
  networkObservations: RuntimeNetworkEvidenceObservation[];
  provenance: "runtime-capture" | "runtime-probe";
}

export interface RuntimeNetworkEvidenceObservation {
  sourceId: string;
  sourceType: "runtime-capture" | "runtime-probe-after";
  network: RuntimeCaptureManifest["network"];
}

export interface RuntimeTransitionEdge {
  id: string;
  from: string;
  to: string | null;
  target: RuntimeProbeTarget | null;
  safety: RuntimeProbeSafety;
  interactionPerformed: boolean;
  transition: RuntimeProbeTransition | null;
  status: "observed" | "failed";
  stopReasons: RuntimeDiscoveryBranchStopReason[];
  baselineMutationMethods: string[];
  mutationMethods: string[];
  runtimeProbeId: string;
  network: RuntimeCaptureManifest["network"];
  failure?: string;
  provenance: "runtime-probe";
}

export interface RuntimeSkippedTarget {
  id: string;
  stateId: string;
  targetId: string;
  targetType: "semantic-element" | "interaction-candidate";
  text: string;
  decision: "blocked" | "unknown" | "not-eligible";
  reasons: string[];
}

export interface RuntimeDiscoverySummary {
  statesDiscovered: number;
  transitionsObserved: number;
  failedTransitions: number;
  targetsSkipped: number;
  blocked: number;
  unknown: number;
  boundaryStates: number;
  mutationStopBranches: number;
  maxDepthReached: number;
}

export interface RuntimeNavigationDiscoveryGraph {
  startUrl: string;
  startOrigin: string;
  allowedOrigins: string[];
  limits: RuntimeDiscoveryLimits;
  nodes: RuntimeStateNode[];
  transitions: RuntimeTransitionEdge[];
  skippedTargets: RuntimeSkippedTarget[];
  stopReasons: Array<"completed" | "max-depth" | "max-states" | "max-transitions" | "root-capture-failed">;
  summary: RuntimeDiscoverySummary;
  rootFailure?: string;
}

export const DEFAULT_RUNTIME_DISCOVERY_LIMITS: RuntimeDiscoveryLimits = {
  maxDepth: 2,
  maxStates: 20,
  maxTransitions: 40,
  maxTargetsPerState: 10,
};

interface FrontierEntry {
  nodeId: string;
  manifest: RuntimeCaptureManifest;
}

type DiscoveryTarget =
  | ({ source: "semantic-element" } & RuntimeInteractiveElement)
  | ({ source: "interaction-candidate" } & RuntimeInteractionCandidate);

export async function discoverRuntimeNavigation(
  options: RuntimeNavigationDiscoveryOptions,
): Promise<RuntimeNavigationDiscoveryGraph> {
  const startUrl = sanitizeRuntimeUrl(new URL(options.startUrl).href);
  const startOrigin = new URL(startUrl).origin;
  const allowedOrigins = normalizeOrigins(startOrigin, options.allowedOrigins ?? []);
  const limits = normalizeLimits(options.limits);
  const graph = emptyGraph(startUrl, startOrigin, allowedOrigins, limits);
  const outputDirectory = path.resolve(options.outputDirectory ?? "artifacts/runtime-discovery");
  let root: RuntimeCaptureManifest;
  try {
    root = await captureRuntimePage(captureOptions(options, startUrl, path.join(outputDirectory, "root")));
  } catch (error) {
    graph.stopReasons = ["root-capture-failed"];
    graph.rootFailure = error instanceof Error ? error.message : String(error);
    graph.summary = summarize(graph);
    return graph;
  }

  const rootNode = makeNode(root, 0, startOrigin, allowedOrigins, "runtime-capture", [], Boolean(options.storageStatePath));
  graph.nodes.push(rootNode);
  const visited = new Map([[rootNode.fingerprint, rootNode.id]]);
  const frontier: FrontierEntry[] = rootNode.expandable ? [{ nodeId: rootNode.id, manifest: root }] : [];
  let depthLimited = false;
  let stateLimited = false;
  let transitionLimited = false;

  while (frontier.length > 0) {
    const entry = frontier.shift()!;
    const node = graph.nodes.find((item) => item.id === entry.nodeId)!;
    if (node.depth >= limits.maxDepth) {
      addStop(node.stopReasons, "max-depth");
      depthLimited = orderedTargets(entry.manifest).length > 0 || depthLimited;
      continue;
    }
    const targets = orderedTargets(entry.manifest);
    const selected = targets.slice(0, limits.maxTargetsPerState);
    for (const target of targets.slice(limits.maxTargetsPerState)) {
      graph.skippedTargets.push(skipped(node.id, target, "not-eligible", ["target-limit"]));
      addStop(node.stopReasons, "target-limit");
    }

    for (const target of selected) {
      if (graph.transitions.length >= limits.maxTransitions) {
        transitionLimited = true;
        break;
      }
      if (isFormControl(target)) {
        graph.skippedTargets.push(skipped(node.id, target, "not-eligible", ["form-control"]));
        continue;
      }
      let probe: RuntimeNavigationProbeResult;
      try {
        probe = await probeRuntimeNavigation({
          url: node.url,
          targetId: target.id,
          outputDirectory: path.join(outputDirectory, `probe-${graph.transitions.length + 1}`),
          allowedOrigins,
          ...(options.storageStatePath ? { storageStatePath: options.storageStatePath } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.readinessTimeoutMs !== undefined ? { readinessTimeoutMs: options.readinessTimeoutMs } : {}),
          ...(options.candidateTimeoutMs !== undefined ? { candidateTimeoutMs: options.candidateTimeoutMs } : {}),
          ...(options.settleTimeoutMs !== undefined ? { settleTimeoutMs: options.settleTimeoutMs } : {}),
        });
      } catch (error) {
        graph.transitions.push(failedEdge(node.id, target, error));
        continue;
      }
      if (probe.safety.decision !== "allowed") {
        graph.skippedTargets.push(skipped(node.id, target, probe.safety.decision, probe.safety.reasons));
        continue;
      }
      if (!probe.interaction.performed || !probe.after || !probe.transition) {
        graph.transitions.push(edgeFromProbe(node.id, null, probe, ["probe-failed"]));
        continue;
      }

      const fingerprint = fingerprintRuntimeState(probe.after);
      const existingId = visited.get(fingerprint);
      const mutationStop = probe.transition.mutationMethods.length > 0;
      const boundary = !allowedOrigins.includes(new URL(probe.after.finalUrl).origin);
      const stopReasons: RuntimeDiscoveryBranchStopReason[] = [];
      if (existingId) addStop(stopReasons, "visited");
      if (mutationStop) addStop(stopReasons, "mutation-observed");
      if (boundary) addStop(stopReasons, "origin-boundary");

      let destinationId = existingId ?? null;
      if (existingId) {
        const existingNode = graph.nodes.find((item) => item.id === existingId)!;
        addNetworkObservation(existingNode, probe.after);
      }
      if (!existingId) {
        if (graph.nodes.length >= limits.maxStates) {
          stateLimited = true;
          graph.transitions.push(edgeFromProbe(node.id, null, probe, stopReasons, "max-states"));
          continue;
        }
        const child = makeNode(probe.after, node.depth + 1, startOrigin, allowedOrigins,
          "runtime-probe", stopReasons, Boolean(options.storageStatePath));
        destinationId = child.id;
        graph.nodes.push(child);
        visited.set(fingerprint, child.id);
        if (child.expandable) frontier.push({ nodeId: child.id, manifest: probe.after });
      }
      graph.transitions.push(edgeFromProbe(node.id, destinationId, probe, stopReasons));
    }
    if (transitionLimited || stateLimited) break;
  }

  graph.stopReasons = [];
  if (depthLimited) graph.stopReasons.push("max-depth");
  if (stateLimited) graph.stopReasons.push("max-states");
  if (transitionLimited) graph.stopReasons.push("max-transitions");
  if (graph.stopReasons.length === 0) graph.stopReasons.push("completed");
  graph.summary = summarize(graph);
  return graph;
}

export function fingerprintRuntimeState(manifest: RuntimeCaptureManifest): string {
  const semantic = manifest.elements.map((item) => [item.domPath, item.type, item.role,
    item.accessibleName, item.inputType ?? "", item.declaredHref ?? "", item.resolvedHref ?? "",
    item.enabled ? "enabled" : "disabled"].join("\u001f")).sort();
  const candidates = manifest.interactionCandidates.map((item) => [item.domPath, item.tag,
    item.role ?? "", item.accessibleName ?? "", item.text,
    item.signals.map((signal) => signal.type).sort().join(","),
    item.destination?.resolvedHref ?? ""].join("\u001f")).sort();
  return stableHash(JSON.stringify({
    url: sanitizeRuntimeUrl(manifest.finalUrl),
    title: manifest.page.title,
    semantic,
    candidates,
  }));
}

function orderedTargets(manifest: RuntimeCaptureManifest): DiscoveryTarget[] {
  const semantic = manifest.elements
    .map((item) => ({ ...item, source: "semantic-element" as const }))
    .sort((left, right) => targetRank(left) - targetRank(right) || left.domPath.localeCompare(right.domPath) || left.id.localeCompare(right.id));
  const candidates = manifest.interactionCandidates
    .map((item) => ({ ...item, source: "interaction-candidate" as const }))
    .sort((left, right) => targetRank(left) - targetRank(right) || left.domPath.localeCompare(right.domPath) || left.id.localeCompare(right.id));
  return [...semantic, ...candidates].sort((left, right) =>
    targetRank(left) - targetRank(right) || left.domPath.localeCompare(right.domPath) || left.id.localeCompare(right.id));
}

function targetRank(target: DiscoveryTarget): number {
  if (target.source === "semantic-element" && target.role === "link" && target.resolvedHref) return 0;
  if (target.source === "semantic-element") return 1;
  if (target.strength === "strong") return 2;
  return 3;
}

function isFormControl(target: DiscoveryTarget): boolean {
  if (target.source === "interaction-candidate") return false;
  return ["textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "option"].includes(target.role) ||
    ["input", "textarea", "select"].includes(target.type);
}

function makeNode(
  manifest: RuntimeCaptureManifest,
  depth: number,
  startOrigin: string,
  allowedOrigins: string[],
  provenance: RuntimeStateNode["provenance"],
  inheritedStops: RuntimeDiscoveryBranchStopReason[],
  authenticated: boolean,
): RuntimeStateNode {
  const fingerprint = fingerprintRuntimeState(manifest);
  const boundary = !allowedOrigins.includes(new URL(manifest.finalUrl).origin);
  const visibleWords = manifest.text.map((item) => item.text).join(" ").toLowerCase();
  const hasPassword = manifest.elements.some((item) => item.inputType === "password");
  const hasTextbox = manifest.elements.some((item) => item.role === "textbox" || item.role === "searchbox");
  const hasAuthenticationLanguage = /\b(login|log in|sign in)\b/.test(visibleWords);
  const hasAuthenticationProgression = manifest.elements.some((item) =>
    item.role === "button" && /^(next|login|log in|sign in)$/i.test(item.accessibleName));
  const formState = hasPassword || (hasTextbox && hasAuthenticationLanguage && hasAuthenticationProgression);
  const stopReasons = [...inheritedStops];
  if (boundary) addStop(stopReasons, "origin-boundary");
  if (formState) addStop(stopReasons, authenticated ? "session-expired" : "form-state");
  return {
    id: `runtime-state:${fingerprint}`,
    fingerprint,
    url: sanitizeRuntimeUrl(manifest.finalUrl),
    title: manifest.page.title,
    depth,
    boundary,
    expandable: !boundary && !formState && !stopReasons.includes("mutation-observed"),
    stopReasons,
    screenshot: manifest.screenshot,
    readiness: manifest.readiness,
    semanticElements: manifest.elements,
    interactionCandidates: manifest.interactionCandidates,
    accessibility: manifest.accessibility,
    visibleText: manifest.text,
    runtimeCaptureId: manifest.id,
    network: manifest.network,
    networkObservations: [{
      sourceId: manifest.id,
      sourceType: provenance === "runtime-capture" ? "runtime-capture" : "runtime-probe-after",
      network: manifest.network,
    }],
    provenance,
  };
}

function edgeFromProbe(
  from: string,
  to: string | null,
  probe: RuntimeNavigationProbeResult,
  stopReasons: RuntimeDiscoveryBranchStopReason[],
  failure?: string,
): RuntimeTransitionEdge {
  const baselineMutationMethods = mutationMethods(probe.before.network);
  const observedMutationMethods = probe.transition?.mutationMethods ?? [];
  return {
    id: `runtime-transition:${stableHash(`${from}|${to ?? "none"}|${probe.targetId}`)}`,
    from, to, target: probe.target, safety: probe.safety,
    interactionPerformed: probe.interaction.performed,
    transition: probe.transition,
    status: failure || !probe.interaction.performed ? "failed" : "observed",
    stopReasons,
    baselineMutationMethods,
    mutationMethods: observedMutationMethods,
    runtimeProbeId: probe.id,
    network: probe.transition?.network ?? [],
    ...(failure ? { failure } : probe.interaction.failure ? { failure: probe.interaction.failure } : {}),
    provenance: "runtime-probe",
  };
}

function failedEdge(from: string, target: DiscoveryTarget, error: unknown): RuntimeTransitionEdge {
  const safety: RuntimeProbeSafety = { decision: "unknown", reasons: ["probe-failed"], provenance: "safety-rule" };
  return {
    id: `runtime-transition:${stableHash(`${from}|${target.id}|failed`)}`,
    from, to: null, target, safety, interactionPerformed: false, transition: null,
    status: "failed", stopReasons: ["probe-failed"], baselineMutationMethods: [], mutationMethods: [],
    runtimeProbeId: `runtime-probe-failed:${stableHash(`${from}|${target.id}`)}`,
    network: [],
    failure: error instanceof Error ? error.message : String(error), provenance: "runtime-probe",
  };
}

function addNetworkObservation(node: RuntimeStateNode, manifest: RuntimeCaptureManifest): void {
  if (node.networkObservations.some((item) => item.sourceId === manifest.id)) return;
  node.networkObservations.push({
    sourceId: manifest.id,
    sourceType: "runtime-probe-after",
    network: manifest.network,
  });
  node.networkObservations.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function skipped(
  stateId: string,
  target: DiscoveryTarget,
  decision: RuntimeSkippedTarget["decision"],
  reasons: string[],
): RuntimeSkippedTarget {
  const text = target.source === "semantic-element"
    ? target.accessibleName || target.visibleText || ""
    : target.accessibleName || target.text;
  return { id: `runtime-skipped:${stableHash(`${stateId}|${target.id}|${decision}`)}`,
    stateId, targetId: target.id, targetType: target.source, text, decision, reasons };
}

function captureOptions(options: RuntimeNavigationDiscoveryOptions, url: string, outputDirectory: string) {
  return { url, outputDirectory,
    ...(options.storageStatePath ? { storageStatePath: options.storageStatePath } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.readinessTimeoutMs !== undefined ? { readinessTimeoutMs: options.readinessTimeoutMs } : {}),
    ...(options.candidateTimeoutMs !== undefined ? { candidateTimeoutMs: options.candidateTimeoutMs } : {}) };
}

function normalizeLimits(input: Partial<RuntimeDiscoveryLimits> | undefined): RuntimeDiscoveryLimits {
  const result = { ...DEFAULT_RUNTIME_DISCOVERY_LIMITS, ...input };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  }
  return result;
}

function normalizeOrigins(startOrigin: string, values: string[]): string[] {
  return [...new Set([startOrigin, ...values.map((value) => new URL(value).origin)])].sort();
}

function mutationMethods(network: RuntimeCaptureManifest["network"]): string[] {
  return [...new Set(network.map((item) => item.method.toUpperCase()).filter((method) =>
    ["POST", "PUT", "PATCH", "DELETE"].includes(method)))].sort();
}

function addStop(list: RuntimeDiscoveryBranchStopReason[], reason: RuntimeDiscoveryBranchStopReason): void {
  if (!list.includes(reason)) list.push(reason);
}

function emptyGraph(
  startUrl: string,
  startOrigin: string,
  allowedOrigins: string[],
  limits: RuntimeDiscoveryLimits,
): RuntimeNavigationDiscoveryGraph {
  return { startUrl, startOrigin, allowedOrigins, limits, nodes: [], transitions: [], skippedTargets: [],
    stopReasons: [], summary: { statesDiscovered: 0, transitionsObserved: 0, failedTransitions: 0,
      targetsSkipped: 0, blocked: 0, unknown: 0, boundaryStates: 0, mutationStopBranches: 0,
      maxDepthReached: 0 } };
}

function summarize(graph: RuntimeNavigationDiscoveryGraph): RuntimeDiscoverySummary {
  return {
    statesDiscovered: graph.nodes.length,
    transitionsObserved: graph.transitions.filter((item) => item.status === "observed").length,
    failedTransitions: graph.transitions.filter((item) => item.status === "failed").length,
    targetsSkipped: graph.skippedTargets.length,
    blocked: graph.skippedTargets.filter((item) => item.decision === "blocked").length,
    unknown: graph.skippedTargets.filter((item) => item.decision === "unknown").length,
    boundaryStates: graph.nodes.filter((item) => item.boundary).length,
    mutationStopBranches: graph.nodes.filter((item) => item.stopReasons.includes("mutation-observed")).length,
    maxDepthReached: Math.max(0, ...graph.nodes.map((item) => item.depth)),
  };
}
