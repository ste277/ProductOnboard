import { readFileSync } from "node:fs";
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
const SUPPORTED_COMPONENT_EXPORT_WRAPPERS = new Set(["withLDConsumer", "withRouter"]);

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
  | "configured-path-alias-target-not-found"
  | "configured-path-alias-outside-repository"
  | "workspace-package-target-not-found"
  | "dynamic-import-out-of-scope";

export interface ConfiguredModuleResolution {
  kind: "path-alias" | "base-url";
  configPath: string;
  aliasPattern?: string;
  expandedTarget: string;
}

export interface WorkspaceModuleResolution {
  packageName: string;
  packageRoot: string;
  manifestPath: string;
  expandedTarget: string;
}

export interface ProjectConfigurationError {
  path: string;
  message: string;
}

export interface ModuleResolutionEvidence {
  kind: "import" | "module" | "export" | "re-export" | "declaration" | "call" | "configuration" | "path-alias" | "workspace-package";
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
  configuredModule?: ConfiguredModuleResolution;
  workspaceModule?: WorkspaceModuleResolution;
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
  configuredModule?: ConfiguredModuleResolution;
  workspaceModule?: WorkspaceModuleResolution;
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
  configurationErrors: ProjectConfigurationError[];
}

interface ProjectConfiguration {
  path: string;
  directory: string;
  baseUrl?: string;
  paths: Array<{ pattern: string; targets: string[] }>;
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
type ModuleResult = { kind: "resolved"; path: string } | {
  kind: "failed";
  reason: "module-not-found" | "ambiguous-module";
  candidates?: string[];
};

interface ConfiguredModuleResult {
  moduleResult: ModuleResult;
  metadata: ConfiguredModuleResolution;
  failureReason?: "configured-path-alias-target-not-found" | "configured-path-alias-outside-repository";
}

interface WorkspacePackage {
  name: string;
  root: string;
  manifestPath: string;
  entryPoints: string[];
}

interface WorkspaceModuleResult {
  moduleResult: ModuleResult;
  metadata: WorkspaceModuleResolution;
  alternativeMetadata?: WorkspaceModuleResolution[];
}

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
  const { configurations, errors: configurationErrors } = loadProjectConfigurations(inventory);
  const workspacePackages = loadWorkspacePackages(inventory);
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
    resolveRequest(request, projectFiles, symbols, callables, exportCache, resolutions, unresolved, configurations,
      workspacePackages);
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
          configurations,
          workspacePackages,
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
    configurationErrors,
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
  configurations: ProjectConfiguration[],
  workspacePackages: WorkspacePackage[],
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
  const configured = classification === "relative"
    ? undefined
    : resolveConfiguredModule(request.importingFile, request.moduleSpecifier, projectFiles, configurations);
  const workspace = classification === "relative" || configured?.moduleResult.kind === "resolved"
    ? undefined
    : resolveWorkspaceModule(request.moduleSpecifier, projectFiles, workspacePackages);
  if (classification !== "relative" && !configured && !workspace) {
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

  const moduleResult = configured?.moduleResult.kind === "resolved"
    ? configured.moduleResult
    : workspace?.moduleResult ?? configured?.moduleResult ?? resolveModulePath(
    request.importingFile, request.moduleSpecifier, projectFiles);
  const configuredUsed = configured?.moduleResult.kind === "resolved" ? configured : undefined;
  if (moduleResult.kind === "failed") {
    unresolved.push({
      kind,
      importingFile: request.importingFile,
      moduleSpecifier: request.moduleSpecifier,
      localName: request.localName,
      importedName: request.importedName,
      reason: workspace
        ? moduleResult.reason === "ambiguous-module"
          ? "ambiguous-module"
          : "workspace-package-target-not-found"
        : configured?.failureReason ?? moduleResult.reason,
      ...(moduleResult.candidates ? { candidates: moduleResult.candidates } : {}),
      evidence: [...baseEvidence, ...(configuredUsed ? configuredEvidence(configuredUsed.metadata) : []),
        ...(workspace ? workspaceEvidence(workspace.metadata, workspace.alternativeMetadata) : [])],
      ...(configuredUsed ? { configuredModule: configuredUsed.metadata } : {}),
      ...(workspace ? { workspaceModule: workspace.metadata } : {}),
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
      evidence: [...baseEvidence, ...(configuredUsed ? configuredEvidence(configuredUsed.metadata) : []),
        ...(workspace ? workspaceEvidence(workspace.metadata, workspace.alternativeMetadata) : []), {
        kind: "module",
        path: moduleResult.path,
        moduleSpecifier: request.moduleSpecifier,
      }, ...result.evidence],
      ...(usageLocation ? { usageLocation } : {}),
      ...(configuredUsed ? { configuredModule: configuredUsed.metadata } : {}),
      ...(workspace ? { workspaceModule: workspace.metadata } : {}),
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
    evidence: [...baseEvidence, ...(configuredUsed ? configuredEvidence(configuredUsed.metadata) : []),
      ...(workspace ? workspaceEvidence(workspace.metadata, workspace.alternativeMetadata) : []), {
      kind: "module",
      path: moduleResult.path,
      moduleSpecifier: request.moduleSpecifier,
    }, ...result.evidence],
    ...(usageLocation ? { usageLocation } : {}),
    ...(configuredUsed ? { configuredModule: configuredUsed.metadata } : {}),
    ...(workspace ? { workspaceModule: workspace.metadata } : {}),
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
      const localName = readSupportedComponentExportIdentifier(expression);
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

function readSupportedComponentExportIdentifier(expression: ts.Expression): string | undefined {
  const current = unwrapParentheses(expression);
  if (ts.isIdentifier(current)) return current.text;
  if (!ts.isCallExpression(current) || current.arguments.length !== 1) return undefined;
  const wrapper = readWrapperName(current.expression);
  if (!wrapper || !SUPPORTED_COMPONENT_EXPORT_WRAPPERS.has(wrapper)) return undefined;
  return readSupportedComponentExportIdentifier(current.arguments[0]!);
}

function readWrapperName(expression: ts.Expression): string | undefined {
  const current = unwrapParentheses(expression);
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isCallExpression(current)) {
    const callee = unwrapParentheses(current.expression);
    if (ts.isIdentifier(callee)) return callee.text;
  }
  return undefined;
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
): ModuleResult {
  const base = normalizePath(path.posix.join(path.posix.dirname(importingFile), moduleSpecifier));
  return resolveModuleBase(base, projectFiles);
}

function resolveModuleBase(base: string, projectFiles: Set<string>): ModuleResult {
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

function resolveConfiguredModule(
  importingFile: string,
  moduleSpecifier: string,
  projectFiles: Set<string>,
  configurations: ProjectConfiguration[],
): ConfiguredModuleResult | undefined {
  const applicable = configurations
    .filter((config) => isWithinDirectory(importingFile, config.directory))
    .sort((left, right) => {
      const depth = pathDepth(right.directory) - pathDepth(left.directory);
      return depth || compareText(left.path, right.path);
    });

  for (const config of applicable) {
    const mapping = selectPathMapping(moduleSpecifier, config.paths);
    if (mapping) {
      const wildcard = matchPathPattern(moduleSpecifier, mapping.pattern);
      if (wildcard === undefined) continue;
      let firstMetadata: ConfiguredModuleResolution | undefined;
      for (const target of mapping.targets) {
        const substituted = target.includes("*") ? target.replace("*", wildcard) : target;
        const expandedTarget = normalizePath(path.posix.join(config.baseUrl ?? config.directory, substituted));
        const metadata: ConfiguredModuleResolution = {
          kind: "path-alias",
          configPath: config.path,
          aliasPattern: mapping.pattern,
          expandedTarget,
        };
        firstMetadata ??= metadata;
        if (!isRepositoryPath(expandedTarget)) {
          return {
            moduleResult: { kind: "failed", reason: "module-not-found" },
            metadata,
            failureReason: "configured-path-alias-outside-repository",
          };
        }
        const result = resolveModuleBase(expandedTarget, projectFiles);
        if (result.kind === "resolved" || result.reason === "ambiguous-module") {
          return { moduleResult: result, metadata };
        }
      }
      return {
        moduleResult: { kind: "failed", reason: "module-not-found" },
        metadata: firstMetadata!,
        failureReason: "configured-path-alias-target-not-found",
      };
    }

    if (config.baseUrl) {
      const expandedTarget = normalizePath(path.posix.join(config.baseUrl, moduleSpecifier));
      if (!isRepositoryPath(expandedTarget)) continue;
      const result = resolveModuleBase(expandedTarget, projectFiles);
      if (result.kind === "resolved" || result.reason === "ambiguous-module") {
        return {
          moduleResult: result,
          metadata: { kind: "base-url", configPath: config.path, expandedTarget },
        };
      }
    }
  }
  return undefined;
}

function resolveWorkspaceModule(
  moduleSpecifier: string,
  projectFiles: Set<string>,
  packages: WorkspacePackage[],
): WorkspaceModuleResult | undefined {
  const matches = packages.filter((item) =>
    moduleSpecifier === item.name || moduleSpecifier.startsWith(`${item.name}/`));
  if (matches.length === 0) return undefined;

  const longestName = Math.max(...matches.map((item) => item.name.length));
  const candidates = matches.filter((item) => item.name.length === longestName);
  if (candidates.length > 1) {
    const metadata = candidates.map((item): WorkspaceModuleResolution => ({
      packageName: item.name,
      packageRoot: item.root,
      manifestPath: item.manifestPath,
      expandedTarget: item.root,
    }));
    return {
      moduleResult: {
        kind: "failed",
        reason: "ambiguous-module",
        candidates: candidates.map((item) => item.manifestPath).sort(compareText),
      },
      metadata: metadata[0]!,
      alternativeMetadata: metadata.slice(1),
    };
  }
  const workspacePackage = candidates[0]!;
  const subpath = moduleSpecifier === workspacePackage.name
    ? ""
    : moduleSpecifier.slice(workspacePackage.name.length + 1);
  const bases = subpath
    ? [normalizePath(path.posix.join(workspacePackage.root, subpath))]
    : workspacePackage.entryPoints.length > 0
      ? workspacePackage.entryPoints.map((entry) => normalizePath(path.posix.join(workspacePackage.root, entry)))
      : [workspacePackage.root];
  const results = bases.map((base) => ({ base, result: resolveModuleBase(base, projectFiles) }));
  const resolved = results.filter((item) => item.result.kind === "resolved");
  const expandedTarget = resolved[0]?.base ?? bases[0]!;
  const metadata: WorkspaceModuleResolution = {
    packageName: workspacePackage.name,
    packageRoot: workspacePackage.root,
    manifestPath: workspacePackage.manifestPath,
    expandedTarget,
  };
  if (resolved.length === 1) return { moduleResult: resolved[0]!.result, metadata };
  if (resolved.length > 1) {
    return {
      moduleResult: {
        kind: "failed",
        reason: "ambiguous-module",
        candidates: resolved.map((item) => (item.result as { kind: "resolved"; path: string }).path)
          .sort(compareText),
      },
      metadata,
    };
  }
  const ambiguous = results.find((item) =>
    item.result.kind === "failed" && item.result.reason === "ambiguous-module");
  return { moduleResult: ambiguous?.result ?? { kind: "failed", reason: "module-not-found" }, metadata };
}

function selectPathMapping(
  specifier: string,
  mappings: ProjectConfiguration["paths"],
): ProjectConfiguration["paths"][number] | undefined {
  return mappings
    .filter((mapping) => matchPathPattern(specifier, mapping.pattern) !== undefined)
    .sort((left, right) => {
      const leftExact = left.pattern.includes("*") ? 0 : 1;
      const rightExact = right.pattern.includes("*") ? 0 : 1;
      return rightExact - leftExact || pathPatternPrefix(right.pattern).length - pathPatternPrefix(left.pattern).length ||
        compareText(left.pattern, right.pattern);
    })[0];
}

function matchPathPattern(specifier: string, pattern: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star < 0) return specifier === pattern ? "" : undefined;
  if (pattern.indexOf("*", star + 1) >= 0) return undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : undefined;
}

function pathPatternPrefix(pattern: string): string {
  const star = pattern.indexOf("*");
  return star < 0 ? pattern : pattern.slice(0, star);
}

function configuredEvidence(metadata: ConfiguredModuleResolution): ModuleResolutionEvidence[] {
  return [
    { kind: "configuration", path: metadata.configPath },
    {
      kind: "path-alias",
      path: metadata.expandedTarget,
      ...(metadata.aliasPattern ? { moduleSpecifier: metadata.aliasPattern } : {}),
      name: metadata.kind,
    },
  ];
}

function workspaceEvidence(
  metadata: WorkspaceModuleResolution,
  alternatives: WorkspaceModuleResolution[] = [],
): ModuleResolutionEvidence[] {
  return [metadata, ...alternatives].flatMap((item) => [
    { kind: "configuration" as const, path: item.manifestPath },
    {
      kind: "workspace-package" as const,
      path: item.expandedTarget,
      moduleSpecifier: item.packageName,
      name: item.packageRoot,
    },
  ]);
}

function classifyModuleSpecifier(
  specifier: string,
): "relative" | "external-module" | "unsupported-module-alias" {
  if (specifier.startsWith("./") || specifier.startsWith("../")) return "relative";
  if (specifier.startsWith("@/") || specifier.startsWith("~/")) return "unsupported-module-alias";
  return "external-module";
}

function loadProjectConfigurations(inventory: RepositoryInventory): {
  configurations: ProjectConfiguration[];
  errors: ProjectConfigurationError[];
} {
  const configPaths = new Set(inventory.files
    .map((file) => normalizePath(file.path))
    .filter((filePath) => /(?:^|\/)(?:tsconfig|jsconfig)\.json$/.test(filePath)));
  const cache = new Map<string, ProjectConfiguration>();
  const errors: ProjectConfigurationError[] = [];
  const loading = new Set<string>();

  const load = (configPath: string): ProjectConfiguration | undefined => {
    const cached = cache.get(configPath);
    if (cached) return cached;
    if (loading.has(configPath)) {
      errors.push({ path: configPath, message: "Circular configuration extends chain" });
      return undefined;
    }
    loading.add(configPath);
    let parsed: Record<string, unknown>;
    try {
      const absolutePath = path.join(inventory.root, ...configPath.split("/"));
      const result = ts.parseConfigFileTextToJson(configPath, readFileSync(absolutePath, "utf8"));
      if (result.error || !result.config || typeof result.config !== "object") {
        const message = result.error
          ? ts.flattenDiagnosticMessageText(result.error.messageText, "\n")
          : "Configuration must contain a JSON object";
        errors.push({ path: configPath, message });
        loading.delete(configPath);
        return undefined;
      }
      parsed = result.config as Record<string, unknown>;
    } catch (error) {
      errors.push({ path: configPath, message: error instanceof Error ? error.message : String(error) });
      loading.delete(configPath);
      return undefined;
    }

    const directory = normalizeDirectory(path.posix.dirname(configPath));
    const extendsValue = typeof parsed.extends === "string" ? parsed.extends : undefined;
    const parentPath = extendsValue ? resolveExtendedConfig(directory, extendsValue, configPaths) : undefined;
    const parent = parentPath ? load(parentPath) : undefined;
    if (extendsValue && !parentPath) {
      errors.push({ path: configPath, message: `Unsupported or missing extends target: ${extendsValue}` });
    }
    const compilerOptions = parsed.compilerOptions && typeof parsed.compilerOptions === "object"
      ? parsed.compilerOptions as Record<string, unknown>
      : {};
    const ownBaseUrl = typeof compilerOptions.baseUrl === "string"
      ? normalizePath(path.posix.join(directory, compilerOptions.baseUrl))
      : undefined;
    const ownPaths = readConfiguredPaths(compilerOptions.paths);
    const configuration: ProjectConfiguration = {
      path: configPath,
      directory,
      ...(ownBaseUrl !== undefined
        ? { baseUrl: ownBaseUrl }
        : parent?.baseUrl ? { baseUrl: parent.baseUrl } : {}),
      paths: ownPaths ?? parent?.paths ?? [],
    };
    cache.set(configPath, configuration);
    loading.delete(configPath);
    return configuration;
  };

  for (const configPath of [...configPaths].sort(compareText)) load(configPath);
  return {
    configurations: [...cache.values()].sort((left, right) => compareText(left.path, right.path)),
    errors: errors.sort((left, right) => compareText(`${left.path}:${left.message}`, `${right.path}:${right.message}`)),
  };
}

function loadWorkspacePackages(inventory: RepositoryInventory): WorkspacePackage[] {
  const manifestPaths = inventory.files
    .map((file) => normalizePath(file.path))
    .filter((filePath) => /(?:^|\/)package\.json$/.test(filePath))
    .sort(compareText);
  const manifests = new Map<string, Record<string, unknown>>();
  for (const manifestPath of manifestPaths) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(inventory.root, ...manifestPath.split("/")), "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        manifests.set(manifestPath, parsed as Record<string, unknown>);
      }
    } catch {
      // Malformed package metadata cannot prove workspace membership.
    }
  }

  const packages: WorkspacePackage[] = [];
  for (const [rootManifestPath, rootManifest] of manifests) {
    const rootDirectory = normalizeDirectory(path.posix.dirname(rootManifestPath));
    const patterns = readWorkspacePatterns(rootManifest.workspaces);
    if (patterns.length === 0) continue;
    for (const [manifestPath, manifest] of manifests) {
      if (manifestPath === rootManifestPath) continue;
      const packageRoot = normalizeDirectory(path.posix.dirname(manifestPath));
      const relativeRoot = normalizePath(path.posix.relative(rootDirectory || ".", packageRoot));
      const name = typeof manifest.name === "string" ? manifest.name : undefined;
      if (!name || !patterns.some((pattern) => workspacePatternMatches(pattern, relativeRoot))) continue;
      const entryPoints = [manifest.types, manifest.module, manifest.main]
        .filter((entry): entry is string => typeof entry === "string");
      packages.push({ name, root: packageRoot, manifestPath, entryPoints });
    }
  }
  return packages.sort((left, right) =>
    compareText(`${left.name}:${left.manifestPath}`, `${right.name}:${right.manifestPath}`));
}

function readWorkspacePatterns(value: unknown): string[] {
  const patterns = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { packages?: unknown }).packages)
      ? (value as { packages: unknown[] }).packages
      : [];
  return patterns.filter((item): item is string => typeof item === "string")
    .map((item) => normalizePath(item.replace(/\/$/, "")));
}

