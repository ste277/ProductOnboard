import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Locator,
  type Page,
  type Request,
} from "playwright";
import {
  captureInteractionCandidates,
  captureInteractiveElements,
  captureVisibleText,
  DEFAULT_RUNTIME_VIEWPORT,
  normalizeNetwork,
  normalizeText,
  readConsoleError,
  sanitizeRuntimeUrl,
  sanitizeAriaSnapshot,
  stableHash,
  validateRuntimeUrl,
  withTimeout,
  type RuntimeBrowserError,
  type RuntimeCaptureIssue,
  type RuntimeCaptureManifest,
  type RuntimeInteractiveElement,
  type RuntimeInteractionCandidate,
  type RuntimeNetworkObservation,
} from "./runtime-capture.js";

export interface RuntimeNavigationProbeOptions {
  url: string;
  targetId: string;
  outputDirectory?: string;
  storageStatePath?: string;
  timeoutMs?: number;
  readinessTimeoutMs?: number;
  candidateTimeoutMs?: number;
  settleTimeoutMs?: number;
  allowedOrigins?: string[];
}

export type RuntimeProbeTarget =
  | ({ source: "semantic-element" } & RuntimeInteractiveElement)
  | ({ source: "interaction-candidate" } & RuntimeInteractionCandidate);

export type RuntimeProbeSafetyDecision = "allowed" | "blocked" | "unknown";

export interface RuntimeProbeSafety {
  decision: RuntimeProbeSafetyDecision;
  reasons: string[];
  provenance: "safety-rule";
}

export interface RuntimeProbeInteraction {
  type: "click";
  performed: boolean;
  count: 0 | 1;
  failure?: string;
  provenance: "browser-interaction";
}

export interface RuntimeProbeTransition {
  kind: "same-url" | "same-origin-url-change" | "hash-change" | "cross-origin-attempt" | "popup";
  beforeUrl: string;
  afterUrl: string;
  urlChanged: boolean;
  titleChanged: boolean;
  uiChanged: boolean;
  semanticElementsChanged: boolean;
  interactionCandidatesChanged: boolean;
  networkObserved: boolean;
  dialogAppeared: boolean;
  popupAppeared: boolean;
  mutationMethods: Array<"POST" | "PUT" | "PATCH" | "DELETE">;
  highSeveritySafetyIssue: boolean;
  provenance: Array<"before-runtime" | "after-runtime" | "network" | "accessibility">;
}

export interface RuntimeNavigationProbeResult {
  id: string;
  startUrl: string;
  targetId: string;
  target: RuntimeProbeTarget | null;
  resolution: { status: "resolved" | "missing" | "ambiguous" | "stale"; matches: number };
  safety: RuntimeProbeSafety;
  interaction: RuntimeProbeInteraction;
  before: RuntimeCaptureManifest;
  transition: RuntimeProbeTransition | null;
  after: RuntimeCaptureManifest | null;
}

interface RuntimeObservers {
  network: RuntimeNetworkObservation[];
  requests: WeakMap<Request, RuntimeNetworkObservation>;
  consoleErrors: RuntimeBrowserError[];
  pageErrors: RuntimeBrowserError[];
}

export interface RuntimeProbeTargetContext {
  tag: string;
  role: string | null;
  text: string;
  accessibleName: string;
  inputType: string | null;
  declaredHref: string | null;
  resolvedHref: string | null;
  insideForm: boolean;
  associatedForm: boolean;
  couldSubmitForm: boolean;
  disabled: boolean;
  nearbyText: string;
}

