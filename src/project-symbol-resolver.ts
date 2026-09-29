import path from "node:path";
import ts from "typescript";
import type {
  CallableRecord,
  FunctionCall,
  FunctionCallManifest,
} from "./function-call-analyzer.js";
import type { RepositoryInventory } from "./repository-scanner.js";
import type {
  SourceAnalysisManifest,
  SourceLocation,
  SuccessfulSourceAnalysis,
} from "./source-analyzer.js";
import { parseTypeScriptSource } from "./typescript-parser.js";

const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;

export type SymbolResolutionStrength = "direct" | "re-exported";
export type SymbolResolutionKind = "import" | "namespace-member";
export type SymbolTargetKind = "callable" | "declaration";
export type SymbolResolutionFailureReason =
  | "module-not-found"
  | "ambiguous-module"
  | "export-not-found"
  | "ambiguous-export"
  | "circular-re-export"
  | "external-module"
  | "unsupported-module-alias"
  | "dynamic-import-out-of-scope";

export interface ModuleResolutionEvidence {
  kind: "import" | "module" | "export" | "re-export" | "declaration" | "call";
  path: string;
  moduleSpecifier?: string;
  name?: string;
  location?: SourceLocation;
}

export interface ResolvedSymbolTarget {
  kind: SymbolTargetKind;
  id: string;
  name: string;
  location: SourceLocation;
}

export interface SymbolResolution {
  kind: SymbolResolutionKind;
  importingFile: string;
  moduleSpecifier: string;
  resolvedModule: string;
  localName: string;
  importedName: string;
  target: ResolvedSymbolTarget;
  strength: SymbolResolutionStrength;
  evidence: ModuleResolutionEvidence[];
  usageLocation?: SourceLocation;
}

export interface UnresolvedSymbolResolution {
  kind: SymbolResolutionKind | "dynamic-import";
  importingFile: string;
  moduleSpecifier: string;
  localName?: string;
  importedName?: string;
  reason: SymbolResolutionFailureReason;
  candidates?: string[];
  evidence: ModuleResolutionEvidence[];
  usageLocation?: SourceLocation;
}

export interface ProjectModuleRecord {
  path: string;
}

export interface ProjectSymbolResolutionManifest {
  root: string;
  modules: ProjectModuleRecord[];
  resolutions: SymbolResolution[];
  unresolved: UnresolvedSymbolResolution[];
}

interface ImportRequest {
  kind: "import";
  importingFile: string;
  moduleSpecifier: string;
  localName: string;
  importedName: string;
  importLocation: SourceLocation;
}

interface NamespaceImport {
  importingFile: string;
  moduleSpecifier: string;
  localName: string;
  importLocation: SourceLocation;
}

interface ExportCandidate {
  exportedName: string;
  localName?: string;
  moduleSpecifier?: string;
  importedName?: string;
  exportAll: boolean;
  location: SourceLocation;
  declaration?: DeclarationCandidate;
}

interface DeclarationCandidate {
  name: string;
  location: SourceLocation;
}

interface FileSymbols {
  declarations: Map<string, DeclarationCandidate[]>;
  exports: ExportCandidate[];
}

interface ResolvedExport {
  target: ResolvedSymbolTarget;
  evidence: ModuleResolutionEvidence[];
  reExported: boolean;
}

interface FailedExport {
  reason: "export-not-found" | "ambiguous-export" | "circular-re-export" | "module-not-found" | "ambiguous-module";
  candidates?: string[];
  evidence: ModuleResolutionEvidence[];
}

type ExportResult = ResolvedExport | FailedExport;

