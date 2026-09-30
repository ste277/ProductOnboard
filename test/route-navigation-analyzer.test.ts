import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  analyzeRoutesAndNavigation,
  type RouteNavigationManifest,
} from "../src/route-navigation-analyzer.js";
import { scanRepository } from "../src/repository-scanner.js";
import { analyzeSources } from "../src/source-analyzer.js";
import { analyzeUiStructure } from "../src/ui-structure-analyzer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("extracts declarative sibling and nested routes with component provenance", async () => {
  const repository = await createRepository("declarative routes ");
  await createFile(
    repository,
    "src/routes.tsx",
    [
      "export function AppRoutes() {",
      "  return (",
      "    <Routes>",
      '      <Route path="/tickets" element={<TicketList />} />',
      '      <Route path="/settings" element={<Settings />}>',
      '        <Route path="users" element={<Users />} />',
      '        <Route path="/absolute" />',
      "      </Route>",
      "      <Route path={dynamicPath} element={<Dynamic />} />",
      "    </Routes>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );

  const manifest = await analyzeRepository(repository);

  assert.deepEqual(
    manifest.routes.map(({ source, path, declaredPath, parent, component }) => ({
      source,
      path,
      declaredPath,
      parent,
      component,
    })),
    [
      {
        source: "declarative",
        path: { kind: "static", value: "/tickets" },
        declaredPath: { kind: "static", value: "/tickets" },
        parent: undefined,
        component: "TicketList",
      },
      {
        source: "declarative",
        path: { kind: "static", value: "/settings" },
        declaredPath: { kind: "static", value: "/settings" },
        parent: undefined,
        component: "Settings",
      },
      {
        source: "declarative",
        path: { kind: "static", value: "/settings/users" },
        declaredPath: { kind: "static", value: "users" },
        parent: "/settings",
        component: "Users",
      },
      {
        source: "declarative",
        path: { kind: "static", value: "/absolute" },
        declaredPath: { kind: "static", value: "/absolute" },
        parent: "/settings",
        component: undefined,
      },
      {
        source: "declarative",
        path: { kind: "dynamic", expression: "dynamicPath" },
        declaredPath: { kind: "dynamic", expression: "dynamicPath" },
        parent: undefined,
        component: "Dynamic",
      },
    ],
  );
  assert.deepEqual(manifest.routes[0]?.componentLocation, {
    path: "src/routes.tsx",
    startLine: 4,
    endLine: 4,
  });
  assert.deepEqual(manifest.routes[2]?.location, {
    path: "src/routes.tsx",
    startLine: 6,
    endLine: 6,
  });
});

test("extracts React Router 5 components, render callbacks, and exact custom wrappers", async () => {
  const repository = await createRepository("react router five ");
  await createFile(repository, "src/routes.tsx", [
    'import DefaultPage from "./DefaultPage.js";',
    'import { NamedPage, NamedPage as AliasedPage } from "./pages.js";',
    "const SameFilePage = () => <main />;",
    "export const AppRoutes = () => <>",
    '  <Route path="/default" component={DefaultPage} />',
    '  <Route path="/named" component={NamedPage} />',
    '  <Route path="/aliased" component={AliasedPage} />',
    '  <PrivateRoute path="/same" component={SameFilePage} />',
    '  <PrivateRoute path="/render" render={(routeProps) => (<DefaultPage {...routeProps} />)} />',
    '  <PublicRoute path="/block" render={() => { return <NamedPage />; }} />',
    '  <PublicRoute path="/conditional" render={() => enabled ? <NamedPage /> : <DefaultPage />} />',
    '  <Route path="/tree" render={() => <Provider><NamedPage /></Provider>} />',
    '  <Route path="/host" render={() => <div />} />',
    '  <Route path="/hoc" component={withAuth(DefaultPage)} />',
    '  <Card path="/card" component={DefaultPage} />',
    '  <Widget path="/widget" render={() => <DefaultPage />} />',
    '  <PrivateThing path="/private-thing" component={DefaultPage} />',
    "</>;",
    "",
  ].join("\n"));

  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  const ui = analyzeUiStructure(sources);
  const before = JSON.stringify({ inventory, sources, ui });
  const manifest = analyzeRoutesAndNavigation(inventory, sources, ui);

  assert.equal(JSON.stringify({ inventory, sources, ui }), before);
  assert.deepEqual(manifest.routes.map((route) => [
    route.path.kind === "static" ? route.path.value : route.path.expression,
    route.routeElement,
    route.component,
    route.componentIssue?.status,
  ]), [
    ["/default", "Route", "DefaultPage", undefined],
    ["/named", "Route", "NamedPage", undefined],
    ["/aliased", "Route", "AliasedPage", undefined],
    ["/same", "PrivateRoute", "SameFilePage", undefined],
    ["/render", "PrivateRoute", "DefaultPage", undefined],
    ["/block", "PublicRoute", "NamedPage", undefined],
    ["/conditional", "PublicRoute", undefined, "ambiguous"],
    ["/tree", "Route", undefined, "ambiguous"],
    ["/host", "Route", undefined, "unresolved"],
    ["/hoc", "Route", undefined, "unresolved"],
  ]);
  assert.equal(manifest.routes.some((route) =>
    route.path.kind === "static" && ["/card", "/widget", "/private-thing"].includes(route.path.value)), false);
  assert.deepEqual(manifest.routes[4]?.componentLocation, {
    path: "src/routes.tsx", startLine: 9, endLine: 9,
  });
  assert.doesNotThrow(() => JSON.stringify(manifest));
});