const MUTATION_TERMS = [
  "delete", "remove", "destroy", "erase", "purge", "save", "submit", "create", "update",
  "edit", "install", "uninstall", "restart", "reboot", "shutdown", "disable", "enable", "send",
  "publish", "close", "resolve", "assign", "approve", "reject", "cancel subscription", "purchase",
  "buy", "pay",
] as const;
const AUTH_ENTRY_TERMS = ["login", "log in", "sign in"] as const;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function probeRuntimeNavigation(
  options: RuntimeNavigationProbeOptions,
): Promise<RuntimeNavigationProbeResult> {
  if (!options.targetId?.trim()) throw new TypeError("A runtime target ID is required");
  const navigationUrl = validateRuntimeUrl(options.url).href;
  const requestedUrl = sanitizeRuntimeUrl(navigationUrl);
  const outputDirectory = path.resolve(options.outputDirectory ?? "artifacts/runtime-probes");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 2_000;
  const candidateTimeoutMs = options.candidateTimeoutMs ?? 3_000;
  const settleTimeoutMs = options.settleTimeoutMs ?? 1_000;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: DEFAULT_RUNTIME_VIEWPORT,
      ...(options.storageStatePath ? { storageState: options.storageStatePath } : {}),
    });
    const page = await context.newPage();
    const observers = observePage(page);
    context.on("page", (newPage) => attachObservers(newPage, observers));
    const response = await page.goto(navigationUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const before = await captureSnapshot(page, requestedUrl, response?.status(), outputDirectory,
      "before", observers, readinessTimeoutMs, candidateTimeoutMs);
    const located = resolveCapturedTarget(before, options.targetId);
    const base = baseResult(requestedUrl, options.targetId, before, located.target, located.status,
      located.matches);
    if (!located.target) return base;

    const locator = page.locator(located.target.domPath);
    const liveCount = await locator.count();
    if (liveCount !== 1) {
      return { ...base, resolution: { status: liveCount > 1 ? "ambiguous" : "stale", matches: liveCount } };
    }
    const contextEvidence = await readTargetContext(locator);
    if (!targetStillMatches(located.target, contextEvidence)) {
      return { ...base, resolution: { status: "stale", matches: 1 } };
    }
    const safety = classifyRuntimeProbeTarget(located.target, contextEvidence, before.finalUrl,
      options.allowedOrigins);
    if (safety.decision !== "allowed") return { ...base, safety };

    const networkStart = observers.network.length;
    const beforePages = new Set(context.pages());
    const popupPromise = context.waitForEvent("page", { timeout: settleTimeoutMs }).catch(() => null);
    let clickFailure: string | undefined;
    try {
      await locator.click({ timeout: timeoutMs });
    } catch (error) {
      clickFailure = normalizeText(error instanceof Error ? error.message : String(error));
    }
    if (clickFailure) {
      return {
        ...base,
        safety,
        interaction: { type: "click", performed: false, count: 0, failure: clickFailure,
          provenance: "browser-interaction" },
      };
    }

    await boundedSettle(page, settleTimeoutMs);
    const observedPopup = await popupPromise;
    const popup = observedPopup ?? context.pages().find((item) => !beforePages.has(item));
    let afterPage = page;
    let popupAppeared = false;
    if (popup) {
      popupAppeared = true;
      await popup.waitForLoadState("domcontentloaded", { timeout: settleTimeoutMs }).catch(() => undefined);
      if (sameOrigin(before.finalUrl, popup.url())) {
        afterPage = popup;
      }
    }
    const after = await captureSnapshot(afterPage, requestedUrl, undefined, outputDirectory,
      "after", observers, readinessTimeoutMs, candidateTimeoutMs);
    const transitionNetwork = observers.network.slice(networkStart);
    const transition = buildTransition(before, after, transitionNetwork, popupAppeared);
    return {
      ...base,
      safety,
      interaction: { type: "click", performed: true, count: 1, provenance: "browser-interaction" },
      after,
      transition,
    };
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

export function classifyRuntimeProbeTarget(
  target: RuntimeProbeTarget,
  context: RuntimeProbeTargetContext,
  currentUrl: string,
  allowedOrigins: string[] = [],
): RuntimeProbeSafety {
  const evidence = normalizePolicyText([
    target.source === "semantic-element" ? target.visibleText ?? "" : target.text,
    target.accessibleName ?? "", context.text, context.accessibleName,
  ].join(" "));
  const destructive = MUTATION_TERMS.find((term) => containsTerm(evidence, term));
  if (destructive) return decision("blocked", [`destructive-action-text:${destructive}`]);
  if (context.couldSubmitForm || context.inputType === "submit") {
    return decision("blocked", ["form-submission"]);
  }

  const href = context.resolvedHref ?? (
    target.source === "semantic-element" ? target.resolvedHref : target.destination?.resolvedHref
  );
  const declaredHref = context.declaredHref ?? (
    target.source === "semantic-element" ? target.declaredHref : target.destination?.declaredHref
  );
  if (declaredHref || href) {
    const scheme = declaredHref?.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
    if (scheme && !["http", "https"].includes(scheme)) {
      return decision("blocked", [`unsupported-navigation-scheme:${scheme}`]);
    }
    if (!href) return decision("unknown", ["unresolved-navigation-destination"]);
    let destination: URL;
    try {
      destination = new URL(href, currentUrl);
    } catch {
      return decision("unknown", ["unresolved-navigation-destination"]);
    }
    if (!["http:", "https:"].includes(destination.protocol)) {
      return decision("blocked", [`unsupported-navigation-scheme:${destination.protocol.slice(0, -1)}`]);
    }
    if (destination.origin !== new URL(currentUrl).origin && !allowedOrigins.includes(destination.origin)) {
      return decision("blocked", ["cross-origin"]);
    }
    return decision("allowed", ["safe-same-origin-navigation", "no-destructive-signal", "not-form-submit"]);
  }

  const strong = target.source === "interaction-candidate" && target.strength === "strong";
  const authEntry = AUTH_ENTRY_TERMS.some((term) => containsTerm(evidence, term));
  if (strong && authEntry && !context.insideForm && !context.associatedForm) {
    return decision("allowed", ["strong-interaction-evidence", "authentication-entry",
      "no-destructive-signal", "not-form-submit"]);
  }
  return decision("unknown", [strong ? "strong-interaction-without-safe-navigation-evidence" :
    "insufficient-safe-navigation-evidence"]);
}

function decision(decisionValue: RuntimeProbeSafetyDecision, reasons: string[]): RuntimeProbeSafety {
  return { decision: decisionValue, reasons, provenance: "safety-rule" };
}

function baseResult(
  startUrl: string,
  targetId: string,
  before: RuntimeCaptureManifest,
  target: RuntimeProbeTarget | null,
  status: RuntimeNavigationProbeResult["resolution"]["status"],
  matches: number,
): RuntimeNavigationProbeResult {
  return {
    id: `runtime-probe:${stableHash(`${startUrl}|${targetId}|${before.capturedAt}`)}`,
    startUrl,
    targetId,
    target,
    resolution: { status, matches },
    safety: decision("unknown", [status === "resolved" ? "safety-not-evaluated" : `target-${status}`]),
    interaction: { type: "click", performed: false, count: 0, provenance: "browser-interaction" },
    before,
    transition: null,
    after: null,
  };
}

function resolveCapturedTarget(before: RuntimeCaptureManifest, targetId: string): {
  target: RuntimeProbeTarget | null;
  status: RuntimeNavigationProbeResult["resolution"]["status"];
  matches: number;
} {
  const matches: RuntimeProbeTarget[] = [
    ...before.elements.filter((item) => item.id === targetId).map((item) => ({ ...item, source: "semantic-element" as const })),
    ...before.interactionCandidates.filter((item) => item.id === targetId)
      .map((item) => ({ ...item, source: "interaction-candidate" as const })),
  ];
  return { target: matches.length === 1 ? matches[0]! : null,
    status: matches.length === 1 ? "resolved" : matches.length === 0 ? "missing" : "ambiguous",
    matches: matches.length };
}

async function readTargetContext(locator: Locator): Promise<RuntimeProbeTargetContext> {
  return locator.evaluate((element) => {
    const html = element as HTMLElement;
    const input = element instanceof HTMLInputElement ? element : null;
    const button = element instanceof HTMLButtonElement ? element : null;
    const form = input?.form ?? button?.form ?? element.closest("form");
    const declaredHref = element.getAttribute("href");
    let resolvedHref: string | null = null;
    if (declaredHref) {
      try { resolvedHref = new URL(declaredHref, document.baseURI).href; } catch { /* evidence stays null */ }
    }
    const type = input?.type ?? button?.getAttribute("type")?.toLowerCase() ?? null;
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      text: (html.innerText || "").replace(/\s+/g, " ").trim(),
      accessibleName: (element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "").trim(),
      inputType: type,
      declaredHref,
      resolvedHref,
      insideForm: Boolean(element.closest("form")),
      associatedForm: Boolean(form),
      couldSubmitForm: Boolean(form && (type === "submit" ||
        (button && !button.hasAttribute("type")) || (input && ["submit", "image"].includes(input.type)))),
      disabled: Boolean(input?.disabled ?? button?.disabled ?? element.getAttribute("aria-disabled") === "true"),
      nearbyText: (element.parentElement?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 500),
    };
  });
}