export function resolveProjectSymbols(
  inventory: RepositoryInventory,
  sources: SourceAnalysisManifest,
  calls: FunctionCallManifest,
): ProjectSymbolResolutionManifest {
  if (inventory.root !== sources.root || sources.root !== calls.root) {
    throw new Error("Inventory, source, and call manifests must have the same repository root");
  }

  const sourceFiles = sources.files
    .filter(isSuccessfulCodeFile)
    .sort((left, right) => compareText(left.path, right.path));
  const projectFiles = new Set(
    inventory.files
      .filter((file) => isSupportedPath(file.path))
      .map((file) => normalizePath(file.path)),
  );
  const symbols = new Map<string, FileSymbols>();
  const imports: ImportRequest[] = [];
  const namespaces: NamespaceImport[] = [];
  const dynamicImports: UnresolvedSymbolResolution[] = [];

  for (const file of sourceFiles) {
    const parsed = parseTypeScriptSource(file.path, file.sourceText);
    symbols.set(file.path, readFileSymbols(file, parsed));
    readImports(file, parsed, imports, namespaces, dynamicImports);
  }

  const callables = new Map(calls.callers.map((callable) => [locationKey(callable.location), callable]));
  const resolutions: SymbolResolution[] = [];
  const unresolved: UnresolvedSymbolResolution[] = [...dynamicImports];
  const exportCache = new Map<string, ExportResult>();

  for (const request of imports) {
    resolveRequest(request, projectFiles, symbols, callables, exportCache, resolutions, unresolved);
  }

  for (const namespace of namespaces) {
    for (const callable of calls.callers.filter((candidate) => candidate.location.path === namespace.importingFile)) {
      for (const call of callable.calls) {
        const member = readNamespaceMember(call, namespace.localName);
        if (!member) continue;
        resolveRequest(
          {
            kind: "import",
            importingFile: namespace.importingFile,
            moduleSpecifier: namespace.moduleSpecifier,
            localName: namespace.localName,
            importedName: member,
            importLocation: namespace.importLocation,
          },
          projectFiles,
          symbols,
          callables,
          exportCache,
          resolutions,
          unresolved,
          call.location,
          "namespace-member",
        );
      }
    }
  }

  resolutions.sort(compareResolution);
  unresolved.sort(compareUnresolved);
  return {
    root: inventory.root,
    modules: [...projectFiles].sort(compareText).map((modulePath) => ({ path: modulePath })),
    resolutions,
    unresolved,
  };
}

function resolveRequest(
  request: ImportRequest,
  projectFiles: Set<string>,
  symbols: Map<string, FileSymbols>,
  callables: Map<string, CallableRecord>,
  cache: Map<string, ExportResult>,
  resolutions: SymbolResolution[],
  unresolved: UnresolvedSymbolResolution[],
  usageLocation?: SourceLocation,
  kind: SymbolResolutionKind = "import",
): void {
  const baseEvidence: ModuleResolutionEvidence[] = [{
    kind: "import",
    path: request.importingFile,
    moduleSpecifier: request.moduleSpecifier,
    name: request.localName,
    location: request.importLocation,
  }];
  if (usageLocation) {
    baseEvidence.push({ kind: "call", path: usageLocation.path, name: request.importedName, location: usageLocation });
  }

  const classification = classifyModuleSpecifier(request.moduleSpecifier);
  if (classification !== "relative") {
    unresolved.push({
      kind,
      importingFile: request.importingFile,
      moduleSpecifier: request.moduleSpecifier,
      localName: request.localName,
      importedName: request.importedName,
      reason: classification,
      evidence: baseEvidence,
      ...(usageLocation ? { usageLocation } : {}),
    });
    return;
  }

  const moduleResult = resolveModulePath(
    request.importingFile,
    request.moduleSpecifier,
    projectFiles,
  );
  if (moduleResult.kind === "failed") {
    unresolved.push({
      kind,
      importingFile: request.importingFile,
      moduleSpecifier: request.moduleSpecifier,
      localName: request.localName,
      importedName: request.importedName,
      reason: moduleResult.reason,
      ...(moduleResult.candidates ? { candidates: moduleResult.candidates } : {}),
      evidence: baseEvidence,
      ...(usageLocation ? { usageLocation } : {}),
    });
    return;
  }

  const result = resolveExport(
    moduleResult.path,
    request.importedName,
    projectFiles,
    symbols,
    callables,
    cache,
    new Set(),
  );
  if ("reason" in result) {
    unresolved.push({
      kind,
      importingFile: request.importingFile,
      moduleSpecifier: request.moduleSpecifier,
      localName: request.localName,
      importedName: request.importedName,
      reason: result.reason,
      ...(result.candidates ? { candidates: result.candidates } : {}),
      evidence: [...baseEvidence, {
        kind: "module",
        path: moduleResult.path,
        moduleSpecifier: request.moduleSpecifier,
      }, ...result.evidence],
      ...(usageLocation ? { usageLocation } : {}),
    });
    return;
  }

  resolutions.push({
    kind,
    importingFile: request.importingFile,
    moduleSpecifier: request.moduleSpecifier,
    resolvedModule: moduleResult.path,
    localName: request.localName,
    importedName: request.importedName,
    target: result.target,
    strength: result.reExported ? "re-exported" : "direct",
    evidence: [...baseEvidence, {
      kind: "module",
      path: moduleResult.path,
      moduleSpecifier: request.moduleSpecifier,
    }, ...result.evidence],
    ...(usageLocation ? { usageLocation } : {}),
  });
}

