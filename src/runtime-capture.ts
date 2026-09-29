import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request,
} from "playwright";

export const DEFAULT_RUNTIME_VIEWPORT = { width: 1440, height: 900 } as const;

export interface RuntimeCaptureOptions {
  url: string;
  outputDirectory?: string;
  storageStatePath?: string;
  timeoutMs?: number;
  readinessTimeoutMs?: number;
  candidateTimeoutMs?: number;
}

export type RuntimeCaptureStatus = "complete" | "partial";
export type RuntimeStageStatus = "complete" | "partial" | "failed";

export interface RuntimeCaptureIssue {
  stage: "page-metadata" | "ui" | "interaction-candidates" | "accessibility" | "screenshot";
  classification: "extraction-failed" | "artifact-write-failed";
  message: string;
}

export interface RuntimeCaptureStages {
  navigation: { status: "complete" };
  readiness: { status: "complete" | "partial" };
  pageMetadata: { status: "complete" | "failed" };
  ui: { status: "complete" | "failed" };
  interactionCandidates: { status: "complete" | "failed" };
  accessibility: { status: "complete" | "failed" };
  network: { status: "complete" };
  screenshot: { status: "complete" | "failed" };
}

export interface RuntimeBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RuntimeTextEvidence {
  id: string;
  text: string;
  domPath: string;
  provenance: "dom";
}

export interface RuntimeSelectOption {
  label: string;
  selected: boolean;
  disabled: boolean;
}

export interface RuntimeInteractiveElement {
  id: string;
  type: string;
  role: string;
  accessibleName: string;
  visibleText?: string;
  domPath: string;
  visible: true;
  enabled: boolean;
  boundingBox: RuntimeBoundingBox;
  provenance: Array<"dom" | "accessibility">;
  placeholder?: string;
  inputType?: string;
  required?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  declaredHref?: string;
  resolvedHref?: string;
  options?: RuntimeSelectOption[];
  selectedOption?: string;
}

export type RuntimeCandidateSignalType =
  | "inline-click-handler"
  | "direct-click-listener"
  | "pointer-listener"
  | "focusable"
  | "cursor-pointer";

export type RuntimeCandidateSignalProvenance =
  | "dom-attribute"
  | "browser-event-listener"
  | "computed-style";

export interface RuntimeCandidateSignal {
  type: RuntimeCandidateSignalType;
  provenance: RuntimeCandidateSignalProvenance;
}

export interface RuntimeInteractionCandidate {
  id: string;
  tag: string;
  text: string;
  role: string | null;
  accessibleName: string | null;
  domPath: string;
  tabindex: number | null;
  boundingBox: RuntimeBoundingBox;
  signals: RuntimeCandidateSignal[];
  strength: "strong" | "supporting" | "weak";
  destination: {
    kind: "possible-navigation";
    declaredHref: string;
    resolvedHref: string;
  } | null;
  provenance: RuntimeCandidateSignalProvenance[];
}

export interface RuntimeSemanticEvidence {
  format: "playwright-aria-snapshot-v1";
  snapshot: string;
  provenance: "accessibility";
}

export interface RuntimeNetworkObservation {
  id: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  provenance: "network";
}

export interface RuntimeBrowserError {
  type: "console" | "page";
  message: string;
  provenance: "console" | "browser";
}

export interface RuntimeCaptureManifest {
  id: string;
  status: RuntimeCaptureStatus;
  requestedUrl: string;
  finalUrl: string;
  capturedAt: string;
  viewport: { width: number; height: number };
  navigation: {
    success: true;
    redirected: boolean;
    status?: number;
  };
  readiness: {
    status: "ready" | "partial";
    reason: "network-idle" | "network-active";
    timeoutMs: number;
  };
  stages: RuntimeCaptureStages;
  issues: RuntimeCaptureIssue[];
  page: { title: string };
  text: RuntimeTextEvidence[];
  elements: RuntimeInteractiveElement[];
  interactionCandidates: RuntimeInteractionCandidate[];
  accessibility: RuntimeSemanticEvidence;
  network: RuntimeNetworkObservation[];
  consoleErrors: RuntimeBrowserError[];
  pageErrors: RuntimeBrowserError[];
  screenshot: {
    path: string;
    width: number;
    height: number;
    fullPage: false;
    captured: boolean;
    provenance: "screenshot";
  };
}

