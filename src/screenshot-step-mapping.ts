import { stableHash, type RuntimeBoundingBox } from "./runtime-capture.js";
import type { RuntimeNavigationDiscoveryGraph, RuntimeStateNode } from "./runtime-discovery.js";
import type {
  KnowledgeBaseArticle,
  KnowledgeClaim,
  KnowledgeEvidenceLedgerEntry,
  KnowledgeEvidencePackage,
  KnowledgeGrounding,
  KnowledgeWriterStatement,
} from "./knowledge-base-generator.js";

export type ScreenshotStepMappingStatus =
  | "mapped" | "partially-mapped" | "no-visual-target" | "ambiguous" | "screenshot-unavailable";

export interface ScreenshotCallout {
  id: string;
  number: number;
  targetId: string;
  targetType: "semantic-element" | "interaction-candidate";
  label: string;
  boundingBox: RuntimeBoundingBox;
  coordinateSystem: "runtime-viewport-css-pixels";
  stateId: string;
  screenshotPath: string;
  claimIds: string[];
  evidenceRefs: string[];
}

export interface StepScreenshotVisual {
  stateId: string;
  path: string;
  width: number;
  height: number;
  calloutIds: string[];
}

export interface ScreenshotMappingIssue {
  type:
    | "claim-unavailable" | "claim-ineligible" | "runtime-target-unavailable" | "target-hidden"
    | "bounding-box-unavailable" | "bounding-box-invalid" | "bounding-box-out-of-bounds"
    | "screenshot-unavailable" | "screenshot-state-mismatch" | "ambiguous-runtime-target";
  claimId?: string;
  targetId?: string;
  stateId?: string;
  message: string;
  evidenceRefs: string[];
}

export interface KnowledgeStepScreenshotMapping {
  stepIndex: number;
  text: string;
  claimIds: string[];
  visuals: StepScreenshotVisual[];
  callouts: ScreenshotCallout[];
  status: ScreenshotStepMappingStatus;
  issues: ScreenshotMappingIssue[];
}

export interface ScreenshotAnnotationSet {
  id: string;
  stateId: string;
  screenshotPath: string;
  width: number;
  height: number;
  calloutIds: string[];
}

export interface ScreenshotStepMapping {
  id: string;
  articleFeatureId: string;
  evidencePackageId: string;
  coordinateSystem: "runtime-viewport-css-pixels";
  steps: KnowledgeStepScreenshotMapping[];
  annotationSets: ScreenshotAnnotationSet[];
  unmappedSteps: number[];
  unusedScreenshots: Array<{ stateId: string; path: string }>;
  summary: Record<ScreenshotStepMappingStatus, number>;
}

export interface MapKnowledgeStepsInput {
  article: KnowledgeBaseArticle;
  evidencePackage: KnowledgeEvidencePackage;
  runtimeDiscovery: RuntimeNavigationDiscoveryGraph;
}

export interface KnowledgeStepVisualReference {
  stateId: string;
  screenshotPath: string;
  calloutIds: string[];
}

export interface VisualKnowledgeWriterStatement extends KnowledgeWriterStatement {
  visuals: KnowledgeStepVisualReference[];
}

export interface VisualKnowledgeBaseArticle extends Omit<KnowledgeBaseArticle, "steps" | "evidence" | "grounding"> {
  steps: VisualKnowledgeWriterStatement[];
  evidence: Array<KnowledgeEvidenceLedgerEntry & { visualEvidenceRefs: string[] }>;
  grounding: KnowledgeGrounding;
  visualMappingId: string;
}

interface ResolvedTarget {
  state: RuntimeStateNode;
  targetId: string;
  targetType: ScreenshotCallout["targetType"];
  label: string;
  boundingBox: RuntimeBoundingBox | null;
  visible: boolean;
  evidenceRefs: string[];
}

