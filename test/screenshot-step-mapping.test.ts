import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachKnowledgeVisuals,
  formatKnowledgeBaseArticleWithVisuals,
  getCalloutsForScreenshot,
  getUnmappedKnowledgeSteps,
  getVisualsForStep,
  mapKnowledgeStepsToScreenshots,
  validateScreenshotStepMapping,
  type ScreenshotStepMapping,
} from "../src/screenshot-step-mapping.js";
import type {
  KnowledgeBaseArticle,
  KnowledgeClaim,
  KnowledgeClaimStatus,
  KnowledgeEvidencePackage,
} from "../src/knowledge-base-generator.js";
import type { RuntimeNavigationDiscoveryGraph, RuntimeStateNode } from "../src/runtime-discovery.js";

test("maps Create Ticket steps to exact state-specific semantic targets deterministically", () => {
  const input = fixture(); const before = JSON.stringify(input);
  const first = mapKnowledgeStepsToScreenshots(input); const second = mapKnowledgeStepsToScreenshots(input);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(input), before);
  assert.equal(first.coordinateSystem, "runtime-viewport-css-pixels");
  assert.equal(first.steps[0]?.callouts[0]?.stateId, "state-tickets");
  assert.equal(first.steps[0]?.callouts[0]?.targetId, "nav-create");
  assert.equal(first.steps[0]?.callouts[0]?.screenshotPath, "/tmp/tickets.png");
  assert.equal(first.steps[1]?.callouts[0]?.targetId, "subject");
  assert.equal(first.steps[2]?.callouts[0]?.targetId, "client");
  assert.equal(first.steps[3]?.callouts[0]?.targetId, "submit-create");
  assert.equal(first.steps[3]?.callouts[0]?.screenshotPath, "/tmp/create.png");
  assert.notDeepEqual(first.steps[0]?.callouts[0]?.boundingBox, first.steps[3]?.callouts[0]?.boundingBox);
  assert.doesNotThrow(() => JSON.stringify(first));
});

test("numbers callouts by step order within each screenshot and deduplicates annotation sets", () => {
  const mapping = mapKnowledgeStepsToScreenshots(fixture());
  assert.deepEqual(getCalloutsForScreenshot(mapping, "state-tickets").map((item) => item.number), [1]);
  assert.deepEqual(getCalloutsForScreenshot(mapping, "state-create").map((item) => item.number), [1, 2, 3]);
  assert.equal(mapping.annotationSets.length, 2);
  assert.equal(mapping.annotationSets.filter((item) => item.stateId === "state-create").length, 1);
  assert.deepEqual(getVisualsForStep(mapping, 1)[0]?.calloutIds, [mapping.steps[1]!.callouts[0]!.id]);
});

test("maps multiple cited claims to multiple targets without merging states", () => {
  const input = fixture();
  input.article.steps.push({ text: "Enter Subject and select Client.", claimIds: ["claim-subject", "claim-client"] });
  const mapping = mapKnowledgeStepsToScreenshots(input); const combined = mapping.steps[4]!;
  assert.equal(combined.status, "mapped");
  assert.deepEqual(combined.callouts.map((item) => item.targetId), ["subject", "client"]);
  assert.equal(combined.visuals.length, 1);

  input.article.steps.push({ text: "Use navigation and Subject.", claimIds: ["claim-entry", "claim-subject"] });
  const multipleStates = mapKnowledgeStepsToScreenshots(input).steps[5]!;
  assert.equal(multipleStates.visuals.length, 2);
  assert.deepEqual(new Set(multipleStates.visuals.map((item) => item.stateId)), new Set(["state-tickets", "state-create"]));
});

test("supports directly referenced interaction candidates and runtime-only outcomes", () => {
  const input = fixture();
  input.article.steps.push({ text: "Choose Login as requester.", claimIds: ["claim-candidate"] },
    { text: "Observe success.", claimIds: ["claim-outcome"] });
  const mapping = mapKnowledgeStepsToScreenshots(input);
  const candidate = mapping.steps[4]!.callouts[0]!;
  assert.equal(candidate.targetType, "interaction-candidate");
  assert.equal(candidate.targetId, "candidate-login");
  assert.equal(candidate.label, "Login as requester");
  const outcome = mapping.steps[5]!.callouts[0]!;
  assert.equal(outcome.targetId, "success");
  assert.equal(outcome.label, "Ticket created successfully");
});