export type RuntimeCaptureFailureStage =
  | "validation"
  | "browser-launch"
  | "navigation"
  | "capture"
  | "artifact";

export type RuntimeCaptureFailureClassification =
  | "invalid-url"
  | "unsupported-url-scheme"
  | "browser-not-installed"
  | "navigation-failed"
  | "capture-failed"
  | "artifact-write-failed";

export interface RuntimeCaptureFailure {
  requestedUrl: string;
  stage: RuntimeCaptureFailureStage;
  classification: RuntimeCaptureFailureClassification;
  message: string;
}

export class RuntimeCaptureError extends Error {
  readonly failure: RuntimeCaptureFailure;

  constructor(failure: RuntimeCaptureFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "RuntimeCaptureError";
    this.failure = failure;
  }
}

interface DomElementEvidence {
  type: string;
  fallbackRole: string;
  fallbackName: string;
  visibleText: string;
  domPath: string;
  enabled: boolean;
  placeholder?: string;
  inputType?: string;
  required?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  declaredHref?: string;
  resolvedHref?: string;
  options?: RuntimeSelectOption[];
  selectedOption?: string;
}

export function validateRuntimeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new RuntimeCaptureError({
      requestedUrl: value,
      stage: "validation",
      classification: "invalid-url",
      message: `Invalid runtime capture URL: ${value}`,
    }, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RuntimeCaptureError({
      requestedUrl: value,
      stage: "validation",
      classification: "unsupported-url-scheme",
      message: `Unsupported runtime capture URL scheme: ${url.protocol}`,
    });
  }
  return url;
}