export function mapKnowledgeStepsToScreenshots(input: MapKnowledgeStepsInput): ScreenshotStepMapping {
  if (input.article.metadata.featureId !== input.evidencePackage.feature.id) throw new Error("Article/evidence feature mismatch");
  if (input.article.metadata.evidencePackageId !== input.evidencePackage.id) throw new Error("Article/evidence package mismatch");
  const claims = new Map(input.evidencePackage.claims.map((item) => [item.id, item]));
  const steps = input.article.steps.map((step, stepIndex) => mapStep(step, stepIndex, claims,
    input.evidencePackage, input.runtimeDiscovery));
  numberCallouts(steps);
  const annotationSets = buildAnnotationSets(steps, input.runtimeDiscovery);
  for (const step of steps) step.visuals = visualsForCallouts(step.callouts, input.runtimeDiscovery);
  const usedScreenshots = new Set(annotationSets.map((item) => `${item.stateId}|${item.screenshotPath}`));
  const mapping: ScreenshotStepMapping = {
    id: "", articleFeatureId: input.article.metadata.featureId, evidencePackageId: input.evidencePackage.id,
    coordinateSystem: "runtime-viewport-css-pixels", steps, annotationSets,
    unmappedSteps: steps.filter((item) => item.status !== "mapped" && item.status !== "partially-mapped").map((item) => item.stepIndex),
    unusedScreenshots: input.evidencePackage.screenshots.filter((item) => !usedScreenshots.has(`${item.runtimeStateId}|${item.path}`))
      .map((item) => ({ stateId: item.runtimeStateId, path: item.path })), summary: summarize(steps),
  };
  mapping.id = `screenshot-step-mapping:${stableHash(JSON.stringify({ feature: mapping.articleFeatureId,
    package: mapping.evidencePackageId, steps: steps.map((item) => ({ stepIndex: item.stepIndex, status: item.status,
      callouts: item.callouts.map((callout) => callout.id) })) }))}`;
  validateScreenshotStepMapping(mapping, input.article, input.evidencePackage, input.runtimeDiscovery);
  return mapping;
}

function mapStep(step: KnowledgeWriterStatement, stepIndex: number, claims: Map<string, KnowledgeClaim>,
  package_: KnowledgeEvidencePackage, runtime: RuntimeNavigationDiscoveryGraph): KnowledgeStepScreenshotMapping {
  const issues: ScreenshotMappingIssue[] = []; const callouts: ScreenshotCallout[] = [];
  for (const claimId of step.claimIds) {
    const claim = claims.get(claimId);
    if (!claim) { issues.push(issue("claim-unavailable", `Claim ${claimId} is not in the evidence package`, [claimId], claimId)); continue; }
    if (claim.status === "ambiguous" || claim.status === "conflicting") {
      issues.push(issue("claim-ineligible", `Claim ${claimId} is ${claim.status}`, evidenceRefs(claim), claimId)); continue;
    }
    if (claim.support.visualTargets.length === 0) {
      issues.push(issue("runtime-target-unavailable", `Claim ${claimId} has no runtime visual target`, evidenceRefs(claim), claimId)); continue;
    }
    for (const visualTarget of claim.support.visualTargets) {
      const targets = resolveTargets(visualTarget.stateId, visualTarget.targetId, visualTarget.targetType, runtime);
      if (targets.length > 1) {
        issues.push(issue("ambiguous-runtime-target", `Multiple runtime targets resolve ${visualTarget.targetId}`,
          evidenceRefs(claim), claimId, visualTarget.targetId, visualTarget.stateId)); continue;
      }
      const target = targets[0];
      if (!target) { issues.push(issue("runtime-target-unavailable", `Runtime target ${visualTarget.targetId} is unavailable`,
        evidenceRefs(claim), claimId, visualTarget.targetId, visualTarget.stateId)); continue; }
      if (!target.visible) { issues.push(issue("target-hidden", `Runtime target ${target.targetId} was not visible`,
        target.evidenceRefs, claimId, target.targetId, target.state.id)); continue; }
      if (!target.boundingBox) { issues.push(issue("bounding-box-unavailable", `Runtime target ${target.targetId} has no bounding box`,
        target.evidenceRefs, claimId, target.targetId, target.state.id)); continue; }
      const screenshot = package_.screenshots.find((item) => item.runtimeStateId === target.state.id);
      if (!screenshot || !target.state.screenshot.captured) { issues.push(issue("screenshot-unavailable",
        `No captured screenshot is available for ${target.state.id}`, target.evidenceRefs, claimId, target.targetId, target.state.id)); continue; }
      if (screenshot.path !== target.state.screenshot.path) { issues.push(issue("screenshot-state-mismatch",
        `Screenshot path does not match runtime state ${target.state.id}`, [screenshot.path, target.state.id], claimId,
        target.targetId, target.state.id)); continue; }
      const boxIssue = validateBox(target.boundingBox, target.state.screenshot.width, target.state.screenshot.height);
      if (boxIssue) { issues.push(issue(boxIssue, `Bounding box for ${target.targetId} is not valid for the screenshot`,
        target.evidenceRefs, claimId, target.targetId, target.state.id)); continue; }
      callouts.push(makeCallout(stepIndex, claimId, claim, target, screenshot.path));
    }
  }
  const uniqueCallouts = uniqueBy(callouts, (item) => `${item.stateId}|${item.targetType}|${item.targetId}|${item.claimIds.join("|")}`)
    .sort((a, b) => `${step.claimIds.indexOf(a.claimIds[0]!)}|${a.targetId}`.localeCompare(`${step.claimIds.indexOf(b.claimIds[0]!)}|${b.targetId}`));
  return { stepIndex, text: step.text, claimIds: [...step.claimIds], visuals: [], callouts: uniqueCallouts,
    status: mappingStatus(uniqueCallouts, issues, step.claimIds.length), issues };
}

