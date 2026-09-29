import path from "node:path";
import ts from "typescript";
import type {
  ImportAnalysis,
  SourceAnalysisManifest,
  SourceLocation,
  SuccessfulSourceAnalysis,
} from "./source-analyzer.js";
import { parseTypeScriptSource } from "./typescript-parser.js";
import type {
  UiComponent,
  UiElementNode,
  UiNode,
  UiStructureManifest,
} from "./ui-structure-analyzer.js";

export interface ActionElementContext {
  name: string;
  text?: string;
  ariaLabel?: string;
  testId?: string;
  location: SourceLocation;
}

export interface LocalHandlerBinding {
  bindingType: "local";
  handler: {
    name: string;
    async: boolean;
    location: SourceLocation;
  };
}

export interface ImportedHandlerBinding {
  bindingType: "imported";
  handler: {
    name: string;
    importedName: string;
    source: string;
    location: SourceLocation;
  };
}

export interface InlineHandlerBinding {
  bindingType: "inline";
  handler: {
    async: boolean;
    parameters: string[];
    references: string[];
    expression: string;
    location: SourceLocation;
  };
}

export interface MemberExpressionBinding {
  bindingType: "member-expression";
  expression: string;
}

export interface UnresolvedHandlerBinding {
  bindingType: "unresolved";
  expression: string;
}

export type HandlerBinding =
  | LocalHandlerBinding
  | ImportedHandlerBinding
  | InlineHandlerBinding
  | MemberExpressionBinding
  | UnresolvedHandlerBinding;

export type ActionBinding = HandlerBinding & {
  component: string;
  element: ActionElementContext;
  event: string;
  eventLocation: SourceLocation;
};

export interface ActionBindingManifest {
  root: string;
  actions: ActionBinding[];
}

interface ElementReference {
  component: UiComponent;
  element: UiElementNode;
}

interface LocalHandler {
  name: string;
  async: boolean;
  location: SourceLocation;
}

export function analyzeActionBindings(
  sources: SourceAnalysisManifest,
  ui: UiStructureManifest,
): ActionBindingManifest {
  if (sources.root !== ui.root) {
    throw new Error("Source and UI manifests must have the same repository root");
  }

  const actions: ActionBinding[] = [];
  const sourceFiles = sources.files.filter(isJsxSource);
  sourceFiles.sort((left, right) => compareText(left.path, right.path));

  for (const file of sourceFiles) {
    const components = ui.components.filter(
      (component) => component.location.path === file.path,
    );
    if (components.length === 0) continue;
    actions.push(...analyzeFileActions(file, components));
  }

  return { root: sources.root, actions };
}

function analyzeFileActions(
  file: SuccessfulSourceAnalysis,
  components: UiComponent[],
): ActionBinding[] {
  const sourceFile = parseTypeScriptSource(file.path, file.sourceText);
  const elements = indexUiElements(components);
  const fileHandlers = collectFileHandlers(sourceFile, file.path);
  const componentHandlers = new WeakMap<ts.FunctionLikeDeclaration, Map<string, LocalHandler>>();
  const actions: ActionBinding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const elementNode = ts.isJsxOpeningElement(node) && ts.isJsxElement(node.parent)
        ? node.parent
        : node;
      const location = getLocation(elementNode, sourceFile, file.path);
      const name = node.tagName.getText(sourceFile);
      const reference = takeElementReference(elements, name, location);

      if (reference) {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) continue;
          const event = attribute.name.getText(sourceFile);
          if (!isEventProp(event)) continue;

          const enclosingFunction = findEnclosingFunction(node);
          let handlers = fileHandlers;
          if (enclosingFunction) {
            let localHandlers = componentHandlers.get(enclosingFunction);
            if (!localHandlers) {
              localHandlers = collectComponentHandlers(
                enclosingFunction,
                sourceFile,
                file.path,
              );
              componentHandlers.set(enclosingFunction, localHandlers);
            }
            handlers = new Map([...fileHandlers, ...localHandlers]);
          }

          actions.push({
            component: reference.component.name,
            element: getElementContext(reference.element),
            event,
            eventLocation: getLocation(attribute, sourceFile, file.path),
            ...classifyBinding(
              attribute,
              handlers,
              file.imports,
              sourceFile,
              file.path,
            ),
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return actions;
}

function classifyBinding(
  attribute: ts.JsxAttribute,
  handlers: Map<string, LocalHandler>,
  imports: ImportAnalysis[],
  sourceFile: ts.SourceFile,
  filePath: string,
): HandlerBinding {
  const initializer = attribute.initializer;
  if (!initializer) return { bindingType: "unresolved", expression: "true" };
  if (!ts.isJsxExpression(initializer) || !initializer.expression) {
    return {
      bindingType: "unresolved",
      expression: initializer.getText(sourceFile),
    };
  }

  const expression = unwrapParentheses(initializer.expression);
  if (ts.isIdentifier(expression)) {
    const local = handlers.get(expression.text);
    if (local) {
      return {
        bindingType: "local",
        handler: local,
      };
    }

    const imported = findImportedHandler(expression.text, imports);
    if (imported) return imported;

    return { bindingType: "unresolved", expression: expression.text };
  }

  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return {
      bindingType: "inline",
      handler: {
        async: hasModifier(expression, ts.SyntaxKind.AsyncKeyword),
        parameters: expression.parameters.map((parameter) =>
          parameter.name.getText(sourceFile)),
        references: collectCalledIdentifiers(expression.body),
        expression: expression.getText(sourceFile),
        location: getLocation(expression, sourceFile, filePath),
      },
    };
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return getRootIdentifier(expression) === "props"
      ? { bindingType: "unresolved", expression: expression.getText(sourceFile) }
      : {
          bindingType: "member-expression",
          expression: expression.getText(sourceFile),
        };
  }

  return {
    bindingType: "unresolved",
    expression: expression.getText(sourceFile),
  };
}

function findImportedHandler(
  localName: string,
  imports: ImportAnalysis[],
): ImportedHandlerBinding | undefined {
  for (const entry of imports) {
    if (entry.default === localName) {
      return {
        bindingType: "imported",
        handler: {
          name: localName,
          importedName: "default",
          source: entry.source,
          location: entry.location,
        },
      };
    }

    const named = entry.named.find((candidate) => candidate.local === localName);
    if (named) {
      return {
        bindingType: "imported",
        handler: {
          name: localName,
          importedName: named.imported,
          source: entry.source,
          location: entry.location,
        },
      };
    }
  }

  return undefined;
}

function collectFileHandlers(
  sourceFile: ts.SourceFile,
  filePath: string,
): Map<string, LocalHandler> {
  const handlers = new Map<string, LocalHandler>();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      handlers.set(statement.name.text, readLocalHandler(statement.name.text, statement, sourceFile, filePath));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && isFunctionExpression(declaration.initializer)) {
          handlers.set(
            declaration.name.text,
            readLocalHandler(
              declaration.name.text,
              declaration,
              sourceFile,
              filePath,
              declaration.initializer,
            ),
          );
        }
      }
    }
  }

  return handlers;
}

