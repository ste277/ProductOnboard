import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type {
  RepositoryFile,
  RepositoryInventory,
  SourceExtension,
} from "./repository-scanner.js";
import { parseTypeScriptSource } from "./typescript-parser.js";

const ANALYZABLE_EXTENSIONS = new Set<SourceExtension>([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
]);

export interface SourceLocation {
  path: string;
  startLine: number;
  endLine: number;
}

export interface NamedImport {
  imported: string;
  local: string;
}

export interface ImportAnalysis {
  source: string;
  default?: string;
  named: NamedImport[];
  namespace?: string;
  location: SourceLocation;
}

export interface ExportAnalysis {
  kind: "default" | "named";
  name?: string;
  location: SourceLocation;
}

export interface FunctionAnalysis {
  name: string;
  async: boolean;
  location: SourceLocation;
}

export interface ClassAnalysis {
  name: string;
  location: SourceLocation;
}

export interface JsxElementAnalysis {
  name: string;
  location: SourceLocation;
}

export interface ParseError {
  code: number;
  message: string;
  line: number;
  column: number;
}

export interface SuccessfulSourceAnalysis {
  path: string;
  status: "ok";
  sourceText: string;
  imports: ImportAnalysis[];
  exports: ExportAnalysis[];
  functions: FunctionAnalysis[];
  classes: ClassAnalysis[];
  jsx: {
    present: boolean;
    elements: JsxElementAnalysis[];
  };
}

export interface FailedSourceAnalysis {
  path: string;
  status: "parse-error";
  errors: ParseError[];
}

export type SourceFileAnalysis =
  | SuccessfulSourceAnalysis
  | FailedSourceAnalysis;

export interface SourceAnalysisManifest {
  root: string;
  files: SourceFileAnalysis[];
}

export async function analyzeSources(
  inventory: RepositoryInventory,
): Promise<SourceAnalysisManifest> {
  const sourceFiles = inventory.files.filter(isAnalyzableFile);
  sourceFiles.sort((left, right) => compareText(left.path, right.path));
  const files: SourceFileAnalysis[] = [];

  for (const file of sourceFiles) {
    const sourceText = await readFile(path.join(inventory.root, file.path), "utf8");
    files.push(analyzeSourceFile(file.path, file.extension, sourceText));
  }

  return { root: inventory.root, files };
}

function analyzeSourceFile(
  filePath: string,
  extension: SourceExtension,
  sourceText: string,
): SourceFileAnalysis {
  const sourceFile = parseTypeScriptSource(filePath, sourceText);
  const errors = getParseErrors(sourceFile, sourceText, extension);

  if (errors.length > 0) {
    return { path: filePath, status: "parse-error", errors };
  }

  const imports: ImportAnalysis[] = [];
  const exports: ExportAnalysis[] = [];
  const functions: FunctionAnalysis[] = [];
  const classes: ClassAnalysis[] = [];
  const jsxElements: JsxElementAnalysis[] = [];
  let jsxPresent = false;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      imports.push(readImport(node, sourceFile, filePath));
    }

    readExports(node, sourceFile, filePath, exports);

    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.push({
        name: node.name.text,
        async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
        location: getLocation(node, sourceFile, filePath),
      });
    } else if (ts.isVariableDeclaration(node) && isFunctionLike(node.initializer)) {
      const name = getBindingName(node.name, sourceFile);
      if (name) {
        functions.push({
          name,
          async: hasModifier(node.initializer, ts.SyntaxKind.AsyncKeyword),
          location: getLocation(node, sourceFile, filePath),
        });
      }
    }

    if (ts.isClassDeclaration(node) && node.name) {
      classes.push({
        name: node.name.text,
        location: getLocation(node, sourceFile, filePath),
      });
    }

    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      jsxPresent = true;
    } else if (ts.isJsxFragment(node)) {
      jsxPresent = true;
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      jsxElements.push({
        name: node.tagName.getText(sourceFile),
        location: getLocation(node, sourceFile, filePath),
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    path: filePath,
    status: "ok",
    sourceText,
    imports,
    exports,
    functions,
    classes,
    jsx: { present: jsxPresent, elements: jsxElements },
  };
}

function readImport(
  node: ts.ImportDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string,
): ImportAnalysis {
  const importClause = node.importClause;
  const analysis: ImportAnalysis = {
    source: ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier.text
      : node.moduleSpecifier.getText(sourceFile),
    named: [],
    location: getLocation(node, sourceFile, filePath),
  };

  if (importClause?.name) {
    analysis.default = importClause.name.text;
  }

  if (importClause?.namedBindings) {
    if (ts.isNamespaceImport(importClause.namedBindings)) {
      analysis.namespace = importClause.namedBindings.name.text;
    } else {
      analysis.named = importClause.namedBindings.elements.map((element) => ({
        imported: element.propertyName?.text ?? element.name.text,
        local: element.name.text,
      }));
    }
  }

  return analysis;
}

function readExports(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
  exports: ExportAnalysis[],
): void {
  if (ts.isExportAssignment(node)) {
    exports.push({
      kind: node.isExportEquals ? "named" : "default",
      ...(node.isExportEquals ? { name: "export=" } : {}),
      location: getLocation(node, sourceFile, filePath),
    });
    return;
  }

  if (ts.isExportDeclaration(node) && node.exportClause) {
    if (ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        exports.push({
          kind: element.name.text === "default" ? "default" : "named",
          ...(element.name.text === "default" ? {} : { name: element.name.text }),
          location: getLocation(element, sourceFile, filePath),
        });
      }
    } else {
      exports.push({
        kind: "named",
        name: node.exportClause.name.text,
        location: getLocation(node.exportClause, sourceFile, filePath),
      });
    }
    return;
  }

  if (!isExportedDeclaration(node)) {
    return;
  }

  const location = getLocation(node, sourceFile, filePath);
  if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
    exports.push({ kind: "default", location });
    return;
  }

  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      const name = getBindingName(declaration.name, sourceFile);
      if (name) exports.push({ kind: "named", name, location });
    }
  } else if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
    node.name
  ) {
    exports.push({ kind: "named", name: node.name.text, location });
  }
}

function getParseErrors(
  sourceFile: ts.SourceFile,
  sourceText: string,
  extension: SourceExtension,
): ParseError[] {
  const diagnostics = ts.transpileModule(sourceText, {
    fileName: sourceFile.fileName,
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: extension === ".js" || extension === ".jsx",
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.Latest,
    },
  }).diagnostics;

  return (diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => {
      const position = sourceFile.getLineAndCharacterOfPosition(
        diagnostic.start ?? 0,
      );
      return {
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        line: position.line + 1,
        column: position.character + 1,
      };
    });
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

function getBindingName(name: ts.BindingName, sourceFile: ts.SourceFile): string {
  return ts.isIdentifier(name) ? name.text : name.getText(sourceFile);
}

function isFunctionLike(
  node: ts.Expression | undefined,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return node !== undefined &&
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function isExportedDeclaration(node: ts.Node): node is ts.DeclarationStatement {
  return (
    (ts.isVariableStatement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node)) &&
    hasModifier(node, ts.SyntaxKind.ExportKeyword)
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function isAnalyzableFile(
  file: RepositoryFile,
): file is RepositoryFile & { extension: ".ts" | ".tsx" | ".js" | ".jsx" } {
  return ANALYZABLE_EXTENSIONS.has(file.extension);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
