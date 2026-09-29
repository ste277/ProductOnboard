import path from "node:path";
import ts from "typescript";
import type {
  ImportAnalysis,
  SourceAnalysisManifest,
  SourceLocation,
  SuccessfulSourceAnalysis,
} from "./source-analyzer.js";
import { parseTypeScriptSource } from "./typescript-parser.js";

export type CallableKind =
  | "function-declaration"
  | "arrow-function"
  | "function-expression"
  | "inline-callback";

export interface LocalCallBinding {
  bindingType: "local";
  callee: {
    id: string;
    name: string;
    location: SourceLocation;
  };
}

export interface ImportedCallBinding {
  bindingType: "imported";
  localName: string;
  importedName: string;
  source: string;
  importLocation: SourceLocation;
}

export interface MemberCallBinding {
  bindingType: "member-expression";
}

export interface UnresolvedCallBinding {
  bindingType: "unresolved";
}

export type CallBinding =
  | LocalCallBinding
  | ImportedCallBinding
  | MemberCallBinding
  | UnresolvedCallBinding;

export type FunctionCall = CallBinding & {
  expression: string;
  arguments: string[];
  awaited: boolean;
  optional: boolean;
  location: SourceLocation;
};

export interface CallableRecord {
  id: string;
  name: string;
  kind: CallableKind;
  async: boolean;
  parentId?: string;
  location: SourceLocation;
  calls: FunctionCall[];
}

export interface FunctionCallManifest {
  root: string;
  callers: CallableRecord[];
}

interface CallableInternal {
  id: string;
  name: string;
  kind: CallableKind;
  declaration: ts.Node;
  functionNode: ts.FunctionLikeDeclaration;
  ownerFunction?: ts.FunctionLikeDeclaration;
  parentId?: string;
  location: SourceLocation;
}

export function analyzeFunctionCalls(
  sources: SourceAnalysisManifest,
): FunctionCallManifest {
  const callers: CallableRecord[] = [];
  const files = sources.files.filter(isSuccessfulCodeFile);
  files.sort((left, right) => compareText(left.path, right.path));

  for (const file of files) callers.push(...analyzeFile(file));
  return { root: sources.root, callers };
}

function analyzeFile(file: SuccessfulSourceAnalysis): CallableRecord[] {
  const sourceFile = parseTypeScriptSource(file.path, file.sourceText);
  const callables = collectCallables(sourceFile, file.path);
  const byName = new Map<string, CallableInternal[]>();

  for (const callable of callables) {
    if (callable.name.startsWith("<")) continue;
    const existing = byName.get(callable.name) ?? [];
    existing.push(callable);
    byName.set(callable.name, existing);
  }

  return callables.map((callable) => ({
    id: callable.id,
    name: callable.name,
    kind: callable.kind,
    async: hasModifier(callable.functionNode, ts.SyntaxKind.AsyncKeyword),
    ...(callable.parentId ? { parentId: callable.parentId } : {}),
    location: callable.location,
    calls: readCalls(callable, byName, file.imports, sourceFile, file.path),
  }));
}

function collectCallables(
  sourceFile: ts.SourceFile,
  filePath: string,
): CallableInternal[] {
  const callables: CallableInternal[] = [];
  const claimed = new Set<ts.FunctionLikeDeclaration>();

  const add = (
    name: string,
    kind: CallableKind,
    declaration: ts.Node,
    functionNode: ts.FunctionLikeDeclaration,
  ): void => {
    claimed.add(functionNode);
    const ownerFunction = findEnclosingRuntimeFunction(declaration);
    callables.push({
      id: getCallableId(filePath, name, declaration, sourceFile),
      name,
      kind,
      declaration,
      functionNode,
      ...(ownerFunction ? { ownerFunction } : {}),
      location: getLocation(declaration, sourceFile, filePath),
    });
  };

  const visitDeclarations = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) {
      add(
        node.name?.text ?? "<anonymous>",
        "function-declaration",
        node,
        node,
      );
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isRuntimeFunction(node.initializer)
    ) {
      add(
        node.name.text,
        ts.isArrowFunction(node.initializer)
          ? "arrow-function"
          : "function-expression",
        node,
        node.initializer,
      );
    }
    ts.forEachChild(node, visitDeclarations);
  };

  visitDeclarations(sourceFile);

  const visitInlineFunctions = (node: ts.Node): void => {
    if (isRuntimeFunction(node) && !claimed.has(node)) {
      const owner = findEnclosingRuntimeFunction(node);
      const name = "<inline-callback>";
      const parent = owner
        ? callables.find((candidate) => candidate.functionNode === owner)
        : undefined;
      callables.push({
        id: getCallableId(filePath, name, node, sourceFile),
        name,
        kind: "inline-callback",
        declaration: node,
        functionNode: node,
        ...(owner ? { ownerFunction: owner } : {}),
        ...(parent ? { parentId: parent.id } : {}),
        location: getLocation(node, sourceFile, filePath),
      });
    }
    ts.forEachChild(node, visitInlineFunctions);
  };

  visitInlineFunctions(sourceFile);

  for (const callable of callables) {
    if (callable.parentId || !callable.ownerFunction) continue;
    const parent = callables.find(
      (candidate) => candidate.functionNode === callable.ownerFunction,
    );
    if (parent) callable.parentId = parent.id;
  }

  callables.sort(
    (left, right) => left.declaration.getStart(sourceFile) - right.declaration.getStart(sourceFile),
  );
  return callables;
}

