import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import { DEFAULT_RUNTIME_VIEWPORT, validateRuntimeUrl } from "./runtime-capture.js";

export type AuthenticationRole = Parameters<Page["getByRole"]>[0];

export type AuthenticationLocator =
  | { by: "label"; value: string }
  | { by: "placeholder"; value: string }
  | { by: "testId"; value: string }
  | { by: "css"; value: string }
  | { by: "role"; role: AuthenticationRole; name: string };

export type AuthenticationSuccessCondition =
  | { type: "url"; pattern: string }
  | { type: "element"; locator: AuthenticationLocator };

export interface AuthenticationCredentials {
  username: string;
  password: string;
}

export interface CreateAuthenticatedSessionOptions {
  loginUrl: string;
  credentials: AuthenticationCredentials;
  locators: {
    username: AuthenticationLocator;
    password: AuthenticationLocator;
    submit: AuthenticationLocator;
  };
  success: AuthenticationSuccessCondition;
  outputDirectory?: string;
  accountLabel?: string;
  timeoutMs?: number;
}

export interface AuthenticationSessionManifest {
  id: string;
  loginUrl: string;
  finalUrl: string;
  authenticatedAt: string;
  accountLabel?: string;
  successCondition: {
    type: AuthenticationSuccessCondition["type"];
  };
  storageState: {
    path: string;
    sensitive: true;
  };
  manifestPath: string;
}

export type AuthenticationFailureStage =
  | "validation"
  | "browser-launch"
  | "login-navigation"
  | "username"
  | "password"
  | "submit"
  | "success"
  | "artifact";

export type AuthenticationFailureClassification =
  | "invalid-configuration"
  | "browser-not-installed"
  | "login-page-unreachable"
  | "username-field-not-found"
  | "password-field-not-found"
  | "submit-control-not-found"
  | "authentication-timeout"
  | "success-condition-not-met"
  | "artifact-write-failed";

export interface AuthenticationFailure {
  loginUrl: string;
  finalUrl?: string;
  stage: AuthenticationFailureStage;
  classification: AuthenticationFailureClassification;
  message: string;
  diagnosticScreenshot?: {
    path: string;
    sensitive: false;
  };
}

export class AuthenticationSessionError extends Error {
  readonly failure: AuthenticationFailure;

  constructor(failure: AuthenticationFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "AuthenticationSessionError";
    this.failure = failure;
  }
}