export async function captureRuntimePage(
  options: RuntimeCaptureOptions,
): Promise<RuntimeCaptureManifest> {
  const navigationUrl = validateRuntimeUrl(options.url).href;
  const requestedUrl = sanitizeRuntimeUrl(navigationUrl);
  const outputDirectory = path.resolve(options.outputDirectory ?? "artifacts/runtime");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 2_000;
  const candidateTimeoutMs = options.candidateTimeoutMs ?? 3_000;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = /executable doesn't exist|browser.*not found|playwright install/i.test(message);
      throw new RuntimeCaptureError({
        requestedUrl,
        stage: "browser-launch",
        classification: missing ? "browser-not-installed" : "capture-failed",
        message: missing
          ? "Playwright Chromium is not installed. Run: npx playwright install chromium"
          : "Unable to launch Playwright Chromium",
      }, { cause: error });
    }

    context = await browser.newContext({
      viewport: DEFAULT_RUNTIME_VIEWPORT,
      ...(options.storageStatePath ? { storageState: options.storageStatePath } : {}),
    });
    page = await context.newPage();
    const network: RuntimeNetworkObservation[] = [];
    const requests = new WeakMap<Request, RuntimeNetworkObservation>();
    const consoleErrors: RuntimeBrowserError[] = [];
    const pageErrors: RuntimeBrowserError[] = [];

    page.on("request", (request) => {
      const observation: RuntimeNetworkObservation = {
        id: networkId(request.method(), request.url(), request.resourceType(), network.length),
        method: request.method(),
        url: sanitizeRuntimeUrl(request.url()),
        resourceType: request.resourceType(),
        provenance: "network",
      };
      network.push(observation);
      requests.set(request, observation);
    });
    page.on("response", (response) => {
      const observation = requests.get(response.request());
      if (observation) observation.status = response.status();
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(readConsoleError(message));
    });
    page.on("pageerror", (error) => {
      pageErrors.push({ type: "page", message: normalizeText(error.message), provenance: "browser" });
    });

    let navigationResponse;
    try {
      navigationResponse = await page.goto(navigationUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
    } catch (error) {
      throw new RuntimeCaptureError({
        requestedUrl,
        stage: "navigation",
        classification: "navigation-failed",
        message: `Runtime navigation failed for ${requestedUrl}`,
      }, { cause: error });
    }

    const capturedAt = new Date().toISOString();
    const finalUrl = sanitizeRuntimeUrl(page.url());
    const captureId = stableHash(`${requestedUrl}|${finalUrl}|${capturedAt}`);
    const screenshotPath = path.join(outputDirectory, `runtime-${captureId}.png`);
    const issues: RuntimeCaptureIssue[] = [];
    let readiness: RuntimeCaptureManifest["readiness"];
    try {
      await page.waitForLoadState("networkidle", { timeout: readinessTimeoutMs });
      readiness = { status: "ready", reason: "network-idle", timeoutMs: readinessTimeoutMs };
    } catch {
      readiness = { status: "partial", reason: "network-active", timeoutMs: readinessTimeoutMs };
    }

    let title = "";
    let pageMetadataStatus: "complete" | "failed" = "complete";
    try {
      title = normalizeText(await page.title());
    } catch {
      pageMetadataStatus = "failed";
      issues.push(stageIssue("page-metadata", "extraction-failed", "Page metadata extraction failed"));
    }

    let elements: RuntimeInteractiveElement[] = [];
    let text: RuntimeTextEvidence[] = [];
    let uiStatus: "complete" | "failed" = "complete";
    try {
      elements = await captureInteractiveElements(page);
      text = await captureVisibleText(page);
    } catch {
      uiStatus = "failed";
      issues.push(stageIssue("ui", "extraction-failed", "Runtime UI extraction failed"));
    }

    let interactionCandidates: RuntimeInteractionCandidate[] = [];
    let candidateStatus: "complete" | "failed" = "complete";
    try {
      interactionCandidates = await withTimeout(
        captureInteractionCandidates(page),
        candidateTimeoutMs,
        "Interaction candidate extraction timed out",
      );
    } catch {
      candidateStatus = "failed";
      issues.push(stageIssue("interaction-candidates", "extraction-failed",
        "Interaction candidate extraction failed"));
    }

    let accessibility: RuntimeSemanticEvidence = {
      format: "playwright-aria-snapshot-v1",
      snapshot: "",
      provenance: "accessibility",
    };
    let accessibilityStatus: "complete" | "failed" = "complete";
    try {
      accessibility = {
        ...accessibility,
        snapshot: sanitizeAriaSnapshot(await page.locator("body").ariaSnapshot()),
      };
    } catch {
      accessibilityStatus = "failed";
      issues.push(stageIssue("accessibility", "extraction-failed", "Accessibility extraction failed"));
    }

    let screenshotStatus: "complete" | "failed" = "complete";
    try {
      await mkdir(outputDirectory, { recursive: true });
      await page.screenshot({ path: screenshotPath, type: "png", fullPage: false });
    } catch {
      screenshotStatus = "failed";
      issues.push(stageIssue("screenshot", "artifact-write-failed",
        "Runtime screenshot could not be written"));
    }
    normalizeNetwork(network);
    const status: RuntimeCaptureStatus = readiness.status === "partial" || issues.length > 0
      ? "partial"
      : "complete";

    return {
      id: `runtime:${stableHash(`${requestedUrl}|${finalUrl}`)}:${captureId}`,
      status,
      requestedUrl,
      finalUrl,
      capturedAt,
      viewport: { ...DEFAULT_RUNTIME_VIEWPORT },
      navigation: {
        success: true,
        redirected: finalUrl !== requestedUrl,
        ...(navigationResponse ? { status: navigationResponse.status() } : {}),
      },
      readiness,
      stages: {
        navigation: { status: "complete" },
        readiness: { status: readiness.status === "ready" ? "complete" : "partial" },
        pageMetadata: { status: pageMetadataStatus },
        ui: { status: uiStatus },
        interactionCandidates: { status: candidateStatus },
        accessibility: { status: accessibilityStatus },
        network: { status: "complete" },
        screenshot: { status: screenshotStatus },
      },
      issues,
      page: { title },
      text,
      elements,
      interactionCandidates,
      accessibility,
      network,
      consoleErrors,
      pageErrors,
      screenshot: {
        path: screenshotPath,
        width: DEFAULT_RUNTIME_VIEWPORT.width,
        height: DEFAULT_RUNTIME_VIEWPORT.height,
        fullPage: false,
        captured: screenshotStatus === "complete",
        provenance: "screenshot",
      },
    };
  } catch (error) {
    if (error instanceof RuntimeCaptureError) throw error;
    throw new RuntimeCaptureError({
      requestedUrl,
      stage: "capture",
      classification: "capture-failed",
      message: `Runtime capture failed for ${requestedUrl}`,
    }, { cause: error });
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

function stageIssue(
  stage: RuntimeCaptureIssue["stage"],
  classification: RuntimeCaptureIssue["classification"],
  message: string,
): RuntimeCaptureIssue {
  return { stage, classification, message };
}

export async function captureInteractiveElements(page: Page): Promise<RuntimeInteractiveElement[]> {
  const candidates = page.locator("button, a, input, textarea, select, [role]");
  const elements: RuntimeInteractiveElement[] = [];
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const locator = candidates.nth(index);
    if (!(await locator.isVisible())) continue;
    const box = await locator.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) continue;
    const dom = await locator.evaluate(readDomElement);
    const ariaSnapshot = await locator.ariaSnapshot();
    const aria = readAriaIdentity(ariaSnapshot);
    elements.push({
      id: `runtime-element:${stableHash(`${dom.domPath}|${aria.role ?? dom.fallbackRole}|${aria.name ?? dom.fallbackName}`)}`,
      type: dom.type,
      role: aria.role ?? dom.fallbackRole,
      accessibleName: normalizeText(aria.name ?? dom.fallbackName),
      ...(dom.visibleText ? { visibleText: dom.visibleText } : {}),
      domPath: dom.domPath,
      visible: true,
      enabled: dom.enabled,
      boundingBox: roundBox(box),
      provenance: ["dom", "accessibility"],
      ...(dom.placeholder !== undefined ? { placeholder: dom.placeholder } : {}),
      ...(dom.inputType !== undefined ? { inputType: dom.inputType } : {}),
      ...(dom.required !== undefined ? { required: dom.required } : {}),
      ...(dom.disabled !== undefined ? { disabled: dom.disabled } : {}),
      ...(dom.readonly !== undefined ? { readonly: dom.readonly } : {}),
      ...(dom.declaredHref !== undefined ? { declaredHref: dom.declaredHref } : {}),
      ...(dom.resolvedHref !== undefined ? { resolvedHref: dom.resolvedHref } : {}),
      ...(dom.options ? { options: dom.options } : {}),
      ...(dom.selectedOption !== undefined ? { selectedOption: dom.selectedOption } : {}),
    });
  }
  return elements;
}

