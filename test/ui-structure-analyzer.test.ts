import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { scanRepository } from "../src/repository-scanner.js";
import { analyzeSources } from "../src/source-analyzer.js";
import {
  analyzeUiStructure,
  type UiElementNode,
  type UiFragmentNode,
} from "../src/ui-structure-analyzer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("identifies only functions that structurally return JSX", async () => {
  const repository = await createRepository("component detection ");
  await createFile(
    repository,
    "src/components.tsx",
    [
      "function TicketForm() {",
      "  return <form />;",
      "}",
      "function CapitalizedUtility() {",
      "  return 42;",
      "}",
      "function OuterUtility() {",
      "  function NestedComponent() { return <aside />; }",
      "  return NestedComponent;",
      "}",
      "export { TicketForm };",
      "",
    ].join("\n"),
  );

  const ui = await analyzeRepository(repository);

  assert.equal(ui.components.length, 1);
  assert.equal(ui.components[0]?.name, "TicketForm");
  assert.equal(ui.components[0]?.exportStatus, "named");
  assert.deepEqual(ui.components[0]?.location, {
    path: "src/components.tsx",
    startLine: 1,
    endLine: 3,
  });
  assert.equal((ui.components[0]?.root as UiElementNode).name, "form");
});

test("supports arrow, named default, and anonymous default components", async () => {
  const repository = await createRepository("component forms ");
  await createFile(
    repository,
    "src/Arrow.tsx",
    [
      "export const ArrowPanel = () => <Panel />;",
      "export default ArrowPanel;",
      "",
    ].join("\n"),
  );
  await createFile(
    repository,
    "src/Default.jsx",
    "export default function DefaultView() { return <main />; }\n",
  );
  await createFile(
    repository,
    "src/Anonymous.tsx",
    "export default () => <section />;\n",
  );

  const ui = await analyzeRepository(repository);

  assert.deepEqual(
    ui.components.map(({ name, exportStatus, root }) => ({
      name,
      exportStatus,
      root: root.kind === "element" ? root.name : root.kind,
    })),
    [
      { name: "<anonymous-default>", exportStatus: "default", root: "section" },
      { name: "ArrowPanel", exportStatus: "both", root: "Panel" },
      { name: "DefaultView", exportStatus: "default", root: "main" },
    ],
  );
});

test("preserves nested JSX hierarchy, fragments, self-closing nodes, and text", async () => {
  const repository = await createRepository("jsx hierarchy ");
  await createFile(
    repository,
    "src/Layout.tsx",
    [
      "export function Layout() {",
      "  return (",
      "    <>",
      "      <Card>",
      "        <Header>",
      "          <Title>",
      "            Create   Ticket",
      "          </Title>",
      "        </Header>",
      "        <Icon />",
      "        <Button>{\"Create Ticket\"}</Button>",
      "        <p>{buttonLabel}</p>",
      "      </Card>",
      "    </>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );

  const ui = await analyzeRepository(repository);
  const fragment = ui.components[0]?.root as UiFragmentNode;
  const card = fragment.children[0] as UiElementNode;
  const header = card.children[0] as UiElementNode;
  const title = header.children[0] as UiElementNode;
  const icon = card.children[1] as UiElementNode;
  const button = card.children[2] as UiElementNode;
  const paragraph = card.children[3] as UiElementNode;

  assert.equal(fragment.kind, "fragment");
  assert.equal(card.name, "Card");
  assert.equal(header.name, "Header");
  assert.equal(title.name, "Title");
  assert.deepEqual(title.children.map((child) => child.kind === "text" && child.value), [
    "Create Ticket",
  ]);
  assert.equal(icon.name, "Icon");
  assert.deepEqual(icon.children, []);
  assert.deepEqual(button.children.map((child) => child.kind === "text" && child.value), [
    "Create Ticket",
  ]);
  assert.deepEqual(paragraph.children, [
    {
      kind: "dynamic",
      expression: "buttonLabel",
      location: {
        path: "src/Layout.tsx",
        startLine: 12,
        endLine: 12,
      },
    },
  ]);
});

test("classifies static and dynamic JSX props without evaluating expressions", async () => {
  const repository = await createRepository("jsx props ");
  await createFile(
    repository,
    "src/TicketForm.tsx",
    [
      "export function TicketForm() {",
      "  const saving = false;",
      "  return (",
      "    <Button",
      '      variant="primary"',
      "      disabled",
      "      visible={false}",
      "      count={3}",
      "      offset={-2}",
      "      optional={null}",
      "      loading={saving}",
      '      data-testid="create-ticket"',
      '      aria-label="Create Ticket"',
      "      onClick={createTicket}",
      "    >",
      "      Create",
      "    </Button>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );

  const ui = await analyzeRepository(repository);
  const button = ui.components[0]?.root as UiElementNode;

  assert.deepEqual(
    button.props.map((property) =>
      property.valueType === "dynamic"
        ? {
            name: property.name,
            valueType: property.valueType,
            expression: property.expression,
          }
        : {
            name: property.name,
            valueType: property.valueType,
            value: property.value,
          },
    ),
    [
      { name: "variant", valueType: "string", value: "primary" },
      { name: "disabled", valueType: "boolean", value: true },
      { name: "visible", valueType: "boolean", value: false },
      { name: "count", valueType: "number", value: 3 },
      { name: "offset", valueType: "number", value: -2 },
      { name: "optional", valueType: "null", value: null },
      { name: "loading", valueType: "dynamic", expression: "saving" },
      { name: "data-testid", valueType: "string", value: "create-ticket" },
      { name: "aria-label", valueType: "string", value: "Create Ticket" },
      { name: "onClick", valueType: "dynamic", expression: "createTicket" },
    ],
  );
  assert.ok(button.props.every((property) => property.location.path === "src/TicketForm.tsx"));
  assert.deepEqual(button.children.map((child) => child.kind === "text" && child.value), [
    "Create",
  ]);
});

test("extracts multiple components from TSX and JSX while ignoring non-JSX files", async () => {
  const repository = await createRepository("multiple components ");
  await createFile(
    repository,
    "src/Many.tsx",
    [
      "export function First() { return <div />; }",
      "export const Second = function () { return <Custom />; };",
      "",
    ].join("\n"),
  );
  await createFile(
    repository,
    "src/Legacy.jsx",
    "const Legacy = () => <article />;\nexport { Legacy };\n",
  );
  await createFile(
    repository,
    "src/not-ui.ts",
    "export function calculate() { return 1; }\n",
  );

  const ui = await analyzeRepository(repository);

  assert.deepEqual(ui.components.map((component) => component.name), [
    "Legacy",
    "First",
    "Second",
  ]);
});

test("produces deterministic, serializable UI output", async () => {
  const repository = await createRepository("deterministic ui ");
  await createFile(
    repository,
    "src/App.tsx",
    "export const App = () => <main><Header /><p>Hello</p></main>;\n",
  );

  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  const first = analyzeUiStructure(sources);
  const second = analyzeUiStructure(sources);

  assert.deepEqual(first, second);
  assert.doesNotThrow(() => JSON.stringify(first));
});

async function analyzeRepository(repository: string) {
  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  return analyzeUiStructure(sources);
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