test("does not map static-only, ambiguous, conflicting, hidden, or missing-box evidence", () => {
  const input = fixture();
  input.article.steps.push(
    { text: "Set Priority.", claimIds: ["claim-priority"] },
    { text: "Use ambiguous target.", claimIds: ["claim-ambiguous"] },
    { text: "Use conflicting target.", claimIds: ["claim-conflicting"] },
    { text: "Use hidden target.", claimIds: ["claim-hidden"] },
    { text: "Use target without box.", claimIds: ["claim-no-box"] },
  );
  const mapping = mapKnowledgeStepsToScreenshots(input);
  assert.equal(mapping.steps[4]?.status, "no-visual-target");
  assert.equal(mapping.steps[5]?.status, "ambiguous");
  assert.equal(mapping.steps[6]?.status, "ambiguous");
  assert.equal(mapping.steps[7]?.issues[0]?.type, "target-hidden");
  assert.equal(mapping.steps[8]?.issues[0]?.type, "bounding-box-unavailable");
  assert.equal(getUnmappedKnowledgeSteps(mapping).length, 5);
});

test("rejects invalid and out-of-bounds boxes without guessing coordinates", () => {
  for (const [box, expected] of [
    [{ x: -1, y: 1, width: 10, height: 10 }, "bounding-box-invalid"],
    [{ x: 1, y: -1, width: 10, height: 10 }, "bounding-box-invalid"],
    [{ x: 1, y: 1, width: 0, height: 10 }, "bounding-box-invalid"],
    [{ x: 1, y: 1, width: 10, height: 0 }, "bounding-box-invalid"],
    [{ x: 790, y: 1, width: 20, height: 10 }, "bounding-box-out-of-bounds"],
  ] as const) {
    const input = fixture(); input.runtimeDiscovery.nodes.find((item) => item.id === "state-create")!
      .semanticElements.find((item) => item.id === "subject")!.boundingBox = box;
    const step = mapKnowledgeStepsToScreenshots(input).steps[1]!;
    assert.equal(step.issues[0]?.type, expected);
    assert.equal(step.callouts.length, 0);
  }
});

test("reports screenshot unavailability and rejects wrong-state screenshot references", () => {
  const input = fixture(); input.evidencePackage.screenshots = input.evidencePackage.screenshots.filter((item) => item.runtimeStateId !== "state-create");
  const unavailable = mapKnowledgeStepsToScreenshots(input);
  assert.equal(unavailable.steps[1]?.status, "screenshot-unavailable");
  assert.equal(unavailable.steps[1]?.issues[0]?.type, "screenshot-unavailable");

  const validInput = fixture(); const mapping = mapKnowledgeStepsToScreenshots(validInput);
  const wrong: ScreenshotStepMapping = structuredClone(mapping);
  wrong.steps[1]!.callouts[0]!.screenshotPath = "/tmp/tickets.png";
  assert.throws(() => validateScreenshotStepMapping(wrong, validInput.article, validInput.evidencePackage,
    validInput.runtimeDiscovery), /Screenshot state mismatch/);
});

test("validation rejects bad claims, runtime targets, screenshot references, and numbering", () => {
  const input = fixture(); const mapping = mapKnowledgeStepsToScreenshots(input);
  const badClaim = structuredClone(mapping); badClaim.steps[0]!.claimIds[0] = "missing-claim";
  assert.throws(() => validateScreenshotStepMapping(badClaim, input.article, input.evidencePackage, input.runtimeDiscovery), /Invalid claim reference/);
  const badTarget = structuredClone(mapping); badTarget.steps[1]!.callouts[0]!.targetId = "missing-target";
  assert.throws(() => validateScreenshotStepMapping(badTarget, input.article, input.evidencePackage, input.runtimeDiscovery), /Invalid runtime target/);
  const badScreenshot = structuredClone(mapping); badScreenshot.steps[1]!.callouts[0]!.screenshotPath = "/tmp/missing.png";
  assert.throws(() => validateScreenshotStepMapping(badScreenshot, input.article, input.evidencePackage, input.runtimeDiscovery), /Screenshot state mismatch/);
  const badNumber = structuredClone(mapping); badNumber.steps[1]!.callouts[0]!.number = 9;
  assert.throws(() => validateScreenshotStepMapping(badNumber, input.article, input.evidencePackage, input.runtimeDiscovery), /Invalid callout numbering/);
});

test("attaches visual references without altering article text or grounding", () => {
  const input = fixture(); const mapping = mapKnowledgeStepsToScreenshots(input);
  const beforeText = input.article.steps.map((item) => item.text); const beforeGrounding = structuredClone(input.article.grounding);
  const visual = attachKnowledgeVisuals(input.article, mapping);
  assert.deepEqual(visual.steps.map((item) => item.text), beforeText);
  assert.deepEqual(visual.grounding, beforeGrounding);
  assert.ok(visual.steps.every((item) => item.visuals.length > 0));
  assert.ok(visual.evidence.filter((item) => item.section === "step").every((item) => item.visualEvidenceRefs.length > 0));
  const formatted = formatKnowledgeBaseArticleWithVisuals(visual, mapping);
  assert.match(formatted, /Screenshot: \/tmp\/tickets\.png/);
  assert.match(formatted, /Callout: 1 - Create Ticket/);
});