function targetStillMatches(target: RuntimeProbeTarget, context: RuntimeProbeTargetContext): boolean {
  const expectedTag = target.source === "semantic-element" ? target.type : target.tag;
  const expectedText = target.source === "semantic-element" ? target.visibleText ?? "" : target.text;
  return expectedTag === context.tag && (!expectedText || normalizeText(expectedText) === normalizeText(context.text));
}

async function captureSnapshot(
  page: Page,
  requestedUrl: string,
  navigationStatus: number | undefined,
  outputDirectory: string,
  phase: "before" | "after",
  observers: RuntimeObservers,
  readinessTimeoutMs: number,
  candidateTimeoutMs: number,
): Promise<RuntimeCaptureManifest> {
  const capturedAt = new Date().toISOString();
  let readiness: RuntimeCaptureManifest["readiness"];
  try {
    await page.waitForLoadState("networkidle", { timeout: readinessTimeoutMs });
    readiness = { status: "ready", reason: "network-idle", timeoutMs: readinessTimeoutMs };
  } catch {
    readiness = { status: "partial", reason: "network-active", timeoutMs: readinessTimeoutMs };
  }
  const issues: RuntimeCaptureIssue[] = [];
  const finalUrl = sanitizeRuntimeUrl(page.url());
  let title = "";
  try { title = normalizeText(await page.title()); } catch {
    issues.push({ stage: "page-metadata", classification: "extraction-failed", message: "Page metadata extraction failed" });
  }
  let elements: RuntimeInteractiveElement[] = [];
  let text = [] as Awaited<ReturnType<typeof captureVisibleText>>;
  try { elements = await captureInteractiveElements(page); text = await captureVisibleText(page); } catch {
    issues.push({ stage: "ui", classification: "extraction-failed", message: "Runtime UI extraction failed" });
  }
  let interactionCandidates: RuntimeInteractionCandidate[] = [];
  try { interactionCandidates = await withTimeout(captureInteractionCandidates(page), candidateTimeoutMs,
    "Interaction candidate extraction timed out"); } catch {
    issues.push({ stage: "interaction-candidates", classification: "extraction-failed",
      message: "Interaction candidate extraction failed" });
  }
  let accessibility = { format: "playwright-aria-snapshot-v1" as const, snapshot: "", provenance: "accessibility" as const };
  try { accessibility = { ...accessibility, snapshot: sanitizeAriaSnapshot(await page.locator("body").ariaSnapshot()) }; } catch {
    issues.push({ stage: "accessibility", classification: "extraction-failed", message: "Accessibility extraction failed" });
  }
  const captureId = stableHash(`${requestedUrl}|${finalUrl}|${capturedAt}|${phase}`);
  const screenshotPath = path.join(outputDirectory, `${phase}-runtime-${captureId}.png`);
  let screenshotCaptured = true;
  try { await mkdir(outputDirectory, { recursive: true }); await page.screenshot({ path: screenshotPath, type: "png", fullPage: false }); } catch {
    screenshotCaptured = false;
    issues.push({ stage: "screenshot", classification: "artifact-write-failed", message: "Runtime screenshot could not be written" });
  }
  const network = observers.network.map((item) => ({ ...item }));
  normalizeNetwork(network);
  return {
    id: `runtime:${stableHash(`${requestedUrl}|${finalUrl}`)}:${captureId}`,
    status: readiness.status === "partial" || issues.length ? "partial" : "complete",
    requestedUrl, finalUrl, capturedAt, viewport: { ...DEFAULT_RUNTIME_VIEWPORT },
    navigation: { success: true, redirected: finalUrl !== requestedUrl,
      ...(navigationStatus !== undefined ? { status: navigationStatus } : {}) },
    readiness,
    stages: {
      navigation: { status: "complete" }, readiness: { status: readiness.status === "ready" ? "complete" : "partial" },
      pageMetadata: { status: issues.some((item) => item.stage === "page-metadata") ? "failed" : "complete" },
      ui: { status: issues.some((item) => item.stage === "ui") ? "failed" : "complete" },
      interactionCandidates: { status: issues.some((item) => item.stage === "interaction-candidates") ? "failed" : "complete" },
      accessibility: { status: issues.some((item) => item.stage === "accessibility") ? "failed" : "complete" },
      network: { status: "complete" }, screenshot: { status: screenshotCaptured ? "complete" : "failed" },
    },
    issues, page: { title }, text, elements, interactionCandidates, accessibility, network,
    consoleErrors: [...observers.consoleErrors], pageErrors: [...observers.pageErrors],
    screenshot: { path: screenshotPath, width: DEFAULT_RUNTIME_VIEWPORT.width, height: DEFAULT_RUNTIME_VIEWPORT.height,
      fullPage: false, captured: screenshotCaptured, provenance: "screenshot" },
  };
}