function resolveTargets(stateId: string, targetId: string, targetType: ScreenshotCallout["targetType"],
  runtime: RuntimeNavigationDiscoveryGraph): ResolvedTarget[] {
  const state = runtime.nodes.find((item) => item.id === stateId); if (!state) return [];
  const result: ResolvedTarget[] = [];
  if (targetType === "semantic-element") for (const item of state.semanticElements.filter((value) => value.id === targetId)) {
    result.push({ state, targetId: item.id, targetType, label: structuralLabel(item.accessibleName || item.visibleText || item.role),
      boundingBox: item.boundingBox, visible: item.visible, evidenceRefs: [state.id, item.id, state.screenshot.path] });
  }
  if (targetType === "interaction-candidate") for (const item of state.interactionCandidates.filter((value) => value.id === targetId)) {
    result.push({ state, targetId: item.id, targetType, label: structuralLabel(item.accessibleName || item.text || item.role || item.tag),
      boundingBox: item.boundingBox, visible: true, evidenceRefs: [state.id, item.id, state.screenshot.path] });
  }
  for (const edge of runtime.transitions.filter((item) => item.from === stateId && item.target?.id === targetId &&
    item.target.source === targetType)) {
    const item = edge.target!;
    result.push({ state, targetId: item.id, targetType, label: structuralLabel(item.source === "semantic-element"
      ? item.accessibleName || item.visibleText || item.role : item.accessibleName || item.text || item.role || item.tag),
    boundingBox: item.boundingBox, visible: item.source === "semantic-element" ? item.visible : true,
    evidenceRefs: [state.id, edge.id, item.id, state.screenshot.path] });
  }
  return uniqueBy(result, (item) => `${item.state.id}|${item.targetType}|${item.targetId}|${JSON.stringify(item.boundingBox)}`);
}

function makeCallout(stepIndex: number, claimId: string, claim: KnowledgeClaim, target: ResolvedTarget,
  screenshotPath: string): ScreenshotCallout {
  const identity = `${stepIndex}|${claimId}|${target.state.id}|${target.targetType}|${target.targetId}|${JSON.stringify(target.boundingBox)}`;
  return { id: `screenshot-callout:${stableHash(identity)}`, number: 0, targetId: target.targetId,
    targetType: target.targetType, label: target.label, boundingBox: { ...target.boundingBox! },
    coordinateSystem: "runtime-viewport-css-pixels", stateId: target.state.id, screenshotPath,
    claimIds: [claimId], evidenceRefs: unique([...target.evidenceRefs, ...evidenceRefs(claim)]).sort() };
}