export async function createAuthenticatedSession(
  options: CreateAuthenticatedSessionOptions,
): Promise<AuthenticationSessionManifest> {
  const loginUrl = validateAuthenticationOptions(options);
  const authenticatedAt = new Date().toISOString();
  const attemptId = stableHash(`${loginUrl}|${authenticatedAt}`);
  const rootDirectory = path.resolve(
    options.outputDirectory ?? "artifacts/runtime/sessions",
  );
  const sessionDirectory = path.join(rootDirectory, `session-${attemptId}`);
  const storageStatePath = path.join(sessionDirectory, "storage-state.json");
  const manifestPath = path.join(sessionDirectory, "session-manifest.json");
  const failureScreenshotPath = path.join(sessionDirectory, "authentication-failure.png");
  const timeoutMs = options.timeoutMs ?? 30_000;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let usernameLocator: Locator | undefined;
  let passwordLocator: Locator | undefined;

  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = /executable doesn't exist|browser.*not found|playwright install/i.test(message);
      throw new AuthenticationSessionError({
        loginUrl,
        stage: "browser-launch",
        classification: missing ? "browser-not-installed" : "invalid-configuration",
        message: missing
          ? "Playwright Chromium is not installed. Run: npx playwright install chromium"
          : "Unable to launch Playwright Chromium for authentication",
      }, { cause: error });
    }

    context = await browser.newContext({ viewport: DEFAULT_RUNTIME_VIEWPORT });
    page = await context.newPage();
    try {
      await page.goto(loginUrl, { waitUntil: "networkidle", timeout: timeoutMs });
    } catch (error) {
      throw authError(loginUrl, page.url(), "login-navigation", "login-page-unreachable",
        "Authentication login page could not be reached", error);
    }

    usernameLocator = createLocator(page, options.locators.username);
    await requireVisibleLocator(
      usernameLocator,
      timeoutMs,
      () => authError(loginUrl, page!.url(), "username", "username-field-not-found",
        "Configured username field was not found"),
    );
    await usernameLocator.fill(options.credentials.username);

    passwordLocator = createLocator(page, options.locators.password);
    await requireVisibleLocator(
      passwordLocator,
      timeoutMs,
      () => authError(loginUrl, page!.url(), "password", "password-field-not-found",
        "Configured password field was not found"),
    );
    await passwordLocator.fill(options.credentials.password);

    const submitLocator = createLocator(page, options.locators.submit);
    await requireVisibleLocator(
      submitLocator,
      timeoutMs,
      () => authError(loginUrl, page!.url(), "submit", "submit-control-not-found",
        "Configured authentication submit control was not found"),
    );
    await submitLocator.click();

    try {
      await waitForSuccess(page, options.success, timeoutMs);
    } catch (error) {
      throw authError(loginUrl, page.url(), "success", "authentication-timeout",
        "Authentication did not reach the configured success condition", error);
    }

    const finalUrl = page.url();
    const sessionId = `session:${stableHash(`${loginUrl}|${finalUrl}|${authenticatedAt}`)}:${attemptId}`;
    const manifest: AuthenticationSessionManifest = {
      id: sessionId,
      loginUrl,
      finalUrl,
      authenticatedAt,
      ...(options.accountLabel ? { accountLabel: options.accountLabel } : {}),
      successCondition: { type: options.success.type },
      storageState: { path: storageStatePath, sensitive: true },
      manifestPath,
    };

    try {
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
      await chmod(sessionDirectory, 0o700);
      await context.storageState({ path: storageStatePath });
      await chmod(storageStatePath, 0o600);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(manifestPath, 0o600);
    } catch (error) {
      throw authError(loginUrl, finalUrl, "artifact", "artifact-write-failed",
        "Unable to write authenticated session artifacts", error);
    }
    return manifest;
  } catch (error) {
    const authFailure = error instanceof AuthenticationSessionError
      ? error
      : authError(loginUrl, page?.url(), "success", "success-condition-not-met",
          "Authentication failed before reaching the configured success condition", error);
    if (page) {
      await writeSafeFailureScreenshot(
        page,
        usernameLocator,
        passwordLocator,
        sessionDirectory,
        failureScreenshotPath,
      );
      authFailure.failure.diagnosticScreenshot = {
        path: failureScreenshotPath,
        sensitive: false,
      };
    }
    throw authFailure;
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

function validateAuthenticationOptions(options: CreateAuthenticatedSessionOptions): string {
  let loginUrl: string;
  try {
    loginUrl = validateRuntimeUrl(options.loginUrl).href;
  } catch (error) {
    throw new AuthenticationSessionError({
      loginUrl: options.loginUrl,
      stage: "validation",
      classification: "invalid-configuration",
      message: "Authentication login URL must be a valid HTTP or HTTPS URL",
    }, { cause: error });
  }
  if (!options.credentials.username || !options.credentials.password) {
    throw new AuthenticationSessionError({
      loginUrl,
      stage: "validation",
      classification: "invalid-configuration",
      message: "Authentication credentials are required in memory",
    });
  }
  if (options.success.type === "url" && !options.success.pattern) {
    throw new AuthenticationSessionError({
      loginUrl,
      stage: "validation",
      classification: "invalid-configuration",
      message: "Authentication URL success pattern is required",
    });
  }
  return loginUrl;
}

function createLocator(page: Page, locator: AuthenticationLocator): Locator {
  switch (locator.by) {
    case "label":
      return page.getByLabel(locator.value, { exact: true });
    case "placeholder":
      return page.getByPlaceholder(locator.value, { exact: true });
    case "testId":
      return page.getByTestId(locator.value);
    case "role":
      return page.getByRole(locator.role, { name: locator.name, exact: true });
    case "css":
      return page.locator(locator.value);
  }
}

async function requireVisibleLocator(
  locator: Locator,
  timeoutMs: number,
  failure: () => AuthenticationSessionError,
): Promise<void> {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    throw failure();
  }
}

async function waitForSuccess(
  page: Page,
  success: AuthenticationSuccessCondition,
  timeoutMs: number,
): Promise<void> {
  if (success.type === "url") {
    await page.waitForURL((url) => url.href.includes(success.pattern), { timeout: timeoutMs });
    return;
  }
  await createLocator(page, success.locator).waitFor({ state: "visible", timeout: timeoutMs });
}

async function writeSafeFailureScreenshot(
  page: Page,
  username: Locator | undefined,
  password: Locator | undefined,
  sessionDirectory: string,
  screenshotPath: string,
): Promise<void> {
  try {
    await username?.fill("", { timeout: 100 }).catch(() => undefined);
    await password?.fill("", { timeout: 100 }).catch(() => undefined);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await chmod(sessionDirectory, 0o700);
    await page.screenshot({ path: screenshotPath, type: "png", fullPage: false });
    await chmod(screenshotPath, 0o600);
  } catch {
    // Diagnostic capture must not replace the original authentication failure.
  }
}

function authError(
  loginUrl: string,
  finalUrl: string | undefined,
  stage: AuthenticationFailureStage,
  classification: AuthenticationFailureClassification,
  message: string,
  cause?: unknown,
): AuthenticationSessionError {
  return new AuthenticationSessionError({
    loginUrl,
    ...(finalUrl ? { finalUrl } : {}),
    stage,
    classification,
    message,
  }, { cause });
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
