import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import {
  AuthenticationSessionError,
  createAuthenticatedSession,
  type AuthenticationLocator,
} from "../src/authenticated-session.js";
import { captureRuntimePage } from "../src/runtime-capture.js";

const execFileAsync = promisify(execFile);
const USERNAME = "demo@example.test";
const PASSWORD = "test-password";
let server: Server | undefined;
let baseUrl = "";
let requestedPaths: string[] = [];
const artifactDirectories: string[] = [];

beforeEach(async () => {
  requestedPaths = [];
  server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    requestedPaths.push(requestUrl.pathname);
    if (requestUrl.pathname === "/login" && request.method === "POST") {
      const body = new URLSearchParams(await readBody(request));
      if (body.get("email") === USERNAME && body.get("password") === PASSWORD) {
        response.writeHead(302, {
          location: "/dashboard",
          "set-cookie": "demo_session=valid; HttpOnly; SameSite=Lax; Path=/",
        });
        response.end();
      } else if (body.get("email") === "mfa@example.test") {
        response.writeHead(302, { location: "/mfa" });
        response.end();
      } else if (body.get("email") === "captcha@example.test") {
        response.writeHead(302, { location: "/captcha" });
        response.end();
      } else {
        response.writeHead(401, { "content-type": "text/html" });
        response.end(loginHtml("Invalid credentials"));
      }
      return;
    }
    if (requestUrl.pathname === "/login") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(loginHtml());
      return;
    }
    if (requestUrl.pathname === "/dashboard") {
      if (!isAuthenticated(request)) return redirectToLogin(response);
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><title>Dashboard</title><nav aria-label="Main navigation">Dashboard</nav>');
      return;
    }
    if (requestUrl.pathname === "/tickets") {
      if (!isAuthenticated(request)) return redirectToLogin(response);
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>Tickets</title><h1>Tickets</h1>
        <button onclick="fetch('/product-action', {method:'POST'})">Create Ticket</button>
        <input aria-label="Search"><select aria-label="Status"><option>Open</option></select>`);
      return;
    }
    if (requestUrl.pathname === "/mfa") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>MFA</title><h1>Enter verification code</h1>");
      return;
    }
    if (requestUrl.pathname === "/captcha") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>CAPTCHA</title><h1>Complete CAPTCHA</h1>");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Auth fixture has no TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((error) => error ? reject(error) : resolve());
  });
  server = undefined;
  await Promise.all(
    artifactDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("authenticates by label and role, writes protected state, and enables capture", async () => {
  const outputDirectory = artifactDirectory("success");
  const session = await createAuthenticatedSession({
    loginUrl: `${baseUrl}/login`,
    credentials: { username: USERNAME, password: PASSWORD },
    locators: {
      username: { by: "label", value: "Email" },
      password: { by: "label", value: "Password" },
      submit: { by: "role", role: "button", name: "Sign In" },
    },
    success: { type: "url", pattern: "/dashboard" },
    accountLabel: "Demo Admin",
    outputDirectory,
  });

  assert.equal(session.loginUrl, `${baseUrl}/login`);
  assert.equal(session.finalUrl, `${baseUrl}/dashboard`);
  assert.equal(session.accountLabel, "Demo Admin");
  assert.equal(session.successCondition.type, "url");
  assert.equal(session.storageState.sensitive, true);
  assert.doesNotThrow(() => JSON.stringify(session));
  assert.doesNotMatch(JSON.stringify(session), /demo@example\.test|test-password|demo_session|valid/);

  const manifestText = await readFile(session.manifestPath, "utf8");
  assert.doesNotMatch(manifestText, /demo@example\.test|test-password|demo_session|valid/);
  const storageText = await readFile(session.storageState.path, "utf8");
  assert.match(storageText, /demo_session/);
  assert.equal((await stat(session.storageState.path)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(session.storageState.path))).mode & 0o777, 0o700);

  const authenticated = await captureRuntimePage({
    url: `${baseUrl}/tickets`,
    storageStatePath: session.storageState.path,
    outputDirectory: artifactDirectory("authenticated-capture"),
  });
  assert.equal(authenticated.finalUrl, `${baseUrl}/tickets`);
  assert.equal(authenticated.page.title, "Tickets");
  assert.ok(authenticated.elements.some((element) => element.accessibleName === "Create Ticket"));
  assert.equal(requestedPaths.includes("/product-action"), false);

  const anonymous = await captureRuntimePage({
    url: `${baseUrl}/tickets`,
    outputDirectory: artifactDirectory("anonymous-capture"),
  });
  assert.equal(anonymous.finalUrl, `${baseUrl}/login`);
});

test("supports placeholder, test ID, CSS, and element success locators", async () => {
  const cases: Array<{
    name: string;
    username: AuthenticationLocator;
    password: AuthenticationLocator;
    submit: AuthenticationLocator;
  }> = [
    {
      name: "placeholder",
      username: { by: "placeholder", value: "Email address" },
      password: { by: "placeholder", value: "Account password" },
      submit: { by: "testId", value: "sign-in" },
    },
    {
      name: "test-id-css",
      username: { by: "testId", value: "email" },
      password: { by: "css", value: "#password" },
      submit: { by: "css", value: "button[type=submit]" },
    },
  ];
  for (const item of cases) {
    const session = await createAuthenticatedSession({
      loginUrl: `${baseUrl}/login`,
      credentials: { username: USERNAME, password: PASSWORD },
      locators: {
        username: item.username,
        password: item.password,
        submit: item.submit,
      },
      success: {
        type: "element",
        locator: { by: "role", role: "navigation", name: "Main navigation" },
      },
      outputDirectory: artifactDirectory(item.name),
    });
    assert.equal(session.successCondition.type, "element");
    assert.equal(session.finalUrl, `${baseUrl}/dashboard`);
  }
});

test("returns safe structured failures for fields, submit, credentials, MFA, and CAPTCHA", async () => {
  const cases: Array<{
    name: string;
    username?: string;
    password?: string;
    locators?: Partial<{
      username: AuthenticationLocator;
      password: AuthenticationLocator;
      submit: AuthenticationLocator;
    }>;
    classification: string;
  }> = [
    {
      name: "missing-username",
      locators: { username: { by: "label", value: "Unknown Email" } },
      classification: "username-field-not-found",
    },
    {
      name: "missing-password",
      locators: { password: { by: "label", value: "Unknown Password" } },
      classification: "password-field-not-found",
    },
    {
      name: "missing-submit",
      locators: { submit: { by: "role", role: "button", name: "Unknown Submit" } },
      classification: "submit-control-not-found",
    },
    { name: "bad-credentials", password: "wrong-password", classification: "authentication-timeout" },
    { name: "mfa", username: "mfa@example.test", classification: "authentication-timeout" },
    { name: "captcha", username: "captcha@example.test", classification: "authentication-timeout" },
  ];

  for (const item of cases) {
    const outputDirectory = artifactDirectory(item.name);
    let captured: AuthenticationSessionError | undefined;
    try {
      await createAuthenticatedSession({
        loginUrl: `${baseUrl}/login`,
        credentials: {
          username: item.username ?? USERNAME,
          password: item.password ?? PASSWORD,
        },
        locators: {
          username: item.locators?.username ?? { by: "label", value: "Email" },
          password: item.locators?.password ?? { by: "label", value: "Password" },
          submit: item.locators?.submit ?? { by: "role", role: "button", name: "Sign In" },
        },
        success: { type: "url", pattern: "/dashboard" },
        outputDirectory,
        timeoutMs: 800,
      });
    } catch (error) {
      if (error instanceof AuthenticationSessionError) captured = error;
      else throw error;
    }
    assert.ok(captured);
    assert.equal(captured.failure.classification, item.classification);
    const serialized = JSON.stringify(captured.failure);
    assert.doesNotMatch(serialized, /test-password|wrong-password|demo@example\.test|mfa@example\.test|captcha@example\.test/);
    assert.ok(captured.failure.diagnosticScreenshot);
    const screenshot = await readFile(captured.failure.diagnosticScreenshot.path);
    assert.equal(screenshot.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(screenshot.includes(Buffer.from(PASSWORD)), false);
    if (item.password) assert.equal(screenshot.includes(Buffer.from(item.password)), false);
  }

  const recovered = await createAuthenticatedSession({
    loginUrl: `${baseUrl}/login`,
    credentials: { username: USERNAME, password: PASSWORD },
    locators: defaultLocators(),
    success: { type: "url", pattern: "/dashboard" },
    outputDirectory: artifactDirectory("after-failures"),
  });
  assert.equal(recovered.finalUrl, `${baseUrl}/dashboard`);
});

test("invalid or expired state redirects to login and default sessions are Git-ignored", async () => {
  const stateDirectory = artifactDirectory("expired");
  await mkdir(stateDirectory, { recursive: true });
  const statePath = path.join(stateDirectory, "storage-state.json");
  await writeFile(statePath, JSON.stringify({ cookies: [], origins: [] }), "utf8");
  const capture = await captureRuntimePage({
    url: `${baseUrl}/tickets`,
    storageStatePath: statePath,
    outputDirectory: artifactDirectory("expired-capture"),
  });
  assert.equal(capture.requestedUrl, `${baseUrl}/tickets`);
  assert.equal(capture.finalUrl, `${baseUrl}/login`);
  assert.equal(capture.navigation.redirected, true);
  const gitignore = await readFile(".gitignore", "utf8");
  assert.match(gitignore, /^artifacts\/runtime\/sessions\/$/m);
});

test("auth and authenticated capture CLI modes produce safe output", async () => {
  const outputDirectory = artifactDirectory("cli-auth");
  const configPath = path.join(outputDirectory, "auth-config.json");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    loginUrl: `${baseUrl}/login`,
    locators: defaultLocators(),
    success: { type: "url", pattern: "/dashboard" },
    outputDirectory,
    accountLabel: "CLI Demo",
  }), "utf8");

  const authenticated = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "auth", configPath],
    {
      cwd: process.cwd(),
      env: { ...process.env, DEMO_USERNAME: USERNAME, DEMO_PASSWORD: PASSWORD },
    },
  );
  assert.equal(authenticated.stderr, "");
  assert.doesNotMatch(authenticated.stdout, /demo@example\.test|test-password|demo_session|valid/);
  const session = JSON.parse(authenticated.stdout) as {
    storageState: { path: string };
    accountLabel: string;
  };
  assert.equal(session.accountLabel, "CLI Demo");

  const captureOutput = artifactDirectory("cli-capture");
  const captured = await execFileAsync(
    process.execPath,
    [
      "--import", "tsx", "src/cli.ts", "capture", `${baseUrl}/tickets`,
      "--storage-state", session.storageState.path,
      "--output", captureOutput,
    ],
    { cwd: process.cwd() },
  );
  const manifest = JSON.parse(captured.stdout) as { finalUrl: string; page: { title: string } };
  assert.equal(manifest.finalUrl, `${baseUrl}/tickets`);
  assert.equal(manifest.page.title, "Tickets");
});

function defaultLocators(): {
  username: AuthenticationLocator;
  password: AuthenticationLocator;
  submit: AuthenticationLocator;
} {
  return {
    username: { by: "label", value: "Email" },
    password: { by: "label", value: "Password" },
    submit: { by: "role", role: "button", name: "Sign In" },
  };
}

function loginHtml(error = ""): string {
  return `<!doctype html><title>Sign In</title>
    <h1>Sign In</h1>${error ? `<p>${error}</p>` : ""}
    <form method="post" action="/login">
      <label>Email <input name="email" data-testid="email" placeholder="Email address"></label>
      <label>Password <input id="password" name="password" type="password" data-testid="password" placeholder="Account password"></label>
      <button type="submit" data-testid="sign-in">Sign In</button>
    </form>`;
}

function isAuthenticated(request: IncomingMessage): boolean {
  return request.headers.cookie?.includes("demo_session=valid") ?? false;
}

function redirectToLogin(response: import("node:http").ServerResponse): void {
  response.writeHead(302, { location: "/login" });
  response.end();
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function artifactDirectory(name: string): string {
  const directory = path.join(
    tmpdir(),
    `authenticated-session-${name}-${process.pid}-${artifactDirectories.length}`,
  );
  artifactDirectories.push(directory);
  return directory;
}