interface BrowserCandidateRecord {
  tag: string;
  text: string;
  role: string | null;
  accessibleName: string | null;
  domPath: string;
  tabindex: number | null;
  boundingBox: RuntimeBoundingBox;
  signals: RuntimeCandidateSignal[];
  declaredHref: string | null;
  resolvedHref: string | null;
}

export async function captureInteractionCandidates(
  page: Page,
): Promise<RuntimeInteractionCandidate[]> {
  const session = await page.context().newCDPSession(page);
  try {
    const expression = `(${collectBrowserCandidates.toString()})(getEventListeners)`;
    const response = await session.send("Runtime.evaluate", {
      expression,
      includeCommandLineAPI: true,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) throw new Error("Browser candidate inspection failed");
    const records = response.result.value as BrowserCandidateRecord[] | undefined;
    if (!Array.isArray(records)) throw new Error("Browser candidate inspection returned no records");
    return records.map((record) => {
      const strength = candidateStrength(record.signals);
      const provenance = [...new Set(record.signals.map((signal) => signal.provenance))];
      return {
        id: `runtime-candidate:${stableHash(`${record.domPath}|${record.role ?? ""}|${record.text}`)}`,
        tag: record.tag,
        text: record.text,
        role: record.role,
        accessibleName: record.accessibleName,
        domPath: record.domPath,
        tabindex: record.tabindex,
        boundingBox: roundBox(record.boundingBox),
        signals: record.signals,
        strength,
        destination: record.declaredHref && record.resolvedHref
          ? {
              kind: "possible-navigation",
              declaredHref: record.declaredHref,
              resolvedHref: record.resolvedHref,
            }
          : null,
        provenance,
      };
    });
  } finally {
    await session.detach().catch(() => undefined);
  }
}

function collectBrowserCandidates(
  getListeners: (element: Element) => Record<string, unknown[]>,
): BrowserCandidateRecord[] {
  const interactiveTags = new Set(["a", "button", "input", "textarea", "select"]);
  const interactiveRoles = new Set([
    "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab",
    "checkbox", "radio", "switch", "option", "combobox", "textbox", "searchbox",
  ]);
  const pointerEvents = new Set(["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart"]);
  const records: BrowserCandidateRecord[] = [];

  for (const element of document.querySelectorAll("body *")) {
    if (!(element instanceof HTMLElement) || !element.isConnected) continue;
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role")?.trim().toLowerCase() || null;
    if (interactiveTags.has(tag) || (role && interactiveRoles.has(role))) continue;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" ||
      Number(style.opacity) === 0 || box.width <= 0 || box.height <= 0) continue;

    const signals: RuntimeCandidateSignal[] = [];
    if (element.hasAttribute("onclick")) {
      signals.push({ type: "inline-click-handler", provenance: "dom-attribute" });
    }
    const listeners = getListeners(element);
    if ((listeners.click?.length ?? 0) > 0 && !isDelegationRoot(element, box)) {
      signals.push({ type: "direct-click-listener", provenance: "browser-event-listener" });
    }
    if ([...pointerEvents].some((event) => (listeners[event]?.length ?? 0) > 0) &&
      !isDelegationRoot(element, box)) {
      signals.push({ type: "pointer-listener", provenance: "browser-event-listener" });
    }
    const tabindexAttribute = element.getAttribute("tabindex");
    const tabindex = tabindexAttribute === null ? null : Number(tabindexAttribute);
    if (tabindex !== null && Number.isFinite(tabindex) && tabindex >= 0) {
      signals.push({ type: "focusable", provenance: "dom-attribute" });
    }
    const parentCursor = element.parentElement
      ? getComputedStyle(element.parentElement).cursor
      : "auto";
    if (style.cursor === "pointer" && parentCursor !== "pointer") {
      signals.push({ type: "cursor-pointer", provenance: "computed-style" });
    }
    if (signals.length === 0) continue;

    const strong = signals.some((signal) =>
      signal.type === "inline-click-handler" ||
      signal.type === "direct-click-listener" ||
      signal.type === "pointer-listener");
    const semanticDescendant = element.querySelector(
      "a,button,input,textarea,select,[role=button],[role=link],[role=menuitem],[role=tab]," +
      "[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox]",
    );
    if (semanticDescendant && !strong) continue;

    const text = boundedText(element.innerText || "");
    const ariaLabelledBy = element.getAttribute("aria-labelledby")
      ?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    const accessibleName = normalizeCandidateText(
      element.getAttribute("aria-label") ?? ariaLabelledBy ?? element.getAttribute("title") ?? "",
    ) || null;
    const declaredHref = element.getAttribute("href");
    let resolvedHref: string | null = null;
    if (declaredHref) {
      try {
        const url = new URL(declaredHref, document.baseURI);
        for (const key of [...url.searchParams.keys()]) {
          if (/(?:auth|token|code|session|credential|password|secret)/i.test(key)) {
            url.searchParams.set(key, "[REDACTED]");
          }
        }
        const hashQueryIndex = url.hash.indexOf("?");
        if (hashQueryIndex >= 0) {
          const hashPath = url.hash.slice(0, hashQueryIndex);
          const parameters = new URLSearchParams(url.hash.slice(hashQueryIndex + 1));
          for (const key of [...parameters.keys()]) {
            if (/(?:auth|token|code|session|credential|password|secret)/i.test(key)) {
              parameters.set(key, "[REDACTED]");
            }
          }
          url.hash = `${hashPath}?${parameters.toString()}`;
        }
        resolvedHref = url.href;
      } catch {
        resolvedHref = null;
      }
    }
    records.push({
      tag,
      text,
      role,
      accessibleName,
      domPath: structuralPath(element),
      tabindex: tabindex !== null && Number.isFinite(tabindex) ? tabindex : null,
      boundingBox: { x: box.x, y: box.y, width: box.width, height: box.height },
      signals,
      declaredHref,
      resolvedHref,
    });
  }
  return records;

  function isDelegationRoot(element: HTMLElement, box: DOMRect): boolean {
    if (element === document.body || element === document.documentElement) return true;
    const viewportArea = Math.max(1, innerWidth * innerHeight);
    return box.width * box.height / viewportArea > 0.8;
  }

  function boundedText(value: string): string {
    const normalized = normalizeCandidateText(value);
    return normalized.length <= 200 ? normalized : `${normalized.slice(0, 197)}...`;
  }

  function normalizeCandidateText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function structuralPath(element: Element): string {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement) {
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((child) => child.tagName === current!.tagName)
        : [];
      parts.push(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
      current = current.parentElement;
    }
    return `html>${parts.reverse().join(">")}`;
  }
}

