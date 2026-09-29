import path from "node:path";
import ts from "typescript";
import type {
  SourceAnalysisManifest,
  SourceLocation,
  SuccessfulSourceAnalysis,
} from "./source-analyzer.js";
import { parseTypeScriptSource } from "./typescript-parser.js";

export type ComponentExportStatus = "default" | "named" | "both" | "none";
export type StaticPropValueType = "string" | "boolean" | "number" | "null";

export interface StaticUiProp {
  name: string;
  valueType: StaticPropValueType;
  value: string | boolean | number | null;
  location: SourceLocation;
}

export interface DynamicUiProp {
  name: string;
  valueType: "dynamic";
  expression: string;
  location: SourceLocation;
}

export type UiProp = StaticUiProp | DynamicUiProp;

export interface UiElementNode {
  kind: "element";
  name: string;
  props: UiProp[];
  children: UiNode[];
  location: SourceLocation;
}

export interface UiFragmentNode {
  kind: "fragment";
  children: UiNode[];
  location: SourceLocation;
}

export interface UiTextNode {
  kind: "text";
  value: string;
  location: SourceLocation;
}

export interface UiDynamicNode {
  kind: "dynamic";
  expression: string;
  location: SourceLocation;
}

export type UiNode =
  | UiElementNode
  | UiFragmentNode
  | UiTextNode
  | UiDynamicNode;

export interface UiComponent {
  name: string;
  exportStatus: ComponentExportStatus;
  location: SourceLocation;
  root: UiElementNode | UiFragmentNode;
}

export interface UiStructureManifest {
  root: string;
  components: UiComponent[];
}

interface ComponentCandidate {
  name: string;
  declaration: ts.Node;
  functionLike: ts.FunctionLikeDeclaration;
  forcedDefaultExport: boolean;
}

export function analyzeUiStructure(
  sources: SourceAnalysisManifest,
): UiStructureManifest {
  const components: UiComponent[] = [];
  const sourceFiles = sources.files.filter(isJsxSource);
  sourceFiles.sort((left, right) => compareText(left.path, right.path));

  for (const file of sourceFiles) {
    components.push(...analyzeUiSourceFile(file));
  }

  return { root: sources.root, components };
}

function analyzeUiSourceFile(file: SuccessfulSourceAnalysis): UiComponent[] {
  const sourceFile = parseTypeScriptSource(file.path, file.sourceText);
  const exportStatuses = collectExportStatuses(sourceFile);
  const components: UiComponent[] = [];

  for (const candidate of collectComponentCandidates(sourceFile)) {
    const returnedJsx = findReturnedJsx(candidate.functionLike);
    if (!returnedJsx) continue;

    components.push({
      name: candidate.name,
      exportStatus: candidate.forcedDefaultExport
        ? "default"
        : getExportStatus(exportStatuses.get(candidate.name)),
      location: getLocation(candidate.declaration, sourceFile, file.path),
      root: readJsxRoot(returnedJsx, sourceFile, file.path),
    });
  }

  return components;
}

function collectComponentCandidates(
  sourceFile: ts.SourceFile,
): ComponentCandidate[] {
  const candidates: ComponentCandidate[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      candidates.push({
        name: statement.name?.text ?? "<anonymous-default>",
        declaration: statement,
        functionLike: statement,
        forcedDefaultExport:
          !statement.name && hasModifier(statement, ts.SyntaxKind.DefaultKeyword),
      });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          isSupportedFunction(declaration.initializer)
        ) {
          candidates.push({
            name: declaration.name.text,
            declaration,
            functionLike: declaration.initializer,
            forcedDefaultExport: false,
          });
        }
      }
      continue;
    }

    if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      isSupportedFunction(statement.expression)
    ) {
      candidates.push({
        name: statement.expression.name?.text ?? "<anonymous-default>",
        declaration: statement,
        functionLike: statement.expression,
        forcedDefaultExport: true,
      });
    }
  }

  return candidates;
}

function findReturnedJsx(
  functionLike: ts.FunctionLikeDeclaration,
): ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | undefined {
  const body = functionLike.body;
  if (!body) return undefined;

  if (!ts.isBlock(body)) {
    return getJsxRoot(body);
  }

  let result: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | undefined;
  const visit = (node: ts.Node): void => {
    if (result) return;
    if (node !== body && ts.isFunctionLike(node)) return;

    if (ts.isReturnStatement(node) && node.expression) {
      result = getJsxRoot(node.expression);
      if (result) return;
    }

    ts.forEachChild(node, visit);
  };

  visit(body);
  return result;
}

function getJsxRoot(
  expression: ts.Expression,
): ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | undefined {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return isJsxRoot(current) ? current : undefined;
}

function readJsxRoot(
  node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
  sourceFile: ts.SourceFile,
  filePath: string,
): UiElementNode | UiFragmentNode {
  if (ts.isJsxElement(node)) {
    return {
      kind: "element",
      name: node.openingElement.tagName.getText(sourceFile),
      props: readProps(node.openingElement.attributes, sourceFile, filePath),
      children: readChildren(node.children, sourceFile, filePath),
      location: getLocation(node, sourceFile, filePath),
    };
  }

  if (ts.isJsxSelfClosingElement(node)) {
    return {
      kind: "element",
      name: node.tagName.getText(sourceFile),
      props: readProps(node.attributes, sourceFile, filePath),
      children: [],
      location: getLocation(node, sourceFile, filePath),
    };
  }

  return {
    kind: "fragment",
    children: readChildren(node.children, sourceFile, filePath),
    location: getLocation(node, sourceFile, filePath),
  };
}