function numberCallouts(steps: KnowledgeStepScreenshotMapping[]): void {
  const byScreenshot = new Map<string, ScreenshotCallout[]>();
  for (const step of steps) for (const callout of step.callouts) {
    const key = `${callout.stateId}|${callout.screenshotPath}`;
    byScreenshot.set(key, [...(byScreenshot.get(key) ?? []), callout]);
  }
  for (const values of byScreenshot.values()) values.sort((a, b) => {
    const stepA = steps.find((item) => item.callouts.includes(a))!.stepIndex;
    const stepB = steps.find((item) => item.callouts.includes(b))!.stepIndex;
    return `${String(stepA).padStart(8, "0")}|${a.claimIds[0]}|${a.targetId}`
      .localeCompare(`${String(stepB).padStart(8, "0")}|${b.claimIds[0]}|${b.targetId}`);
  }).forEach((callout, index) => { callout.number = index + 1; });
}

function buildAnnotationSets(steps: KnowledgeStepScreenshotMapping[], runtime: RuntimeNavigationDiscoveryGraph): ScreenshotAnnotationSet[] {
  const grouped = new Map<string, ScreenshotCallout[]>();
  for (const callout of steps.flatMap((item) => item.callouts)) {
    const key = `${callout.stateId}|${callout.screenshotPath}`;
    grouped.set(key, [...(grouped.get(key) ?? []), callout]);
  }
  return [...grouped.entries()].map(([key, callouts]) => {
    const state = runtime.nodes.find((item) => item.id === callouts[0]!.stateId)!;
    const ids = unique(callouts.map((item) => item.id)).sort((a, b) => {
      const left = callouts.find((item) => item.id === a)!; const right = callouts.find((item) => item.id === b)!;
      return left.number - right.number || left.id.localeCompare(right.id);
    });
    return { id: `screenshot-annotation-set:${stableHash(`${key}|${ids.join("|")}`)}`, stateId: state.id,
      screenshotPath: state.screenshot.path, width: state.screenshot.width, height: state.screenshot.height, calloutIds: ids };
  }).sort((a, b) => `${a.stateId}|${a.screenshotPath}`.localeCompare(`${b.stateId}|${b.screenshotPath}`));
}

function visualsForCallouts(callouts: ScreenshotCallout[], runtime: RuntimeNavigationDiscoveryGraph): StepScreenshotVisual[] {
  const grouped = new Map<string, ScreenshotCallout[]>();
  for (const callout of callouts) grouped.set(`${callout.stateId}|${callout.screenshotPath}`,
    [...(grouped.get(`${callout.stateId}|${callout.screenshotPath}`) ?? []), callout]);
  return [...grouped.values()].map((values) => {
    const state = runtime.nodes.find((item) => item.id === values[0]!.stateId)!;
    return { stateId: state.id, path: state.screenshot.path, width: state.screenshot.width, height: state.screenshot.height,
      calloutIds: values.sort((a, b) => a.number - b.number).map((item) => item.id) };
  }).sort((a, b) => a.stateId.localeCompare(b.stateId));
}