function collectComponentHandlers(
  component: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string,
): Map<string, LocalHandler> {
  const handlers = new Map<string, LocalHandler>();
  if (!component.body || !ts.isBlock(component.body)) return handlers;

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      handlers.set(
        node.name.text,
        readLocalHandler(node.name.text, node, sourceFile, filePath),
      );
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFunctionExpression(node.initializer)) {
      handlers.set(
        node.name.text,
        readLocalHandler(
          node.name.text,
          node,
          sourceFile,
          filePath,
          node.initializer,
        ),
      );
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(component.body);
  return handlers;
}

function readLocalHandler(
  name: string,
  declaration: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
  functionExpression?: ts.ArrowFunction | ts.FunctionExpression,
): LocalHandler {
  return {
    name,
    async: hasModifier(
      functionExpression ?? declaration,
      ts.SyntaxKind.AsyncKeyword,
    ),
    location: getLocation(declaration, sourceFile, filePath),
  };
}

function collectCalledIdentifiers(body: ts.ConciseBody): string[] {
  const references: string[] = [];
  const seen = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (!seen.has(name)) {
        seen.add(name);
        references.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(body);
  return references;
}

function indexUiElements(
  components: UiComponent[],
): Map<string, ElementReference[]> {
  const result = new Map<string, ElementReference[]>();

  const visit = (component: UiComponent, node: UiNode): void => {
    if (node.kind === "element") {
      const key = getElementKey(node.name, node.location);
      const references = result.get(key) ?? [];
      references.push({ component, element: node });
      result.set(key, references);
    }

    if (node.kind === "element" || node.kind === "fragment") {
      for (const child of node.children) visit(component, child);
    }
  };

  for (const component of components) visit(component, component.root);
  return result;
}

function takeElementReference(
  elements: Map<string, ElementReference[]>,
  name: string,
  location: SourceLocation,
): ElementReference | undefined {
  return elements.get(getElementKey(name, location))?.shift();
}

function getElementKey(name: string, location: SourceLocation): string {
  return `${name}\u0000${location.path}\u0000${location.startLine}\u0000${location.endLine}`;
}

function getElementContext(element: UiElementNode): ActionElementContext {
  const text = collectStaticText(element).join(" ");
  const ariaLabel = getStaticStringProp(element, "aria-label");
  const testId = getStaticStringProp(element, "data-testid");

  return {
    name: element.name,
    ...(text ? { text } : {}),
    ...(ariaLabel ? { ariaLabel } : {}),
    ...(testId ? { testId } : {}),
    location: element.location,
  };
}

function collectStaticText(node: UiNode): string[] {
  if (node.kind === "text") return [node.value];
  if (node.kind === "dynamic") return [];
  return node.children.flatMap(collectStaticText);
}

function getStaticStringProp(
  element: UiElementNode,
  name: string,
): string | undefined {
  for (const property of element.props) {
    if (property.name === name && property.valueType === "string") {
      return property.value as string;
    }
  }
  return undefined;
}

function findEnclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function getRootIdentifier(expression: ts.PropertyAccessExpression): string | undefined {
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : undefined;
}

function getLocation(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): SourceLocation {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    path: filePath,
    startLine: start.line + 1,
    endLine: end.line + 1,
  };
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isFunctionExpression(
  node: ts.Expression | undefined,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return node !== undefined &&
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function isEventProp(name: string): boolean {
  return /^on[A-Z]/.test(name);
}

function isJsxSource(file: SourceAnalysisManifest["files"][number]):
  file is SuccessfulSourceAnalysis {
  const extension = path.extname(file.path).toLowerCase();
  return file.status === "ok" &&
    (extension === ".tsx" || extension === ".jsx") &&
    file.jsx.present;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