function candidateStrength(
  signals: RuntimeCandidateSignal[],
): RuntimeInteractionCandidate["strength"] {
  if (signals.some((signal) =>
    signal.type === "inline-click-handler" ||
    signal.type === "direct-click-listener" ||
    signal.type === "pointer-listener")) return "strong";
  if (signals.some((signal) => signal.type === "focusable")) return "supporting";
  return "weak";
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (timeoutMs <= 0) throw new Error(message);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function captureVisibleText(page: Page): Promise<RuntimeTextEvidence[]> {
  const records = await page.locator("body *").evaluateAll((elements) => {
    const result: Array<{ text: string; domPath: string }> = [];
    for (const item of elements) {
      if (!(item instanceof HTMLElement)) continue;
      const style = getComputedStyle(item);
      const box = item.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || box.width <= 0 || box.height <= 0) continue;
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(item.tagName)) continue;
      const hasVisibleElementChild = [...item.children].some((child) => {
        const childBox = child.getBoundingClientRect();
        const childStyle = getComputedStyle(child);
        return childStyle.display !== "none" && childStyle.visibility !== "hidden" &&
          childBox.width > 0 && childBox.height > 0;
      });
      if (hasVisibleElementChild) continue;
      const text = (item.innerText || "").replace(/\s+/g, " ").trim();
      if (text) result.push({ text, domPath: structuralPath(item) });
    }
    return result;

    function structuralPath(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.documentElement) {
        const siblings = current.parentElement
          ? [...current.parentElement.children].filter((child) => child.tagName === current!.tagName)
          : [];
        parts.push(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
        current = current.parentElement;
      }
      return `html>${parts.reverse().join(">")}`;
    }
  });
  return records.map((record) => ({
    id: `runtime-text:${stableHash(`${record.domPath}|${record.text}`)}`,
    text: normalizeText(record.text),
    domPath: record.domPath,
    provenance: "dom",
  }));
}