export function validateScreenshotStepMapping(mapping: ScreenshotStepMapping, article: KnowledgeBaseArticle,
  package_: KnowledgeEvidencePackage, runtime: RuntimeNavigationDiscoveryGraph): void {
  if (mapping.articleFeatureId !== article.metadata.featureId || mapping.articleFeatureId !== package_.feature.id) throw new Error("Invalid feature identity");
  if (mapping.evidencePackageId !== package_.id || article.metadata.evidencePackageId !== package_.id) throw new Error("Invalid evidence package identity");
  if (mapping.steps.length !== article.steps.length) throw new Error("Invalid step count");
  const claimIds = new Set(package_.claims.map((item) => item.id));
  const callouts = mapping.steps.flatMap((item) => item.callouts); assertUnique(callouts.map((item) => item.id), "callout");
  for (const step of mapping.steps) {
    const articleStep = article.steps[step.stepIndex]; if (!articleStep || articleStep.text !== step.text) throw new Error(`Invalid step reference ${step.stepIndex}`);
    for (const id of step.claimIds) if (!claimIds.has(id)) throw new Error(`Invalid claim reference ${id}`);
    for (const callout of step.callouts) {
      if (!callout.claimIds.every((id) => step.claimIds.includes(id) && claimIds.has(id))) throw new Error(`Invalid callout claim reference ${callout.id}`);
      const state = runtime.nodes.find((item) => item.id === callout.stateId); if (!state) throw new Error(`Invalid runtime target ${callout.targetId}`);
      const resolved = resolveTargets(callout.stateId, callout.targetId, callout.targetType, runtime);
      if (resolved.length !== 1) throw new Error(`Invalid runtime target ${callout.targetId}`);
      if (state.screenshot.path !== callout.screenshotPath) throw new Error(`Screenshot state mismatch ${callout.id}`);
      if (!package_.screenshots.some((item) => item.runtimeStateId === state.id && item.path === callout.screenshotPath)) {
        throw new Error(`Invalid screenshot reference ${callout.screenshotPath}`);
      }
      const boxIssue = validateBox(callout.boundingBox, state.screenshot.width, state.screenshot.height);
      if (boxIssue) throw new Error(`Invalid bounding box ${callout.id}: ${boxIssue}`);
    }
    if (step.status === "mapped" && step.callouts.length === 0) throw new Error(`Invalid mapped status for step ${step.stepIndex}`);
    if (step.status === "no-visual-target" && step.callouts.length > 0) throw new Error(`Invalid no-visual-target status for step ${step.stepIndex}`);
  }
  for (const set of mapping.annotationSets) {
    const numbers = callouts.filter((item) => set.calloutIds.includes(item.id)).sort((a, b) => a.number - b.number)
      .map((item) => item.number);
    if (numbers.some((number, index) => number !== index + 1)) throw new Error(`Invalid callout numbering ${set.id}`);
    const expected = callouts.filter((item) => item.stateId === set.stateId && item.screenshotPath === set.screenshotPath)
      .sort((a, b) => a.number - b.number).map((item) => item.id);
    if (JSON.stringify(set.calloutIds) !== JSON.stringify(unique(expected))) throw new Error(`Invalid annotation set ${set.id}`);
  }
}

export function attachKnowledgeVisuals(article: KnowledgeBaseArticle,
  mapping: ScreenshotStepMapping): VisualKnowledgeBaseArticle {
  if (article.metadata.featureId !== mapping.articleFeatureId || article.metadata.evidencePackageId !== mapping.evidencePackageId) {
    throw new Error("Article/mapping identity mismatch");
  }
  const steps = article.steps.map((step, index) => ({ ...structuredClone(step), visuals: mapping.steps[index]!.visuals.map((visual) => ({
    stateId: visual.stateId, screenshotPath: visual.path, calloutIds: [...visual.calloutIds] })) }));
  const evidence = article.evidence.map((item) => ({ ...structuredClone(item), visualEvidenceRefs: item.section === "step"
    ? mapping.steps[item.index]?.callouts.flatMap((callout) => [callout.stateId, callout.targetId, callout.screenshotPath, callout.id]) ?? [] : [] }));
  return { ...structuredClone(article), steps, evidence, grounding: structuredClone(article.grounding), visualMappingId: mapping.id };
}

export function formatKnowledgeBaseArticleWithVisuals(article: VisualKnowledgeBaseArticle,
  mapping: ScreenshotStepMapping): string {
  const lines = [`# ${article.title}`, "", article.summary.text, "", "## Steps", ""];
  for (const [index, step] of article.steps.entries()) {
    lines.push(`${index + 1}. ${step.text}`);
    for (const visual of step.visuals) {
      lines.push(`   Screenshot: ${visual.screenshotPath}`);
      for (const id of visual.calloutIds) {
        const callout = mapping.steps[index]?.callouts.find((item) => item.id === id);
        if (callout) lines.push(`   Callout: ${callout.number} - ${callout.label}`);
      }
    }
  }
  if (article.expectedResult) lines.push("", "## Expected result", "", article.expectedResult.text);
  if (article.limitations.length) lines.push("", "## Limitations", "", ...article.limitations.map((item) => `- ${item.message}`));
  return lines.join("\n");
}