function resolveExport(
  modulePath: string,
  exportedName: string,
  projectFiles: Set<string>,
  symbols: Map<string, FileSymbols>,
  callables: Map<string, CallableRecord>,
  cache: Map<string, ExportResult>,
  visiting: Set<string>,
): ExportResult {
  const key = `${modulePath}::${exportedName}`;
  const cached = cache.get(key);
  if (cached) return cached;
  if (visiting.has(key)) {
    return { reason: "circular-re-export", evidence: [] };
  }
  visiting.add(key);

  const file = symbols.get(modulePath);
  if (!file) {
    visiting.delete(key);
    return { reason: "export-not-found", evidence: [] };
  }
  const direct = file.exports.filter((entry) => entry.exportedName === exportedName && !entry.moduleSpecifier);
  const forwarded = file.exports.filter(
    (entry) => entry.moduleSpecifier && (entry.exportAll || entry.exportedName === exportedName),
  );
  const results: ResolvedExport[] = [];
  let sawCycle = false;

  for (const entry of direct) {
    const declaration = entry.declaration ?? findDeclaration(file, entry.localName ?? exportedName);
    if (!declaration) continue;
    results.push({
      target: targetForDeclaration(declaration, callables),
      evidence: [
        { kind: "export", path: modulePath, name: exportedName, location: entry.location },
        { kind: "declaration", path: modulePath, name: declaration.name, location: declaration.location },
      ],
      reExported: false,
    });
  }

  for (const entry of forwarded) {
    const moduleResult = resolveModulePath(modulePath, entry.moduleSpecifier!, projectFiles);
    if (moduleResult.kind === "failed") continue;
    const nextName = entry.exportAll ? exportedName : entry.importedName ?? exportedName;
    if (entry.exportAll && exportedName === "default") continue;
    const nested = resolveExport(
      moduleResult.path,
      nextName,
      projectFiles,
      symbols,
      callables,
      cache,
      visiting,
    );
    if ("reason" in nested) {
      if (nested.reason === "circular-re-export") sawCycle = true;
      continue;
    }
    results.push({
      target: nested.target,
      evidence: [{
        kind: "re-export",
        path: modulePath,
        moduleSpecifier: entry.moduleSpecifier!,
        name: entry.exportedName,
        location: entry.location,
      }, ...nested.evidence],
      reExported: true,
    });
  }

  visiting.delete(key);
  const unique = uniqueTargets(results);
  let result: ExportResult;
  if (unique.length === 1) result = unique[0]!;
  else if (unique.length > 1) {
    result = {
      reason: "ambiguous-export",
      candidates: unique.map((entry) => entry.target.id).sort(compareText),
      evidence: unique.flatMap((entry) => entry.evidence),
    };
  } else {
    result = { reason: sawCycle ? "circular-re-export" : "export-not-found", evidence: [] };
  }
  cache.set(key, result);
  return result;
}