test("extracts static route-object arrays and nested children", async () => {
  const repository = await createRepository("object routes ");
  await createFile(
    repository,
    "src/route-config.tsx",
    [
      "export const routes = [",
      '  { path: "/tickets", element: <TicketList /> },',
      "  {",
      '    path: "/settings",',
      "    children: [",
      '      { path: "users", element: <Users /> },',
      "      { path: computedPath },",
      "    ],",
      "  },",
      "];",
      "",
    ].join("\n"),
  );

  const manifest = await analyzeRepository(repository);

  assert.deepEqual(
    manifest.routes.map((route) => [route.source, route.path, route.parent, route.component]),
    [
      ["object", { kind: "static", value: "/tickets" }, undefined, "TicketList"],
      ["object", { kind: "static", value: "/settings" }, undefined, undefined],
      ["object", { kind: "static", value: "/settings/users" }, "/settings", "Users"],
      ["object", { kind: "dynamic", expression: "computedPath" }, "/settings", undefined],
    ],
  );
});

test("extracts static and dynamic links while preserving generic hierarchy", async () => {
  const repository = await createRepository("navigation links ");
  await createFile(
    repository,
    "src/Sidebar.tsx",
    [
      "export function SidebarLinks() {",
      "  return (",
      "    <Sidebar>",
      '      <NavSection title="Service Desk">',
      '        <Link to="/tickets">Tickets</Link>',
      '        <Link href="/settings/users">Users</Link>',
      '        <a href="/help">Help</a>',
      '        <Link to="/tickets">Tickets Again</Link>',
      "        <Link to={`/tickets/${ticket.id}`}>{ticket.subject}</Link>",
      '        <Link to="">Root-relative</Link>',
      "      </NavSection>",
      "    </Sidebar>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );

  const manifest = await analyzeRepository(repository);
  const [tickets, users, help, duplicate, dynamic, empty] = manifest.navigation;

  assert.deepEqual(tickets?.destination, { kind: "static", value: "/tickets" });
  assert.deepEqual(tickets?.label, { kind: "static", value: "Tickets" });
  assert.equal(tickets?.element, "Link");
  assert.deepEqual(tickets?.ancestors.map(({ element, title }) => ({ element, title })), [
    { element: "Sidebar", title: undefined },
    { element: "NavSection", title: "Service Desk" },
  ]);
  assert.deepEqual(users?.destination, {
    kind: "static",
    value: "/settings/users",
  });
  assert.equal(help?.element, "a");
  assert.deepEqual(help?.destination, { kind: "static", value: "/help" });
  assert.deepEqual(duplicate?.destination, { kind: "static", value: "/tickets" });
  assert.deepEqual(dynamic?.destination, {
    kind: "dynamic",
    expression: "`/tickets/${ticket.id}`",
  });
  assert.deepEqual(dynamic?.label, {
    kind: "dynamic",
    expression: "ticket.subject",
  });
  assert.deepEqual(empty?.destination, { kind: "static", value: "" });
  assert.deepEqual(tickets?.location, {
    path: "src/Sidebar.tsx",
    startLine: 5,
    endLine: 5,
  });
  assert.deepEqual(tickets?.destinationLocation, tickets?.location);
});

test("derives Next.js App Router paths only from page files", async () => {
  const repository = await createRepository("next app routes ");
  await createFile(
    repository,
    "app/page.tsx",
    "export default function Home() { return <main />; }\n",
  );
  await createFile(
    repository,
    "app/tickets/page.tsx",
    "export default function Tickets() { return <main />; }\n",
  );
  await createFile(
    repository,
    "app/tickets/[ticketId]/page.tsx",
    "export default function Ticket() { return <main />; }\n",
  );
  await createFile(
    repository,
    "src/app/settings/users/[userId]/page.jsx",
    "export default function User() { return <main />; }\n",
  );
  await createFile(repository, "app/layout.tsx", "export default function Layout() {}\n");
  await createFile(repository, "app/tickets/helper.ts", "export const helper = 1;\n");

  const manifest = await analyzeRepository(repository);
  const fileRoutes = manifest.routes.filter((route) => route.source === "file-system");

  assert.deepEqual(
    fileRoutes.map((route) => [route.path, route.location.path, route.component]),
    [
      [{ kind: "static", value: "/" }, "app/page.tsx", "Home"],
      [
        { kind: "static", value: "/tickets/[ticketId]" },
        "app/tickets/[ticketId]/page.tsx",
        "Ticket",
      ],
      [{ kind: "static", value: "/tickets" }, "app/tickets/page.tsx", "Tickets"],
      [
        { kind: "static", value: "/settings/users/[userId]" },
        "src/app/settings/users/[userId]/page.jsx",
        "User",
      ],
    ],
  );
});

test("keeps route and navigation discovery independent in TSX and JSX", async () => {
  const repository = await createRepository("independent navigation ");
  await createFile(
    repository,
    "src/Routes.tsx",
    "export const RoutesView = () => <Routes><Route path=\"/route-only\" /></Routes>;\n",
  );
  await createFile(
    repository,
    "src/Links.jsx",
    "export function Links() { return <Link href=\"/link-only\">Link only</Link>; }\n",
  );

  const manifest = await analyzeRepository(repository);

  assert.deepEqual(manifest.routes.map((route) => route.path), [
    { kind: "static", value: "/route-only" },
  ]);
  assert.deepEqual(manifest.navigation.map((entry) => entry.destination), [
    { kind: "static", value: "/link-only" },
  ]);
});

test("isolates malformed sources and produces deterministic serialized output", async () => {
  const repository = await createRepository("deterministic routes ");
  await createFile(
    repository,
    "src/Valid.tsx",
    "export const Valid = () => <><Route path=\"/valid\" /><Link to=\"/valid\">Valid</Link></>;\n",
  );
  await createFile(
    repository,
    "src/Broken.tsx",
    "export const Broken = () => <Route path=\"/broken\">;\n",
  );

  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  const ui = analyzeUiStructure(sources);
  const first = analyzeRoutesAndNavigation(inventory, sources, ui);
  const second = analyzeRoutesAndNavigation(inventory, sources, ui);

  assert.equal(
    sources.files.find((file) => file.path === "src/Broken.tsx")?.status,
    "parse-error",
  );
  assert.deepEqual(first, second);
  assert.deepEqual(first.routes.map((route) => route.path), [
    { kind: "static", value: "/valid" },
  ]);
  assert.doesNotThrow(() => JSON.stringify(first));
});

async function analyzeRepository(repository: string): Promise<RouteNavigationManifest> {
  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  const ui = analyzeUiStructure(sources);
  return analyzeRoutesAndNavigation(inventory, sources, ui);
}

async function createRepository(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFile(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}