export function getVisualsForStep(mapping: ScreenshotStepMapping, stepIndex: number): StepScreenshotVisual[] {
  return structuredClone(mapping.steps.find((item) => item.stepIndex === stepIndex)?.visuals ?? []);
}
export function getCalloutsForScreenshot(mapping: ScreenshotStepMapping, stateId: string): ScreenshotCallout[] {
  return mapping.steps.flatMap((item) => item.callouts).filter((item) => item.stateId === stateId)
    .sort((a, b) => a.number - b.number);
}
export function getUnmappedKnowledgeSteps(mapping: ScreenshotStepMapping): KnowledgeStepScreenshotMapping[] {
  return mapping.steps.filter((item) => mapping.unmappedSteps.includes(item.stepIndex));
}

function mappingStatus(callouts: ScreenshotCallout[], issues: ScreenshotMappingIssue[], claimCount: number): ScreenshotStepMappingStatus {
  if (issues.some((item) => item.type === "ambiguous-runtime-target" || item.type === "claim-ineligible")) return "ambiguous";
  if (callouts.length && issues.length) return "partially-mapped";
  if (callouts.length && callouts.length >= claimCount) return "mapped";
  if (callouts.length) return "partially-mapped";
  if (issues.some((item) => item.type === "screenshot-unavailable" || item.type === "screenshot-state-mismatch")) return "screenshot-unavailable";
  return "no-visual-target";
}
function validateBox(box: RuntimeBoundingBox, width: number, height: number): ScreenshotMappingIssue["type"] | undefined {
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y) || !Number.isFinite(box.width) || !Number.isFinite(box.height) ||
    box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0) return "bounding-box-invalid";
  if (box.x + box.width > width || box.y + box.height > height) return "bounding-box-out-of-bounds";
  return undefined;
}
function issue(type: ScreenshotMappingIssue["type"], message: string, refs: string[], claimId?: string,
  targetId?: string, stateId?: string): ScreenshotMappingIssue {
  return { type, message, ...(claimId ? { claimId } : {}), ...(targetId ? { targetId } : {}),
    ...(stateId ? { stateId } : {}), evidenceRefs: unique(refs).sort() };
}
function evidenceRefs(claim: KnowledgeClaim): string[] { return unique([...claim.support.staticNodeIds,
  ...claim.support.runtimeStateIds, ...claim.support.runtimeElementIds, ...claim.support.runtimeTransitionIds,
  ...claim.support.reconciliationIds, ...claim.support.contractEvidenceIds, ...claim.support.contractReconciliationIds,
  ...claim.support.visualTargets.map((item) => item.targetId)]); }
function structuralLabel(value: string): string { return value.replace(/(Authorization\s*:\s*(?:Bearer\s+)?)[^\s,]+/gi, "$1[REDACTED]")
  .replace(/(?:token|cookie|password|secret)\s*[:=]\s*[^\s,]+/gi, "[REDACTED]").replace(/\s+/g, " ").trim(); }
function summarize(steps: KnowledgeStepScreenshotMapping[]): Record<ScreenshotStepMappingStatus, number> {
  const result: Record<ScreenshotStepMappingStatus, number> = { mapped: 0, "partially-mapped": 0, "no-visual-target": 0,
    ambiguous: 0, "screenshot-unavailable": 0 };
  for (const step of steps) result[step.status] += 1; return result;
}
function unique<T>(items: T[]): T[] { return [...new Set(items)]; }
function uniqueBy<T>(items: T[], key: (item: T) => string): T[] { const seen = new Set<string>(); return items.filter((item) => {
  const value = key(item); if (seen.has(value)) return false; seen.add(value); return true; }); }
function assertUnique(items: string[], label: string): void { if (new Set(items).size !== items.length) throw new Error(`Duplicate ${label} ID`); }