function observePage(page: Page): RuntimeObservers {
  const observers: RuntimeObservers = { network: [], requests: new WeakMap(), consoleErrors: [], pageErrors: [] };
  attachObservers(page, observers);
  return observers;
}

function attachObservers(page: Page, observers: RuntimeObservers): void {
  page.on("request", (request) => {
    const observation: RuntimeNetworkObservation = { id: "", method: request.method(), url: sanitizeRuntimeUrl(request.url()),
      resourceType: request.resourceType(), provenance: "network" };
    observers.network.push(observation);
    observers.requests.set(request, observation);
  });
  page.on("response", (response) => {
    const observation = observers.requests.get(response.request());
    if (observation) observation.status = response.status();
  });
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") observers.consoleErrors.push(readConsoleError(message));
  });
  page.on("pageerror", (error) => observers.pageErrors.push({ type: "page", message: normalizeText(error.message), provenance: "browser" }));
}

async function boundedSettle(page: Page, timeoutMs: number): Promise<void> {
  await Promise.race([
    page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, Math.min(timeoutMs, 500))),
  ]);
}

function buildTransition(
  before: RuntimeCaptureManifest,
  after: RuntimeCaptureManifest,
  network: RuntimeNetworkObservation[],
  popupAppeared: boolean,
): RuntimeProbeTransition {
  const beforeUrl = new URL(before.finalUrl);
  const afterUrl = new URL(after.finalUrl);
  const urlChanged = before.finalUrl !== after.finalUrl;
  const mutationMethods = [...new Set(network.map((item) => item.method.toUpperCase())
    .filter((method): method is "POST" | "PUT" | "PATCH" | "DELETE" => MUTATION_METHODS.has(method)))];
  const beforeDialogs = before.elements.filter((item) => item.role === "dialog").length;
  const afterDialogs = after.elements.filter((item) => item.role === "dialog").length;
  return {
    kind: popupAppeared ? "popup" : beforeUrl.origin !== afterUrl.origin ? "cross-origin-attempt" :
      beforeUrl.pathname === afterUrl.pathname && beforeUrl.search === afterUrl.search && beforeUrl.hash !== afterUrl.hash
        ? "hash-change" : urlChanged ? "same-origin-url-change" : "same-url",
    beforeUrl: before.finalUrl, afterUrl: after.finalUrl, urlChanged,
    titleChanged: before.page.title !== after.page.title,
    uiChanged: evidenceIds(before.text) !== evidenceIds(after.text) || before.accessibility.snapshot !== after.accessibility.snapshot,
    semanticElementsChanged: evidenceIds(before.elements) !== evidenceIds(after.elements),
    interactionCandidatesChanged: evidenceIds(before.interactionCandidates) !== evidenceIds(after.interactionCandidates),
    networkObserved: network.length > 0, dialogAppeared: afterDialogs > beforeDialogs,
    popupAppeared, mutationMethods, highSeveritySafetyIssue: mutationMethods.length > 0,
    provenance: ["before-runtime", "after-runtime", "network", "accessibility"],
  };
}

function evidenceIds(items: Array<{ id: string }>): string { return items.map((item) => item.id).sort().join("|"); }
function sameOrigin(left: string, right: string): boolean {
  try { return new URL(left).origin === new URL(right).origin; } catch { return false; }
}
function normalizePolicyText(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function containsTerm(text: string, term: string): boolean {
  const normalized = normalizePolicyText(term);
  return (` ${text} `).includes(` ${normalized} `);
}