function readCalls(
  caller: CallableInternal,
  localCallables: Map<string, CallableInternal[]>,
  imports: ImportAnalysis[],
  sourceFile: ts.SourceFile,
  filePath: string,
): FunctionCall[] {
  const calls: FunctionCall[] = [];
  const body = caller.functionNode.body;
  if (!body) return calls;

  const visit = (node: ts.Node): void => {
    if (node !== body && isRuntimeFunction(node)) return;

    if (ts.isCallExpression(node)) {
      const expression = unwrapParentheses(node.expression);
      calls.push({
        expression: expression.getText(sourceFile),
        arguments: node.arguments.map((argument) => argument.getText(sourceFile)),
        awaited: isAwaited(node),
        optional: isOptionalCall(node),
        location: getLocation(node, sourceFile, filePath),
        ...resolveCall(
          expression,
          caller,
          localCallables,
          imports,
        ),
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(body);
  return calls;
}

function resolveCall(
  expression: ts.Expression,
  caller: CallableInternal,
  localCallables: Map<string, CallableInternal[]>,
  imports: ImportAnalysis[],
): CallBinding {
  if (ts.isIdentifier(expression)) {
    const local = findLocalCallee(expression.text, caller, localCallables);
    if (local) {
      return {
        bindingType: "local",
        callee: {
          id: local.id,
          name: local.name,
          location: local.location,
        },
      };
    }

    const imported = findImportedCall(expression.text, imports);
    if (imported) return imported;
    return { bindingType: "unresolved" };
  }

  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    return { bindingType: "member-expression" };
  }

  return { bindingType: "unresolved" };
}

function findLocalCallee(
  name: string,
  caller: CallableInternal,
  localCallables: Map<string, CallableInternal[]>,
): CallableInternal | undefined {
  const candidates = localCallables.get(name) ?? [];
  if (candidates.length === 0) return undefined;

  const functionChain: ts.FunctionLikeDeclaration[] = [];
  let current: ts.FunctionLikeDeclaration | undefined = caller.functionNode;
  while (current) {
    functionChain.push(current);
    current = findEnclosingRuntimeFunction(current);
  }

  const ranked = candidates
    .map((candidate) => {
      if (candidate.functionNode === caller.functionNode) return { candidate, rank: -1 };
      if (!candidate.ownerFunction) return { candidate, rank: functionChain.length + 1 };
      const rank = functionChain.indexOf(candidate.ownerFunction);
      return rank >= 0 ? { candidate, rank } : undefined;
    })
    .filter((entry): entry is { candidate: CallableInternal; rank: number } =>
      entry !== undefined);

  if (ranked.length === 0) return undefined;
  const bestRank = Math.min(...ranked.map((entry) => entry.rank));
  const best = ranked.filter((entry) => entry.rank === bestRank);
  return best.length === 1 ? best[0]?.candidate : undefined;
}

function findImportedCall(
  localName: string,
  imports: ImportAnalysis[],
): ImportedCallBinding | undefined {
  for (const entry of imports) {
    if (entry.default === localName) {
      return {
        bindingType: "imported",
        localName,
        importedName: "default",
        source: entry.source,
        importLocation: entry.location,
      };
    }

    const named = entry.named.find((candidate) => candidate.local === localName);
    if (named) {
      return {
        bindingType: "imported",
        localName,
        importedName: named.imported,
        source: entry.source,
        importLocation: entry.location,
      };
    }
  }
  return undefined;
}

function isAwaited(call: ts.CallExpression): boolean {
  let current: ts.Node = call;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return ts.isAwaitExpression(current.parent);
}

function isOptionalCall(call: ts.CallExpression): boolean {
  return call.questionDotToken !== undefined ||
    (ts.isPropertyAccessExpression(call.expression) &&
      call.expression.questionDotToken !== undefined) ||
    (ts.isElementAccessExpression(call.expression) &&
      call.expression.questionDotToken !== undefined);
}

function getCallableId(
  filePath: string,
  name: string,
  declaration: ts.Node,
  sourceFile: ts.SourceFile,
): string {
  return createCallableId(filePath, name, declaration.getStart(sourceFile));
}

export function createCallableId(
  filePath: string,
  name: string,
  sourceOffset: number,
): string {
  return `${filePath}::${name}@${sourceOffset}`;
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

function findEnclosingRuntimeFunction(
  node: ts.Node,
): ts.FunctionLikeDeclaration | undefined {
  let current = node.parent;
  while (current) {
    if (isRuntimeFunction(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isRuntimeFunction(
  node: ts.Node | undefined,
): node is ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression {
  return node !== undefined &&
    (ts.isFunctionDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node));
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

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