function readChildren(
  children: ts.NodeArray<ts.JsxChild>,
  sourceFile: ts.SourceFile,
  filePath: string,
): UiNode[] {
  const result: UiNode[] = [];

  for (const child of children) {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      result.push(readJsxRoot(child, sourceFile, filePath));
      continue;
    }

    if (ts.isJsxFragment(child)) {
      result.push(readJsxRoot(child, sourceFile, filePath));
      continue;
    }

    if (ts.isJsxText(child)) {
      const value = normalizeText(child.text);
      if (value) {
        result.push({
          kind: "text",
          value,
          location: getLocation(child, sourceFile, filePath),
        });
      }
      continue;
    }

    if (ts.isJsxExpression(child) && child.expression) {
      const expression = unwrapParentheses(child.expression);
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        const value = normalizeText(expression.text);
        if (value) {
          result.push({
            kind: "text",
            value,
            location: getLocation(child, sourceFile, filePath),
          });
        }
      } else {
        result.push({
          kind: "dynamic",
          expression: expression.getText(sourceFile),
          location: getLocation(child, sourceFile, filePath),
        });
      }
    }
  }

  return result;
}

function readProps(
  attributes: ts.JsxAttributes,
  sourceFile: ts.SourceFile,
  filePath: string,
): UiProp[] {
  return attributes.properties.map((attribute) => {
    const location = getLocation(attribute, sourceFile, filePath);

    if (ts.isJsxSpreadAttribute(attribute)) {
      return {
        name: "...",
        valueType: "dynamic",
        expression: attribute.expression.getText(sourceFile),
        location,
      };
    }

    const name = attribute.name.getText(sourceFile);
    if (!attribute.initializer) {
      return { name, valueType: "boolean", value: true, location };
    }

    if (ts.isStringLiteral(attribute.initializer)) {
      return {
        name,
        valueType: "string",
        value: attribute.initializer.text,
        location,
      };
    }

    if (!ts.isJsxExpression(attribute.initializer)) {
      return {
        name,
        valueType: "dynamic",
        expression: attribute.initializer.getText(sourceFile),
        location,
      };
    }

    const expression = attribute.initializer.expression;
    if (!expression) {
      return { name, valueType: "dynamic", expression: "", location };
    }

    return readExpressionProp(
      name,
      unwrapParentheses(expression),
      location,
      sourceFile,
    );
  });
}

function readExpressionProp(
  name: string,
  expression: ts.Expression,
  location: SourceLocation,
  sourceFile: ts.SourceFile,
): UiProp {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { name, valueType: "string", value: expression.text, location };
  }

  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return { name, valueType: "boolean", value: true, location };
  }

  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return { name, valueType: "boolean", value: false, location };
  }

  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    return { name, valueType: "null", value: null, location };
  }

  const numericValue = readNumericLiteral(expression);
  if (numericValue !== undefined) {
    return { name, valueType: "number", value: numericValue, location };
  }

  return {
    name,
    valueType: "dynamic",
    expression: expression.getText(sourceFile),
    location,
  };
}

function readNumericLiteral(expression: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(expression)) return Number(expression.text);

  if (
    ts.isPrefixUnaryExpression(expression) &&
    ts.isNumericLiteral(expression.operand) &&
    (expression.operator === ts.SyntaxKind.MinusToken ||
      expression.operator === ts.SyntaxKind.PlusToken)
  ) {
    const value = Number(expression.operand.text);
    return expression.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }

  return undefined;
}

function collectExportStatuses(
  sourceFile: ts.SourceFile,
): Map<string, Set<"default" | "named">> {
  const statuses = new Map<string, Set<"default" | "named">>();

  const add = (name: string, status: "default" | "named"): void => {
    const existing = statuses.get(name) ?? new Set();
    existing.add(status);
    statuses.set(name, existing);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        add(statement.name.text, "default");
      } else if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        add(statement.name.text, "named");
      }
    } else if (
      ts.isVariableStatement(statement) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) add(declaration.name.text, "named");
      }
    } else if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          add(
            element.propertyName?.text ?? element.name.text,
            element.name.text === "default" ? "default" : "named",
          );
        }
      }
    } else if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      ts.isIdentifier(statement.expression)
    ) {
      add(statement.expression.text, "default");
    }
  }

  return statuses;
}

function getExportStatus(
  statuses: Set<"default" | "named"> | undefined,
): ComponentExportStatus {
  if (statuses?.has("default") && statuses.has("named")) return "both";
  if (statuses?.has("default")) return "default";
  if (statuses?.has("named")) return "named";
  return "none";
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

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isJsxRoot(
  node: ts.Node,
): node is ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment {
  return ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node);
}

function isSupportedFunction(
  node: ts.Expression | undefined,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return node !== undefined &&
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function isJsxSource(file: SourceAnalysisManifest["files"][number]):
  file is SuccessfulSourceAnalysis {
  return file.status === "ok" &&
    (path.extname(file.path).toLowerCase() === ".tsx" ||
      path.extname(file.path).toLowerCase() === ".jsx") &&
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