function readFileSymbols(
  file: SuccessfulSourceAnalysis,
  sourceFile: ts.SourceFile,
): FileSymbols {
  const declarations = new Map<string, DeclarationCandidate[]>();
  const exports: ExportCandidate[] = [];

  const addDeclaration = (name: string, node: ts.Node): DeclarationCandidate => {
    const declaration = { name, location: getLocation(node, sourceFile, file.path) };
    const entries = declarations.get(name) ?? [];
    entries.push(declaration);
    declarations.set(name, entries);
    return declaration;
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? "<anonymous-default>";
      const declaration = addDeclaration(name, statement);
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        exports.push({
          exportedName: hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : name,
          exportAll: false,
          location: declaration.location,
          declaration,
        });
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const item of statement.declarationList.declarations) {
        if (!ts.isIdentifier(item.name)) continue;
        const declaration = addDeclaration(item.name.text, item);
        if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
          exports.push({
            exportedName: item.name.text,
            exportAll: false,
            location: getLocation(statement, sourceFile, file.path),
            declaration,
          });
        }
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
      if (!statement.exportClause) {
        if (moduleSpecifier) {
          exports.push({
            exportedName: "*",
            moduleSpecifier,
            exportAll: true,
            location: getLocation(statement, sourceFile, file.path),
          });
        }
        continue;
      }
      if (ts.isNamedExports(statement.exportClause)) {
        for (const specifier of statement.exportClause.elements) {
          exports.push({
            exportedName: specifier.name.text,
            ...(!moduleSpecifier ? {
              localName: specifier.propertyName?.text ?? specifier.name.text,
            } : {}),
            ...(moduleSpecifier ? {
              moduleSpecifier,
              importedName: specifier.propertyName?.text ?? specifier.name.text,
            } : {}),
            exportAll: false,
            location: getLocation(specifier, sourceFile, file.path),
          });
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = unwrapParentheses(statement.expression);
      const localName = ts.isIdentifier(expression) ? expression.text : undefined;
      const declaration = localName ? findDeclaration({ declarations, exports }, localName) : undefined;
      exports.push({
        exportedName: "default",
        ...(localName ? { localName } : {}),
        exportAll: false,
        location: getLocation(statement, sourceFile, file.path),
        ...(declaration ? { declaration } : {
          declaration: {
            name: "<anonymous-default>",
            location: getLocation(statement, sourceFile, file.path),
          },
        }),
      });
    }
  }
  return { declarations, exports };
}