test("uses structural labels only and never reads pixels or sensitive field values", () => {
  const input = fixture();
  input.runtimeDiscovery.nodes[1]!.visibleText.push({ id: "private", text: "cookie=session-secret", domPath: "body", provenance: "dom" });
  const mapping = mapKnowledgeStepsToScreenshots(input); const serialized = JSON.stringify(mapping);
  assert.doesNotMatch(serialized, /session-secret|cookie=/i);
  assert.equal(mapping.steps[1]?.callouts[0]?.label, "Subject");
  assert.equal(Object.hasOwn(mapping, "ocr"), false);
  assert.equal(Object.hasOwn(mapping, "pixels"), false);
});

function fixture() {
  const runtimeDiscovery = runtime();
  const claims = [
    claim("claim-feature", "feature-name", "Create Ticket", "corroborated"),
    claim("claim-entry", "entry-point", "Create Ticket opens Create Ticket.", "corroborated",
      [{ stateId: "state-tickets", targetId: "nav-create", targetType: "semantic-element" }]),
    claim("claim-subject", "visible-ui", "Subject field", "corroborated",
      [{ stateId: "state-create", targetId: "subject", targetType: "semantic-element" }]),
    claim("claim-client", "visible-ui", "Client field", "corroborated",
      [{ stateId: "state-create", targetId: "client", targetType: "semantic-element" }]),
    claim("claim-submit", "user-action", "Create Ticket action", "corroborated",
      [{ stateId: "state-create", targetId: "submit-create", targetType: "semantic-element" }]),
    claim("claim-priority", "visible-ui", "Priority field", "static-only"),
    claim("claim-ambiguous", "visible-ui", "Save", "ambiguous", [
      { stateId: "state-create", targetId: "subject", targetType: "semantic-element" },
      { stateId: "state-create", targetId: "client", targetType: "semantic-element" }]),
    claim("claim-conflicting", "visible-ui", "Conflicting", "conflicting",
      [{ stateId: "state-create", targetId: "client", targetType: "semantic-element" }]),
    claim("claim-hidden", "visible-ui", "Hidden", "runtime-only",
      [{ stateId: "state-create", targetId: "hidden", targetType: "semantic-element" }]),
    claim("claim-no-box", "visible-ui", "No Box", "runtime-only",
      [{ stateId: "state-create", targetId: "no-box", targetType: "semantic-element" }]),
    claim("claim-candidate", "user-action", "Login as requester", "runtime-only",
      [{ stateId: "state-tickets", targetId: "candidate-login", targetType: "interaction-candidate" }]),
    claim("claim-outcome", "visible-outcome", "Ticket created successfully", "runtime-only",
      [{ stateId: "state-create", targetId: "success", targetType: "semantic-element" }]),
  ];
  const evidencePackage: KnowledgeEvidencePackage = { id: "knowledge-package:create", feature: { id: "feature:create", name: "Create Ticket",
    routes: ["/tickets/new"], entryPoints: [{ label: "Create Ticket", destination: "/tickets/new" }] }, claims,
    internalEvidence: [], screenshots: [{ runtimeStateId: "state-tickets", path: "/tmp/tickets.png", purpose: "step-context",
      evidenceRefs: ["state-tickets"] }, { runtimeStateId: "state-create", path: "/tmp/create.png", purpose: "feature-state",
      evidenceRefs: ["state-create"] }], limitations: [], provenance: [], policy: { allowRuntimeOnly: true, allowStaticOnly: false } };
  const steps = [statement("Select Create Ticket.", "claim-entry"), statement("Enter or select Subject.", "claim-subject"),
    statement("Enter or select Client.", "claim-client"), statement("Select Create Ticket.", "claim-submit")];
  const article: KnowledgeBaseArticle = { artifactType: "how-to", title: "Create a Ticket", summary: statement("Use Create Ticket.", "claim-feature"),
    prerequisites: [], steps, notes: [], screenshots: structuredClone(evidencePackage.screenshots), evidence: [
      ledger("summary", 0, "Use Create Ticket.", ["claim-feature"]), ...steps.map((item, index) => ledger("step", index, item.text, item.claimIds)),
    ], limitations: [], grounding: { supportedStatements: 5, unsupportedStatements: 0, unusedClaims: [], issues: [] }, status: "draft",
    metadata: { generatedAt: "2026-01-01T00:00:00.000Z", evidencePackageId: evidencePackage.id, featureId: evidencePackage.feature.id } };
  return { article, evidencePackage, runtimeDiscovery };
}