function readDomElement(element: Element): DomElementEvidence {
  const html = element as HTMLElement;
  const input = element instanceof HTMLInputElement ? element : undefined;
  const textarea = element instanceof HTMLTextAreaElement ? element : undefined;
  const select = element instanceof HTMLSelectElement ? element : undefined;
  const button = element instanceof HTMLButtonElement ? element : undefined;
  const link = element instanceof HTMLAnchorElement ? element : undefined;
  const formControl = input ?? textarea ?? select;
  const disableableControl = formControl ?? button;
  const type = element.tagName.toLowerCase();
  const visibleText = normalizeBrowserText(html.innerText || "");
  const labelledBy = element.getAttribute("aria-labelledby")
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
  const labels = formControl ? [...formControl.labels ?? []].map((label) => label.innerText).join(" ") : "";
  const fallbackName = normalizeBrowserText(
    element.getAttribute("aria-label") ?? labelledBy ?? labels ??
      element.getAttribute("title") ?? visibleText ?? element.getAttribute("placeholder") ?? "",
  );
  return {
    type,
    fallbackRole: element.getAttribute("role") ?? defaultRole(element),
    fallbackName,
    visibleText,
    domPath: structuralPath(element),
    enabled: !(disableableControl?.disabled ?? element.getAttribute("aria-disabled") === "true"),
    ...(formControl ? {
      required: formControl.required,
      disabled: formControl.disabled,
    } : {}),
    ...(button ? { disabled: button.disabled } : {}),
    ...(input || textarea ? {
      placeholder: input?.placeholder ?? textarea?.placeholder ?? "",
      readonly: input?.readOnly ?? textarea?.readOnly ?? false,
    } : {}),
    ...(input ? { inputType: input.type } : {}),
    ...(link ? {
      declaredHref: link.getAttribute("href") ?? "",
      resolvedHref: sanitizeBrowserUrl(link.href),
    } : {}),
    ...(select ? {
      options: [...select.options].map((option) => ({
        label: normalizeBrowserText(option.label),
        selected: option.selected,
        disabled: option.disabled,
      })),
      selectedOption: normalizeBrowserText(select.selectedOptions[0]?.label ?? ""),
    } : {}),
  };

  function structuralPath(item: Element): string {
    const parts: string[] = [];
    let current: Element | null = item;
    while (current && current !== document.documentElement) {
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((child) => child.tagName === current!.tagName)
        : [];
      parts.push(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
      current = current.parentElement;
    }
    return `html>${parts.reverse().join(">")}`;
  }

  function defaultRole(item: Element): string {
    if (item instanceof HTMLButtonElement) return "button";
    if (item instanceof HTMLAnchorElement && item.hasAttribute("href")) return "link";
    if (item instanceof HTMLTextAreaElement) return "textbox";
    if (item instanceof HTMLSelectElement) return "combobox";
    if (item instanceof HTMLInputElement) {
      if (item.type === "checkbox") return "checkbox";
      if (item.type === "radio") return "radio";
      if (item.type === "button" || item.type === "submit" || item.type === "reset") return "button";
      return "textbox";
    }
    return item.getAttribute("role") ?? "generic";
  }

  function normalizeBrowserText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function sanitizeBrowserUrl(value: string): string {
    try {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()]) {
        if (/(?:auth|token|code|session|credential|password|secret)/i.test(key)) {
          url.searchParams.set(key, "[REDACTED]");
        }
      }
      const hashQueryIndex = url.hash.indexOf("?");
      if (hashQueryIndex >= 0) {
        const hashPath = url.hash.slice(0, hashQueryIndex);
        const parameters = new URLSearchParams(url.hash.slice(hashQueryIndex + 1));
        for (const key of [...parameters.keys()]) {
          if (/(?:auth|token|code|session|credential|password|secret)/i.test(key)) {
            parameters.set(key, "[REDACTED]");
          }
        }
        url.hash = `${hashPath}?${parameters.toString()}`;
      }
      return url.href;
    } catch {
      return value;
    }
  }
}