function readImports(
  file: SuccessfulSourceAnalysis,
  sourceFile: ts.SourceFile,
  imports: ImportRequest[],
  namespaces: NamespaceImport[],
  dynamicImports: UnresolvedSymbolResolution[],
): void {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    const location = getLocation(statement, sourceFile, file.path);
    if (clause.name) {
      imports.push({
        kind: "import",
        importingFile: file.path,
        moduleSpecifier,
        localName: clause.name.text,
        importedName: "default",
        importLocation: location,
      });
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const specifier of clause.namedBindings.elements) {
        imports.push({
          kind: "import",
          importingFile: file.path,
          moduleSpecifier,
          localName: specifier.name.text,
          importedName: specifier.propertyName?.text ?? specifier.name.text,
          importLocation: location,
        });
      }
    } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespaces.push({
        importingFile: file.path,
        moduleSpecifier,
        localName: clause.namedBindings.name.text,
        importLocation: location,
      });
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      dynamicImports.push({
        kind: "dynamic-import",
        importingFile: file.path,
        moduleSpecifier: argument && ts.isStringLiteral(argument) ? argument.text : argument?.getText(sourceFile) ?? "<missing>",
        reason: "dynamic-import-out-of-scope",
        evidence: [{ kind: "import", path: file.path, location: getLocation(node, sourceFile, file.path) }],
        usageLocation: getLocation(node, sourceFile, file.path),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function resolveModulePath(
  importingFile: string,
  moduleSpecifier: string,
  projectFiles: Set<string>,
): { kind: "resolved"; path: string } | {
  kind: "failed";
  reason: "module-not-found" | "ambiguous-module";
  candidates?: string[];
} {
  const base = normalizePath(path.posix.join(path.posix.dirname(importingFile), moduleSpecifier));
  const extension = path.posix.extname(base);
  const candidates = extension && SUPPORTED_EXTENSIONS.includes(extension as typeof SUPPORTED_EXTENSIONS[number])
    ? [base]
    : [
        ...SUPPORTED_EXTENSIONS.map((item) => `${base}${item}`),
        ...SUPPORTED_EXTENSIONS.map((item) => `${base}/index${item}`),
      ];
  const matches = candidates.filter((candidate) => projectFiles.has(candidate));
  if (matches.length === 1) return { kind: "resolved", path: matches[0]! };
  if (matches.length > 1) return { kind: "failed", reason: "ambiguous-module", candidates: matches };
  return { kind: "failed", reason: "module-not-found" };
}

function classifyModuleSpecifier(
  specifier: string,
): "relative" | "external-module" | "unsupported-module-alias" {
  if (specifier.startsWith("./") || specifier.startsWith("../")) return "relative";
  if (specifier.startsWith("@/") || specifier.startsWith("~/")) return "unsupported-module-alias";
  return "external-module";
}

function targetForDeclaration(
  declaration: DeclarationCandidate,
  callables: Map<string, CallableRecord>,
): ResolvedSymbolTarget {
  const callable = callables.get(locationKey(declaration.location));
  return callable
    ? {
        kind: "callable",
        id: callable.id,
        name: callable.name,
        location: callable.location,
      }
    : {
        kind: "declaration",
        id: `declaration:${locationKey(declaration.location)}:${encode(declaration.name)}`,
        name: declaration.name,
        location: declaration.location,
      };
}

function findDeclaration(file: FileSymbols, name: string): DeclarationCandidate | undefined {
  const matches = file.declarations.get(name) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function readNamespaceMember(call: FunctionCall, namespace: string): string | undefined {
  if (call.bindingType !== "member-expression") return undefined;
  const match = new RegExp(`^${escapeRegExp(namespace)}\\.([A-Za-z_$][\\w$]*)$`).exec(call.expression);
  return match?.[1];
}

function uniqueTargets(results: ResolvedExport[]): ResolvedExport[] {
  const byId = new Map<string, ResolvedExport>();
  for (const result of results) {
    const existing = byId.get(result.target.id);
    if (!existing || result.evidence.length < existing.evidence.length) byId.set(result.target.id, result);
  }
  return [...byId.values()].sort((left, right) => compareText(left.target.id, right.target.id));
}

function compareResolution(left: SymbolResolution, right: SymbolResolution): number {
  return compareText(resolutionKey(left), resolutionKey(right));
}

function compareUnresolved(left: UnresolvedSymbolResolution, right: UnresolvedSymbolResolution): number {
  return compareText(resolutionKey(left), resolutionKey(right));
}

function resolutionKey(value: SymbolResolution | UnresolvedSymbolResolution): string {
  return [
    value.importingFile,
    value.moduleSpecifier,
    value.localName ?? "",
    value.importedName ?? "",
    value.kind,
    value.usageLocation ? locationKey(value.usageLocation) : "",
  ].join(":");
}

function getLocation(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): SourceLocation {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return { path: filePath, startLine: start.line + 1, endLine: end.line + 1 };
}

function locationKey(location: SourceLocation): string {
  return `${location.path}:${location.startLine}-${location.endLine}`;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isSuccessfulCodeFile(
  file: SourceAnalysisManifest["files"][number],
): file is SuccessfulSourceAnalysis {
  return file.status === "ok" && isSupportedPath(file.path);
}

function isSupportedPath(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(path.posix.extname(filePath) as typeof SUPPORTED_EXTENSIONS[number]);
}

function normalizePath(value: string): string {
  return path.posix.normalize(value).replace(/^\.\//, "");
}

function encode(value: string): string {
  return encodeURIComponent(value).replaceAll("%2F", "/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