function runtime(): RuntimeNavigationDiscoveryGraph {
  const tickets = state("state-tickets", "/tmp/tickets.png", [element("nav-create", "a", "link", "Create Ticket", box(20, 40, 120, 30)),
    element("same-label-tickets", "button", "button", "Create Ticket", box(20, 100, 120, 30))], [{ id: "candidate-login", tag: "div",
      text: "Login as requester", role: null, accessibleName: null, domPath: "body>div", tabindex: null, boundingBox: box(200, 100, 180, 40),
      signals: [{ type: "direct-click-listener", provenance: "browser-event-listener" }], strength: "strong", destination: null,
      provenance: ["browser-event-listener"] }]);
  const create = state("state-create", "/tmp/create.png", [element("subject", "input", "textbox", "Subject", box(100, 100, 400, 40)),
    element("client", "select", "combobox", "Client", box(100, 160, 400, 40)),
    element("submit-create", "button", "button", "Create Ticket", box(100, 240, 160, 40)),
    element("success", "div", "status", "Ticket created successfully", box(100, 300, 300, 40)),
    { ...element("hidden", "button", "button", "Hidden", box(100, 350, 100, 30)), visible: false } as unknown as RuntimeStateNode["semanticElements"][number],
    { ...element("no-box", "button", "button", "No Box", box(1, 1, 1, 1)), boundingBox: null } as unknown as RuntimeStateNode["semanticElements"][number]], []);
  return { startUrl: tickets.url, startOrigin: "https://app.test", allowedOrigins: ["https://app.test"],
    limits: { maxDepth: 1, maxStates: 3, maxTransitions: 3, maxTargetsPerState: 5 }, nodes: [tickets, create], transitions: [],
    skippedTargets: [], stopReasons: ["completed"], summary: { statesDiscovered: 2, transitionsObserved: 0, failedTransitions: 0,
      targetsSkipped: 0, blocked: 0, unknown: 0, boundaryStates: 0, mutationStopBranches: 0, maxDepthReached: 1 } };
}
function state(id: string, screenshotPath: string, semanticElements: RuntimeStateNode["semanticElements"],
  interactionCandidates: RuntimeStateNode["interactionCandidates"]): RuntimeStateNode { return { id, fingerprint: `fingerprint-${id}`,
  url: `https://app.test/${id}`, title: id, depth: 0, boundary: false, expandable: true, stopReasons: [], screenshot: {
    path: screenshotPath, width: 800, height: 600, fullPage: false, captured: true, provenance: "screenshot" },
  readiness: { status: "ready", reason: "network-idle", timeoutMs: 1000 }, semanticElements, interactionCandidates,
  accessibility: { format: "playwright-aria-snapshot-v1", snapshot: id, provenance: "accessibility" }, visibleText: [],
  runtimeCaptureId: `capture-${id}`, network: [], networkObservations: [{ sourceId: `capture-${id}`, sourceType: "runtime-capture", network: [] }],
  provenance: "runtime-capture" }; }
function element(id: string, type: string, role: string, accessibleName: string,
  boundingBox: { x: number; y: number; width: number; height: number }): RuntimeStateNode["semanticElements"][number] { return {
  id, type, role, accessibleName, visibleText: accessibleName, domPath: `body>${type}`, visible: true, enabled: true, boundingBox,
  provenance: ["dom", "accessibility"] }; }
function claim(id: string, kind: KnowledgeClaim["kind"], text: string, status: KnowledgeClaimStatus,
  visualTargets: KnowledgeClaim["support"]["visualTargets"] = []): KnowledgeClaim { return { id, kind, text, status, customerVisible: true,
  publishable: status === "corroborated" || status === "runtime-only", support: { featureId: "feature:create", staticNodeIds: [],
    runtimeStateIds: visualTargets.map((item) => item.stateId), runtimeElementIds: visualTargets.map((item) => item.targetId),
    reconciliationIds: [], contractEvidenceIds: [], contractReconciliationIds: [], runtimeTransitionIds: [], visualTargets } }; }
function box(x: number, y: number, width: number, height: number) { return { x, y, width, height }; }
function statement(text: string, claimId: string) { return { text, claimIds: [claimId] }; }
function ledger(section: "summary" | "step", index: number, text: string, claimIds: string[]) { return { section, index, text, claimIds, evidenceRefs: [] }; }