function workspacePatternMatches(pattern: string, packageRoot: string): boolean {
  const expression = pattern.split("*").map(escapeRegExp).join("[^/]*");
  return new RegExp(`^${expression}$`).test(packageRoot);
}

function readConfiguredPaths(value: unknown): ProjectConfiguration["paths"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string[]] =>
      Array.isArray(entry[1]) && entry[1].every((target) => typeof target === "string"))
    .map(([pattern, targets]) => ({ pattern, targets: [...targets] }));
}

function resolveExtendedConfig(
  directory: string,
  extendsValue: string,
  configPaths: Set<string>,
): string | undefined {
  if (!extendsValue.startsWith(".")) return undefined;
  const candidate = normalizePath(path.posix.join(directory, extendsValue));
  for (const item of [candidate, `${candidate}.json`]) {
    if (isRepositoryPath(item) && configPaths.has(item)) return item;
  }
  return undefined;
}

function isWithinDirectory(filePath: string, directory: string): boolean {
  return directory === "" || filePath === directory || filePath.startsWith(`${directory}/`);
}

function normalizeDirectory(directory: string): string {
  return directory === "." ? "" : normalizePath(directory);
}

function pathDepth(value: string): number {
  return value === "" ? 0 : value.split("/").length;
}

function isRepositoryPath(value: string): boolean {
  return value !== ".." && !value.startsWith("../") && !path.posix.isAbsolute(value);
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
