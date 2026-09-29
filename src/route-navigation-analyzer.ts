import path from "node:path";
import ts from "typescript";
import type { RepositoryInventory } from "./repository-scanner.js";
import type {
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

export interface StaticRouteValue {
  kind: "static";
  value: string;
}

export interface DynamicRouteValue {
  kind: "dynamic";
  expression: string;
}

export type RouteValue = StaticRouteValue | DynamicRouteValue;
export type RouteSource = "declarative" | "object" | "file-system";

export interface RouteRecord {
  source: RouteSource;
  path: RouteValue;
  declaredPath: RouteValue;
  parent?: string;
  component?: string;
  componentLocation?: SourceLocation;
  location: SourceLocation;
}

export interface NavigationAncestor {
  element: string;
  title?: string;
  location: SourceLocation;
}

export interface NavigationRecord {
  component: string;
  element: string;
  label: RouteValue;
  destination: RouteValue;
  ancestors: NavigationAncestor[];
  destinationLocation: SourceLocation;
  location: SourceLocation;
}

export interface RouteNavigationManifest {
  root: string;
  routes: RouteRecord[];
  navigation: NavigationRecord[];
}

export function analyzeRoutesAndNavigation(
  inventory: RepositoryInventory,
  sources: SourceAnalysisManifest,
  ui: UiStructureManifest,
): RouteNavigationManifest {
  if (inventory.root !== sources.root || sources.root !== ui.root) {
    throw new Error("Inventory, source, and UI manifests must have the same repository root");
  }

  const routes: RouteRecord[] = [];
  const sourceFiles = sources.files.filter(isSuccessfulCodeFile);
  sourceFiles.sort((left, right) => compareText(left.path, right.path));

  for (const file of sourceFiles) {
    const sourceFile = parseTypeScriptSource(file.path, file.sourceText);
    routes.push(...readDeclarativeRoutes(sourceFile, file.path));
    routes.push(...readObjectRoutes(sourceFile, file.path));
  }

  routes.push(...readFileSystemRoutes(inventory, ui, sources));

  return {
    root: inventory.root,
    routes,
    navigation: readNavigation(ui),
  };
}

function readDeclarativeRoutes(
  sourceFile: ts.SourceFile,
  filePath: string,
): RouteRecord[] {
  const routes: RouteRecord[] = [];

  const visit = (node: ts.Node): void => {
    if (isRouteElement(node) && !hasRouteAncestor(node)) {
      readRouteTree(node, undefined, sourceFile, filePath, routes);
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return routes;
}

function readRouteTree(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  parentPath: string | null | undefined,
  sourceFile: ts.SourceFile,
  filePath: string,
  routes: RouteRecord[],
): void {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const declaredPath = readJsxValue(
    opening.attributes.properties,
    "path",
    sourceFile,
  );
  let currentParent = parentPath;

  if (declaredPath) {
    const resolvedPath = resolveRoutePath(declaredPath, parentPath);
    const component = readRouteComponent(
      opening.attributes.properties,
      sourceFile,
      filePath,
    );
    routes.push({
      source: "declarative",
      path: resolvedPath,
      declaredPath,
      ...(typeof parentPath === "string" ? { parent: parentPath } : {}),
      ...(component
        ? {
            component: component.name,
            componentLocation: component.location,
          }
        : {}),
      location: getLocation(node, sourceFile, filePath),
    });
    currentParent = resolvedPath.kind === "static" ? resolvedPath.value : null;
  }

  if (ts.isJsxElement(node)) {
    for (const child of node.children) {
      readNestedRouteChildren(child, currentParent, sourceFile, filePath, routes);
    }
  }
}

function readNestedRouteChildren(
  node: ts.JsxChild,
  parentPath: string | null | undefined,
  sourceFile: ts.SourceFile,
  filePath: string,
  routes: RouteRecord[],
): void {
  if (isRouteElement(node)) {
    readRouteTree(node, parentPath, sourceFile, filePath, routes);
    return;
  }

  if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
    for (const child of node.children) {
      readNestedRouteChildren(child, parentPath, sourceFile, filePath, routes);
    }
  }
}

function readObjectRoutes(
  sourceFile: ts.SourceFile,
  filePath: string,
): RouteRecord[] {
  const routes: RouteRecord[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /routes?/i.test(node.name.text) &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      readRouteObjectArray(node.initializer, undefined, sourceFile, filePath, routes);
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return routes;
}

function readRouteObjectArray(
  array: ts.ArrayLiteralExpression,
  parentPath: string | null | undefined,
  sourceFile: ts.SourceFile,
  filePath: string,
  routes: RouteRecord[],
): void {
  for (const element of array.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    const pathProperty = getObjectProperty(element, "path");
    const declaredPath = pathProperty
      ? readExpressionValue(pathProperty.initializer, sourceFile)
      : undefined;
    let currentParent = parentPath;

    if (declaredPath) {
      const resolvedPath = resolveRoutePath(declaredPath, parentPath);
      const component = readObjectRouteComponent(element, sourceFile, filePath);
      routes.push({
        source: "object",
        path: resolvedPath,
        declaredPath,
        ...(typeof parentPath === "string" ? { parent: parentPath } : {}),
        ...(component
          ? {
              component: component.name,
              componentLocation: component.location,
            }
          : {}),
        location: getLocation(element, sourceFile, filePath),
      });
      currentParent = resolvedPath.kind === "static" ? resolvedPath.value : null;
    }

    const children = getObjectProperty(element, "children")?.initializer;
    if (children && ts.isArrayLiteralExpression(children)) {
      readRouteObjectArray(children, currentParent, sourceFile, filePath, routes);
    }
  }
}

function readFileSystemRoutes(
  inventory: RepositoryInventory,
  ui: UiStructureManifest,
  sources: SourceAnalysisManifest,
): RouteRecord[] {
  const files = inventory.files
    .filter((file) => isNextAppPage(file.path))
    .sort((left, right) => compareText(left.path, right.path));

  return files.map((file) => {
    const routePath = getNextAppRoutePath(file.path);
    const component = ui.components.find(
      (candidate) => candidate.location.path === file.path,
    );
    const source = sources.files.find(
      (candidate) => candidate.path === file.path && candidate.status === "ok",
    );
    const endLine = source?.status === "ok"
      ? Math.max(1, source.sourceText.split(/\r?\n/).length)
      : 1;
    const location = { path: file.path, startLine: 1, endLine };

    return {
      source: "file-system",
      path: { kind: "static", value: routePath },
      declaredPath: { kind: "static", value: routePath },
      ...(component
        ? {
            component: component.name,
            componentLocation: component.location,
          }
        : {}),
      location,
    };
  });
}

function readNavigation(ui: UiStructureManifest): NavigationRecord[] {
  const records: NavigationRecord[] = [];
  const components = [...ui.components].sort((left, right) => {
    const byPath = compareText(left.location.path, right.location.path);
    return byPath || left.location.startLine - right.location.startLine;
  });

  const visit = (
    component: UiComponent,
    node: UiNode,
    ancestors: NavigationAncestor[],
  ): void => {
    if (node.kind !== "element" && node.kind !== "fragment") return;

    if (node.kind === "element") {
      const destination = getNavigationDestination(node);
      if (destination) {
        records.push({
          component: component.name,
          element: node.name,
          label: getNavigationLabel(node),
          destination: destination.value,
          ancestors,
          destinationLocation: destination.location,
          location: node.location,
        });
      }
    }

    const nextAncestors = node.kind === "element" && !isNavigationElement(node.name)
      ? [...ancestors, getNavigationAncestor(node)]
      : ancestors;
    for (const child of node.children) visit(component, child, nextAncestors);
  };

  for (const component of components) visit(component, component.root, []);
  return records;
}

function getNavigationDestination(
  element: UiElementNode,
): { value: RouteValue; location: SourceLocation } | undefined {
  const propertyName = isLinkElement(element.name)
    ? ["to", "href"]
    : element.name === "a"
      ? ["href"]
      : [];

  for (const name of propertyName) {
    const property = element.props.find((candidate) => candidate.name === name);
    if (!property) continue;
    return {
      value: property.valueType === "string"
        ? { kind: "static", value: property.value as string }
        : {
            kind: "dynamic",
            expression: property.valueType === "dynamic"
              ? property.expression
              : String(property.value),
          },
      location: property.location,
    };
  }

  return undefined;
}

function getNavigationLabel(element: UiElementNode): RouteValue {
  const staticText: string[] = [];
  const dynamicExpressions: string[] = [];

  const visit = (node: UiNode): void => {
    if (node.kind === "text") staticText.push(node.value);
    else if (node.kind === "dynamic") dynamicExpressions.push(node.expression);
    else for (const child of node.children) visit(child);
  };

  for (const child of element.children) visit(child);
  if (dynamicExpressions.length > 0) {
    return { kind: "dynamic", expression: dynamicExpressions.join(", ") };
  }
  return { kind: "static", value: staticText.join(" ") };
}

function getNavigationAncestor(element: UiElementNode): NavigationAncestor {
  const title = element.props.find(
    (property) => property.name === "title" && property.valueType === "string",
  );
  return {
    element: element.name,
    ...(title?.valueType === "string" ? { title: title.value as string } : {}),
    location: element.location,
  };
}

function readJsxValue(
  properties: ts.NodeArray<ts.JsxAttributeLike>,
  name: string,
  sourceFile: ts.SourceFile,
): RouteValue | undefined {
  const property = properties.find(
    (candidate): candidate is ts.JsxAttribute =>
      ts.isJsxAttribute(candidate) && candidate.name.getText(sourceFile) === name,
  );
  if (!property?.initializer) return undefined;
  if (ts.isStringLiteral(property.initializer)) {
    return { kind: "static", value: property.initializer.text };
  }
  if (ts.isJsxExpression(property.initializer) && property.initializer.expression) {
    return readExpressionValue(property.initializer.expression, sourceFile);
  }
  return { kind: "dynamic", expression: property.initializer.getText(sourceFile) };
}

function readExpressionValue(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): RouteValue {
  const value = unwrapParentheses(expression);
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
    ? { kind: "static", value: value.text }
    : { kind: "dynamic", expression: value.getText(sourceFile) };
}

function readRouteComponent(
  properties: ts.NodeArray<ts.JsxAttributeLike>,
  sourceFile: ts.SourceFile,
  filePath: string,
): { name: string; location: SourceLocation } | undefined {
  const property = properties.find(
    (candidate): candidate is ts.JsxAttribute =>
      ts.isJsxAttribute(candidate) &&
      candidate.name.getText(sourceFile) === "element",
  );
  const expression = property?.initializer && ts.isJsxExpression(property.initializer)
    ? property.initializer.expression
    : undefined;
  if (!expression) return undefined;
  const value = unwrapParentheses(expression);
  if (ts.isJsxElement(value)) {
    return {
      name: value.openingElement.tagName.getText(sourceFile),
      location: getLocation(value, sourceFile, filePath),
    };
  }
  if (ts.isJsxSelfClosingElement(value)) {
    return {
      name: value.tagName.getText(sourceFile),
      location: getLocation(value, sourceFile, filePath),
    };
  }
  return undefined;
}

function readObjectRouteComponent(
  object: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
): { name: string; location: SourceLocation } | undefined {
  const expression = getObjectProperty(object, "element")?.initializer;
  if (!expression) return undefined;
  const value = unwrapParentheses(expression);
  if (ts.isJsxElement(value)) {
    return {
      name: value.openingElement.tagName.getText(sourceFile),
      location: getLocation(value, sourceFile, filePath),
    };
  }
  if (ts.isJsxSelfClosingElement(value)) {
    return {
      name: value.tagName.getText(sourceFile),
      location: getLocation(value, sourceFile, filePath),
    };
  }
  return undefined;
}

function getObjectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === name) ||
        (ts.isStringLiteral(property.name) && property.name.text === name)),
  );
}