function readAriaIdentity(snapshot: string): { role?: string; name?: string } {
  const first = snapshot.split("\n").find((line) => line.trim().startsWith("- "))?.trim();
  if (!first) return {};
  const match = /^- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(first);
  if (!match) return {};
  return {
    ...(match[1] ? { role: match[1] } : {}),
    ...(match[2] !== undefined ? { name: match[2].replaceAll('\\"', '"') } : {}),
  };
}

export function sanitizeAriaSnapshot(snapshot: string): string {
  return snapshot.replace(
    /^(\s*- (?:textbox|searchbox)(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]+\])?):.*$/gm,
    "$1",
  );
}

function roundBox(box: RuntimeBoundingBox): RuntimeBoundingBox {
  return {
    x: round(box.x),
    y: round(box.y),
    width: round(box.width),
    height: round(box.height),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function readConsoleError(message: ConsoleMessage): RuntimeBrowserError {
  return { type: "console", message: normalizeText(message.text()), provenance: "console" };
}

function networkId(method: string, url: string, resourceType: string, occurrence: number): string {
  return `runtime-network:${stableHash(`${method}|${url}|${resourceType}`)}:${occurrence + 1}`;
}

export function normalizeNetwork(network: RuntimeNetworkObservation[]): void {
  network.sort((left, right) => {
    const leftKey = `${left.method}\0${left.url}\0${left.resourceType}`;
    const rightKey = `${right.method}\0${right.url}\0${right.resourceType}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const occurrences = new Map<string, number>();
  for (const item of network) {
    const key = `${item.method}|${item.url}|${item.resourceType}`;
    const occurrence = occurrences.get(key) ?? 0;
    item.id = networkId(item.method, item.url, item.resourceType, occurrence);
    occurrences.set(key, occurrence + 1);
  }
}

export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function sanitizeRuntimeUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:auth|token|code|session|credential|password|secret)/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    const hashQueryIndex = url.hash.indexOf("?");
    if (hashQueryIndex >= 0) {
      const hashPath = url.hash.slice(0, hashQueryIndex);
      const parameters = new URLSearchParams(url.hash.slice(hashQueryIndex + 1));
      for (const key of [...parameters.keys()]) {
        if (/(?:auth|token|code|session|credential|password|secret)/i.test(key)) {
          parameters.set(key, "[REDACTED]");
        }
      }
      url.hash = `${hashPath}?${parameters.toString()}`;
    }
    return url.href;
  } catch {
    return value;
  }
}
