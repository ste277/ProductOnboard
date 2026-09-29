import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  analyzeActionBindings,
  type ActionBinding,
} from "../src/action-binding-analyzer.js";
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

test("resolves local function and async arrow handlers with UI context", async () => {
  const repository = await createRepository("local actions ");
  await createFile(
    repository,
    "src/TicketActions.tsx",
    [
      "export function TicketActions() {",
      "  const saveTicket = async () => {};",
      "  function closeTicket() {}",
      "  return (",
      "    <>",
      '      <Button data-testid="save-ticket" aria-label="Save ticket" onClick={saveTicket}>Save</Button>',
      "      <Button onClick={closeTicket}>Close</Button>",
      "    </>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );

  const { actions } = await analyzeRepository(repository);
  const save = getBinding(actions[0], "local");
  const close = getBinding(actions[1], "local");

  assert.equal(save.component, "TicketActions");
  assert.deepEqual(save.element, {
    name: "Button",
    text: "Save",
    ariaLabel: "Save ticket",
    testId: "save-ticket",
    location: { path: "src/TicketActions.tsx", startLine: 6, endLine: 6 },
  });
  assert.equal(save.event, "onClick");
  assert.deepEqual(save.eventLocation, {
    path: "src/TicketActions.tsx",
    startLine: 6,
    endLine: 6,
  });
  assert.deepEqual(save.handler, {
    name: "saveTicket",
    async: true,
    location: { path: "src/TicketActions.tsx", startLine: 2, endLine: 2 },
  });
  assert.equal(close.handler.name, "closeTicket");
  assert.equal(close.handler.async, false);
  assert.deepEqual(close.handler.location, {
    path: "src/TicketActions.tsx",
    startLine: 3,
    endLine: 3,
  });
});

test("resolves imported handlers and aliases without opening imported files", async () => {
  const repository = await createRepository("imported actions ");
  await createFile(
    repository,
    "src/Imported.tsx",
    [
      'import defaultAction from "./default-action.js";',
      'import { cancelTicket, createTicket as create } from "./ticket-actions.js";',
      "export const Imported = () => (",
      "  <>",
      "    <Button onClick={cancelTicket}>Cancel</Button>",
      "    <Button onClick={create}>Create</Button>",
      "    <Button onClick={defaultAction}>Default</Button>",
      "  </>",
      ");",
      "",
    ].join("\n"),
  );

  const { actions } = await analyzeRepository(repository);
  const cancel = getBinding(actions[0], "imported");
  const create = getBinding(actions[1], "imported");
  const defaultAction = getBinding(actions[2], "imported");

  assert.deepEqual(cancel.handler, {
    name: "cancelTicket",
    importedName: "cancelTicket",
    source: "./ticket-actions.js",
    location: { path: "src/Imported.tsx", startLine: 2, endLine: 2 },
  });
  assert.equal(create.handler.name, "create");
  assert.equal(create.handler.importedName, "createTicket");
  assert.equal(create.handler.source, "./ticket-actions.js");
  assert.deepEqual(defaultAction.handler, {
    name: "defaultAction",
    importedName: "default",
    source: "./default-action.js",
    location: { path: "src/Imported.tsx", startLine: 1, endLine: 1 },
  });
});

test("captures inline handlers and directly called identifiers without behavior analysis", async () => {
  const repository = await createRepository("inline actions ");
  await createFile(
    repository,
    "src/Form.tsx",
    [
      "export function Form() {",
      "  const saveTicket = () => {};",
      "  function closeTicket() {}",
      "  return (",
      "    <form onSubmit={(event) => closeTicket(event)}>",
      "      <Button onClick={() => saveTicket()}>Save Again</Button>",
      "    </form>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );

  const { actions } = await analyzeRepository(repository);
  const submit = getBinding(actions[0], "inline");
  const click = getBinding(actions[1], "inline");

  assert.equal(submit.event, "onSubmit");
  assert.deepEqual(submit.handler.parameters, ["event"]);
  assert.deepEqual(submit.handler.references, ["closeTicket"]);
  assert.equal(submit.handler.async, false);
  assert.equal(click.event, "onClick");
  assert.deepEqual(click.handler.parameters, []);
  assert.deepEqual(click.handler.references, ["saveTicket"]);
  assert.equal(click.element.text, "Save Again");
});

test("distinguishes member expressions, props members, and unresolved identifiers", async () => {
  const repository = await createRepository("unresolved actions ");
  await createFile(
    repository,
    "src/Bindings.tsx",
    [
      "export const Bindings = (props) => (",
      "  <section>",
      "    <Button onClick={ticketActions.create}>Create</Button>",
      "    <Button onClick={props.onCreate}>Prop</Button>",
      "    <Button onClick={missingHandler}>Missing</Button>",
      "  </section>",
      ");",
      "",
    ].join("\n"),
  );

  const { actions } = await analyzeRepository(repository);
  const member = getBinding(actions[0], "member-expression");
  const propsMember = getBinding(actions[1], "unresolved");
  const unresolved = getBinding(actions[2], "unresolved");

  assert.equal(member.expression, "ticketActions.create");
  assert.equal(propsMember.expression, "props.onCreate");
  assert.equal(unresolved.expression, "missingHandler");
});

test("supports multiple event types, repeated handlers, and multiple events per element", async () => {
  const repository = await createRepository("event coverage ");
  await createFile(
    repository,
    "src/Inputs.tsx",
    [
      "export function Inputs() {",
      "  const handle = () => {};",
      "  return (",
      "    <>",
      "      <input onChange={handle} onBlur={handle} onFocus={handle} />",
      "      <button onClick={handle} onKeyDown={handle} onKeyUp={handle}>Run</button>",
      "      <select onSelect={handle} onMouseEnter={handle} onMouseLeave={handle} />",
      "    </>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );

  const { actions } = await analyzeRepository(repository);

  assert.deepEqual(actions.map((action) => action.event), [
    "onChange",
    "onBlur",
    "onFocus",
    "onClick",
    "onKeyDown",
    "onKeyUp",
    "onSelect",
    "onMouseEnter",
    "onMouseLeave",
  ]);
  assert.ok(actions.every((action) => action.bindingType === "local"));
  assert.ok(
    actions.every(
      (action) => action.bindingType !== "local" || action.handler.name === "handle",
    ),
  );
});

test("supports JSX files and isolates malformed source files", async () => {
  const repository = await createRepository("jsx and malformed ");
  await createFile(
    repository,
    "src/Legacy.jsx",
    "export function Legacy() { function change() {} return <input onChange={change} />; }\n",
  );
  await createFile(
    repository,
    "src/Broken.tsx",
    "export const Broken = () => <Button onClick={broken}>;\n",
  );

  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  const ui = analyzeUiStructure(sources);
  const first = analyzeActionBindings(sources, ui);
  const second = analyzeActionBindings(sources, ui);

  assert.equal(
    sources.files.find((file) => file.path === "src/Broken.tsx")?.status,
    "parse-error",
  );
  assert.equal(first.actions.length, 1);
  assert.equal(first.actions[0]?.component, "Legacy");
  assert.equal(first.actions[0]?.event, "onChange");
  assert.deepEqual(first, second);
  assert.doesNotThrow(() => JSON.stringify(first));
});

function getBinding<T extends ActionBinding["bindingType"]>(
  action: ActionBinding | undefined,
  bindingType: T,
): Extract<ActionBinding, { bindingType: T }> {
  assert.ok(action);
  assert.equal(action.bindingType, bindingType);
  return action as Extract<ActionBinding, { bindingType: T }>;
}

async function analyzeRepository(repository: string) {
  const inventory = await scanRepository(repository);
  const sources = await analyzeSources(inventory);
  const ui = analyzeUiStructure(sources);
  return analyzeActionBindings(sources, ui);
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