function resolveRoutePath(
  declaredPath: RouteValue,
  parentPath: string | null | undefined,
): RouteValue {
  if (declaredPath.kind === "dynamic") return declaredPath;
  if (declaredPath.value.startsWith("/") || parentPath === undefined) {
    return { kind: "static", value: normalizeRoutePath(declaredPath.value) };
  }
  if (parentPath === null) {
    return { kind: "dynamic", expression: declaredPath.value };
  }
  return {
    kind: "static",
    value: normalizeRoutePath(`${parentPath}/${declaredPath.value}`),
  };
}

function normalizeRoutePath(value: string): string {
  const normalized = `/${value}`.replace(/\/{2,}/g, "/");
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

function isRouteElement(
  node: ts.Node,
): node is ts.JsxElement | ts.JsxSelfClosingElement {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
  const tagName = ts.isJsxElement(node)
    ? node.openingElement.tagName
    : node.tagName;
  return tagName.getText().split(".").at(-1) === "Route";
}

function hasRouteAncestor(node: ts.Node): boolean {
  let current = node.parent;
  while (current) {
    if (isRouteElement(current)) return true;
    current = current.parent;
  }
  return false;
}

function isLinkElement(name: string): boolean {
  return name.split(".").at(-1) === "Link";
}

function isNavigationElement(name: string): boolean {
  return isLinkElement(name) || name === "a";
}

function isNextAppPage(filePath: string): boolean {
  return /^(?:src\/)?app(?:\/.*)?\/page\.(?:ts|tsx|js|jsx)$/.test(filePath);
}

function getNextAppRoutePath(filePath: string): string {
  const parts = filePath.split("/");
  const appIndex = parts[0] === "src" ? 1 : 0;
  const routeSegments = parts
    .slice(appIndex + 1, -1)
    .filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith("@"));
  return routeSegments.length === 0 ? "/" : `/${routeSegments.join("/")}`;
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

function isSuccessfulCodeFile(
  file: SourceAnalysisManifest["files"][number],
): file is SuccessfulSourceAnalysis {
  const extension = path.extname(file.path).toLowerCase();
  return file.status === "ok" &&
    (extension === ".ts" ||
      extension === ".tsx" ||
      extension === ".js" ||
      extension === ".jsx");
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
