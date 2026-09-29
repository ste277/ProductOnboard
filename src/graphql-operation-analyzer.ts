import path from "node:path";
import {
  Kind,
  parse,
  print,
  type ASTNode,
  type DirectiveNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionNode,
  type VariableDefinitionNode,
} from "graphql";
import ts from "typescript";
import {
  createCallableId,
  type CallableRecord,
  type FunctionCallManifest,
} from "./function-call-analyzer.js";
import type {
  SourceAnalysisManifest,
  SourceLocation,
  SuccessfulSourceAnalysis,
} from "./source-analyzer.js";
import { parseTypeScriptSource } from "./typescript-parser.js";

export type GraphqlOperationType = "query" | "mutation" | "subscription";

export interface GraphqlArgument {
  name: string;
  value: string;
}

export interface GraphqlDirective {
  name: string;
  arguments: GraphqlArgument[];
}

export interface GraphqlFieldSelection {
  kind: "field";
  name: string;
  alias?: string;
  arguments: GraphqlArgument[];
  directives: GraphqlDirective[];
  selections: GraphqlSelection[];
  location: SourceLocation;
}

export interface GraphqlFragmentSpread {
  kind: "fragment-spread";
  name: string;
  directives: GraphqlDirective[];
  location: SourceLocation;
}

export interface GraphqlInlineFragment {
  kind: "inline-fragment";
  typeCondition?: string;
  directives: GraphqlDirective[];
  selections: GraphqlSelection[];
  location: SourceLocation;
}

export type GraphqlSelection =
  | GraphqlFieldSelection
  | GraphqlFragmentSpread
  | GraphqlInlineFragment;

export interface GraphqlVariableDefinition {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
  location: SourceLocation;
}

export interface GraphqlOperation {
  type: GraphqlOperationType;
  name?: string;
  variables: GraphqlVariableDefinition[];
  directives: GraphqlDirective[];
  selections: GraphqlSelection[];
  location: SourceLocation;
}

export interface GraphqlFragment {
  name: string;
  typeCondition: string;
  directives: GraphqlDirective[];
  selections: GraphqlSelection[];
  location: SourceLocation;
}

export interface GraphqlDocumentBase {
  id: string;
  name: string;
  tag: string;
  tagImportLocation: SourceLocation;
  declarationLocation: SourceLocation;
  templateLocation: SourceLocation;
}

export interface SuccessfulGraphqlDocument extends GraphqlDocumentBase {
  status: "ok";
  operations: GraphqlOperation[];
  fragments: GraphqlFragment[];
}

export interface GraphqlParseError {
  message: string;
  line?: number;
  column?: number;
}

export interface FailedGraphqlDocument extends GraphqlDocumentBase {
  status: "parse-error";
  errors: GraphqlParseError[];
}

export type GraphqlDocument =
  | SuccessfulGraphqlDocument
  | FailedGraphqlDocument;

export interface StaticGraphqlValue {
  kind: "static";
  value: string | number | boolean | null;
}

export interface DynamicGraphqlValue {
  kind: "dynamic";
  expression: string;
}

export type GraphqlValue = StaticGraphqlValue | DynamicGraphqlValue;

export interface SuppliedGraphqlVariable {
  name: string;
  value: GraphqlValue;
  location: SourceLocation;
}

export type SuppliedGraphqlVariables =
  | { kind: "entries"; entries: SuppliedGraphqlVariable[] }
  | DynamicGraphqlValue;

export type GraphqlDocumentReference =
  | {
      kind: "local";
      documentId: string;
      name: string;
      location: SourceLocation;
    }
  | DynamicGraphqlValue;

export interface GraphqlExecution {
  scope: "callable" | "module";
  caller?: {
    id: string;
    name: string;
    location: SourceLocation;
  };
  phase: "setup" | "execute";
  operationType: GraphqlOperationType;
  executor: string;
  localExecutor?: string;
  document: GraphqlDocumentReference;
  variables?: SuppliedGraphqlVariables;
  awaited: boolean;
  executorImportLocation?: SourceLocation;
  clientInstanceLocation?: SourceLocation;
  location: SourceLocation;
}

export interface GraphqlOperationManifest {
  root: string;
  documents: GraphqlDocument[];
  executions: GraphqlExecution[];
}

interface ImportedExecutor {
  operationType: GraphqlOperationType;
  importLocation: SourceLocation;
}

interface ApolloClientInstance {
  importLocation: SourceLocation;
  instanceLocation: SourceLocation;
}

interface MutationExecutor {
  document: GraphqlDocumentReference;
  importLocation: SourceLocation;
  setupLocation: SourceLocation;
}

interface FileGraphqlEvidence {
  tags: Map<string, SourceLocation>;
  executors: Map<string, ImportedExecutor>;
  clientConstructors: Map<string, SourceLocation>;
  clients: Map<string, ApolloClientInstance>;
  mutationExecutors: Map<string, MutationExecutor>;
}

export function analyzeGraphqlOperations(
  sources: SourceAnalysisManifest,
  calls: FunctionCallManifest,
): GraphqlOperationManifest {
  if (sources.root !== calls.root) {
    throw new Error("Source and function-call manifests must have the same repository root");
  }

  const documents: GraphqlDocument[] = [];
  const executions: GraphqlExecution[] = [];
  const files = sources.files.filter(isSuccessfulCodeFile);
  files.sort((left, right) => compareText(left.path, right.path));
  const callers = new Map(calls.callers.map((caller) => [caller.id, caller]));

  for (const file of files) {
    const sourceFile = parseTypeScriptSource(file.path, file.sourceText);
    const evidence = collectImportEvidence(file);
    const fileDocuments = readDocuments(file, sourceFile, evidence.tags);
    const documentsByName = new Map(
      fileDocuments.map((document) => [document.name, document]),
    );
    collectApolloClients(sourceFile, file.path, evidence);
    collectMutationExecutors(
      sourceFile,
      file.path,
      evidence,
      documentsByName,
    );
    documents.push(...fileDocuments);
    executions.push(
      ...readExecutions(
        file,
        sourceFile,
        evidence,
        documentsByName,
        callers,
      ),
    );
  }

  return { root: sources.root, documents, executions };
}

function collectImportEvidence(file: SuccessfulSourceAnalysis): FileGraphqlEvidence {
  const tags = new Map<string, SourceLocation>();
  const executors = new Map<string, ImportedExecutor>();
  const clientConstructors = new Map<string, SourceLocation>();

  for (const entry of file.imports) {
    if (entry.source === "graphql-tag" && entry.default) {
      tags.set(entry.default, entry.location);
    }
    if (entry.source !== "@apollo/client") continue;

    for (const named of entry.named) {
      if (named.imported === "gql") tags.set(named.local, entry.location);
      if (named.imported === "ApolloClient") {
        clientConstructors.set(named.local, entry.location);
      }
      const operationType = getHookOperationType(named.imported);
      if (operationType) {
        executors.set(named.local, {
          operationType,
          importLocation: entry.location,
        });
      }
    }
  }

  return {
    tags,
    executors,
    clientConstructors,
    clients: new Map(),
    mutationExecutors: new Map(),
  };
}

function readDocuments(
  file: SuccessfulSourceAnalysis,
  sourceFile: ts.SourceFile,
  tags: Map<string, SourceLocation>,
): GraphqlDocument[] {
  const documents: GraphqlDocument[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      tags.has(node.tag.text)
    ) {
      const declaration = ts.isVariableDeclaration(node.parent)
        ? node.parent
        : node;
      const name = ts.isVariableDeclaration(declaration) &&
          ts.isIdentifier(declaration.name)
        ? declaration.name.text
        : `<anonymous-document@${declaration.getStart(sourceFile)}>`;
      const base: GraphqlDocumentBase = {
        id: `${file.path}::${name}@${declaration.getStart(sourceFile)}`,
        name,
        tag: node.tag.text,
        tagImportLocation: tags.get(node.tag.text)!,
        declarationLocation: getLocation(declaration, sourceFile, file.path),
        templateLocation: getLocation(node.template, sourceFile, file.path),
      };

      if (!ts.isNoSubstitutionTemplateLiteral(node.template)) {
        documents.push({
          ...base,
          status: "parse-error",
          errors: [
            {
              message: "Interpolated GraphQL documents are not statically parseable",
            },
          ],
        });
      } else {
        documents.push(
          parseGraphqlDocument(
            base,
            node.template.text,
            node.template.getStart(sourceFile) + 1,
            sourceFile,
            file.path,
          ),
        );
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return documents;
}

function parseGraphqlDocument(
  base: GraphqlDocumentBase,
  sourceText: string,
  contentStart: number,
  sourceFile: ts.SourceFile,
  filePath: string,
): GraphqlDocument {
  try {
    const document = parse(sourceText, { noLocation: false });
    const operations: GraphqlOperation[] = [];
    const fragments: GraphqlFragment[] = [];

    for (const definition of document.definitions) {
      if (definition.kind === Kind.OPERATION_DEFINITION) {
        operations.push(
          readOperation(definition, contentStart, sourceFile, filePath),
        );
      } else if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.push(
          readFragment(definition, contentStart, sourceFile, filePath),
        );
      }
    }

    return { ...base, status: "ok", operations, fragments };
  } catch (error) {
    const graphError = error as {
      message?: string;
      locations?: Array<{ line: number; column: number }>;
    };
    const firstLocation = graphError.locations?.[0];
    return {
      ...base,
      status: "parse-error",
      errors: [
        {
          message: graphError.message ?? String(error),
          ...(firstLocation
            ? { line: firstLocation.line, column: firstLocation.column }
            : {}),
        },
      ],
    };
  }
}

function readOperation(
  node: OperationDefinitionNode,
  contentStart: number,
  sourceFile: ts.SourceFile,
  filePath: string,
): GraphqlOperation {
  return {
    type: node.operation,
    ...(node.name ? { name: node.name.value } : {}),
    variables: (node.variableDefinitions ?? []).map((variable) =>
      readVariableDefinition(variable, contentStart, sourceFile, filePath)),
    directives: (node.directives ?? []).map(readDirective),
    selections: node.selectionSet.selections.map((selection) =>
      readSelection(selection, contentStart, sourceFile, filePath)),
    location: getGraphqlLocation(node, contentStart, sourceFile, filePath),
  };
}

function readVariableDefinition(
  node: VariableDefinitionNode,
  contentStart: number,
  sourceFile: ts.SourceFile,
  filePath: string,
): GraphqlVariableDefinition {
  return {
    name: node.variable.name.value,
    type: print(node.type),
    required: node.type.kind === Kind.NON_NULL_TYPE,
    ...(node.defaultValue ? { defaultValue: print(node.defaultValue) } : {}),
    location: getGraphqlLocation(node, contentStart, sourceFile, filePath),
  };
}

function readFragment(
  node: FragmentDefinitionNode,
  contentStart: number,
  sourceFile: ts.SourceFile,
  filePath: string,
): GraphqlFragment {
  return {
    name: node.name.value,
    typeCondition: node.typeCondition.name.value,
    directives: (node.directives ?? []).map(readDirective),
    selections: node.selectionSet.selections.map((selection) =>
      readSelection(selection, contentStart, sourceFile, filePath)),
    location: getGraphqlLocation(node, contentStart, sourceFile, filePath),
  };
}

function readSelection(
  node: SelectionNode,
  contentStart: number,
  sourceFile: ts.SourceFile,
  filePath: string,
): GraphqlSelection {
  if (node.kind === Kind.FIELD) {
    return readField(node, contentStart, sourceFile, filePath);
  }
  if (node.kind === Kind.FRAGMENT_SPREAD) {
    return {
      kind: "fragment-spread",
      name: node.name.value,
      directives: (node.directives ?? []).map(readDirective),
      location: getGraphqlLocation(node, contentStart, sourceFile, filePath),
    };
  }
  return {
    kind: "inline-fragment",
    ...(node.typeCondition
      ? { typeCondition: node.typeCondition.name.value }
      : {}),
    directives: (node.directives ?? []).map(readDirective),
    selections: node.selectionSet.selections.map((selection) =>
      readSelection(selection, contentStart, sourceFile, filePath)),
    location: getGraphqlLocation(node, contentStart, sourceFile, filePath),
  };
}

function readField(
  node: FieldNode,
  contentStart: number,
  sourceFile: ts.SourceFile,
  filePath: string,
): GraphqlFieldSelection {
  return {
    kind: "field",
    name: node.name.value,
    ...(node.alias ? { alias: node.alias.value } : {}),
    arguments: (node.arguments ?? []).map((argument) => ({
      name: argument.name.value,
      value: print(argument.value),
    })),
    directives: (node.directives ?? []).map(readDirective),
    selections: node.selectionSet
      ? node.selectionSet.selections.map((selection) =>
          readSelection(selection, contentStart, sourceFile, filePath))
      : [],
    location: getGraphqlLocation(node, contentStart, sourceFile, filePath),
  };
}

function readDirective(node: DirectiveNode): GraphqlDirective {
  return {
    name: node.name.value,
    arguments: (node.arguments ?? []).map((argument) => ({
      name: argument.name.value,
      value: print(argument.value),
    })),
  };
}

function collectApolloClients(
  sourceFile: ts.SourceFile,
  filePath: string,
  evidence: FileGraphqlEvidence,
): void {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !ts.isNewExpression(declaration.initializer) ||
        !ts.isIdentifier(declaration.initializer.expression)
      ) {
        continue;
      }
      const importLocation = evidence.clientConstructors.get(
        declaration.initializer.expression.text,
      );
      if (!importLocation) continue;
      evidence.clients.set(declaration.name.text, {
        importLocation,
        instanceLocation: getLocation(declaration, sourceFile, filePath),
      });
    }
  }
}

function collectMutationExecutors(
  sourceFile: ts.SourceFile,
  filePath: string,
  evidence: FileGraphqlEvidence,
  documents: Map<string, GraphqlDocument>,
): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression)
    ) {
      const executor = evidence.executors.get(node.initializer.expression.text);
      const firstElement = node.name.elements[0];
      if (
        executor?.operationType === "mutation" &&
        firstElement &&
        ts.isBindingElement(firstElement) &&
        ts.isIdentifier(firstElement.name)
      ) {
        const documentExpression = node.initializer.arguments[0];
        if (documentExpression) {
          evidence.mutationExecutors.set(firstElement.name.text, {
            document: readDocumentReference(
              documentExpression,
              documents,
              sourceFile,
            ),
            importLocation: executor.importLocation,
            setupLocation: getLocation(node.initializer, sourceFile, filePath),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function readExecutions(
  file: SuccessfulSourceAnalysis,
  sourceFile: ts.SourceFile,
  evidence: FileGraphqlEvidence,
  documents: Map<string, GraphqlDocument>,
  callers: Map<string, CallableRecord>,
): GraphqlExecution[] {
  const executions: GraphqlExecution[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const execution = readExecution(
        node,
        file.path,
        sourceFile,
        evidence,
        documents,
        callers,
      );
      if (execution) executions.push(execution);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return executions;
}

function readExecution(
  call: ts.CallExpression,
  filePath: string,
  sourceFile: ts.SourceFile,
  evidence: FileGraphqlEvidence,
  documents: Map<string, GraphqlDocument>,
  callers: Map<string, CallableRecord>,
): GraphqlExecution | undefined {
  const expression = unwrapParentheses(call.expression);
  const caller = findCaller(call, filePath, sourceFile, callers);
  const common = {
    scope: caller ? "callable" as const : "module" as const,
    ...(caller
      ? {
          caller: {
            id: caller.id,
            name: caller.name,
            location: caller.location,
          },
        }
      : {}),
    awaited: isAwaited(call),
    location: getLocation(call, sourceFile, filePath),
  };

  if (ts.isIdentifier(expression)) {
    const hook = evidence.executors.get(expression.text);
    if (hook) {
      const documentExpression = call.arguments[0];
      if (!documentExpression) return undefined;
      const localExecutor = hook.operationType === "mutation"
        ? readMutationExecutorName(call.parent)
        : undefined;
      return {
        ...common,
        phase: hook.operationType === "mutation" ? "setup" : "execute",
        operationType: hook.operationType,
        executor: expression.text,
        ...(localExecutor ? { localExecutor } : {}),
        document: readDocumentReference(
          documentExpression,
          documents,
          sourceFile,
        ),
        ...readVariablesFromOptions(call.arguments[1], sourceFile, filePath),
        executorImportLocation: hook.importLocation,
      };
    }

    const mutation = evidence.mutationExecutors.get(expression.text);
    if (mutation) {
      return {
        ...common,
        phase: "execute",
        operationType: "mutation",
        executor: expression.text,
        document: mutation.document,
        ...readVariablesFromOptions(call.arguments[0], sourceFile, filePath),
        executorImportLocation: mutation.importLocation,
      };
    }
  }

  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    (expression.name.text === "query" || expression.name.text === "mutate")
  ) {
    const client = evidence.clients.get(expression.expression.text);
    if (!client) return undefined;
    const config = call.arguments[0];
    if (!config || !ts.isObjectLiteralExpression(config)) return undefined;
    const operationType = expression.name.text === "query" ? "query" : "mutation";
    const documentExpression = getObjectValueExpression(
      config,
      operationType === "query" ? "query" : "mutation",
    );
    if (!documentExpression) return undefined;
    return {
      ...common,
      phase: "execute",
      operationType,
      executor: expression.getText(sourceFile),
      document: readDocumentReference(
        documentExpression,
        documents,
        sourceFile,
      ),
      ...readVariablesFromOptions(config, sourceFile, filePath),
      executorImportLocation: client.importLocation,
      clientInstanceLocation: client.instanceLocation,
    };
  }

  return undefined;
}

function readDocumentReference(
  expression: ts.Expression,
  documents: Map<string, GraphqlDocument>,
  sourceFile: ts.SourceFile,
): GraphqlDocumentReference {
  const value = unwrapParentheses(expression);
  if (ts.isIdentifier(value)) {
    const document = documents.get(value.text);
    if (document) {
      return {
        kind: "local",
        documentId: document.id,
        name: document.name,
        location: document.declarationLocation,
      };
    }
  }
  return { kind: "dynamic", expression: value.getText(sourceFile) };
}

function readVariablesFromOptions(
  options: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
  filePath: string,
): { variables?: SuppliedGraphqlVariables } {
  if (!options) return {};
  const value = unwrapParentheses(options);
  if (!ts.isObjectLiteralExpression(value)) {
    return {
      variables: {
        kind: "dynamic",
        expression: `${value.getText(sourceFile)}.variables`,
      },
    };
  }
  const variables = getObjectValueExpression(value, "variables");
  if (!variables) return {};
  if (!ts.isObjectLiteralExpression(variables)) {
    return {
      variables: {
        kind: "dynamic",
        expression: variables.getText(sourceFile),
      },
    };
  }

  const entries: SuppliedGraphqlVariable[] = [];
  for (const property of variables.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = getPropertyName(property.name, sourceFile);
      if (!name) continue;
      entries.push({
        name,
        value: readTsValue(property.initializer, sourceFile),
        location: getLocation(property, sourceFile, filePath),
      });
    } else if (ts.isShorthandPropertyAssignment(property)) {
      entries.push({
        name: property.name.text,
        value: { kind: "dynamic", expression: property.name.text },
        location: getLocation(property, sourceFile, filePath),
      });
    }
  }
  return { variables: { kind: "entries", entries } };
}

function readTsValue(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
): GraphqlValue {
  const value = unwrapParentheses(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return { kind: "static", value: value.text };
  }
  if (ts.isNumericLiteral(value)) {
    return { kind: "static", value: Number(value.text) };
  }
  if (value.kind === ts.SyntaxKind.TrueKeyword) {
    return { kind: "static", value: true };
  }
  if (value.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: "static", value: false };
  }
  if (value.kind === ts.SyntaxKind.NullKeyword) {
    return { kind: "static", value: null };
  }
  return { kind: "dynamic", expression: value.getText(sourceFile) };
}

function readMutationExecutorName(node: ts.Node): string | undefined {
  if (!ts.isVariableDeclaration(node) || !ts.isArrayBindingPattern(node.name)) {
    return undefined;
  }
  const first = node.name.elements[0];
  return first && ts.isBindingElement(first) && ts.isIdentifier(first.name)
    ? first.name.text
    : undefined;
}

function getGraphqlLocation(
  node: ASTNode,
  contentStart: number,
  sourceFile: ts.SourceFile,
  filePath: string,
): SourceLocation {
  const startOffset = contentStart + (node.loc?.start ?? 0);
  const endOffset = contentStart + (node.loc?.end ?? node.loc?.start ?? 0);
  const start = sourceFile.getLineAndCharacterOfPosition(startOffset);
  const end = sourceFile.getLineAndCharacterOfPosition(endOffset);
  return {
    path: filePath,
    startLine: start.line + 1,
    endLine: end.line + 1,
  };
}

function getObjectValueExpression(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === name) ||
        (ts.isStringLiteral(property.name) && property.name.text === name))
    ) {
      return property.initializer;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      return property.name;
    }
  }
  return undefined;
}

function getPropertyName(
  name: ts.PropertyName,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return ts.isComputedPropertyName(name) ? name.getText(sourceFile) : undefined;
}

function findCaller(
  node: ts.Node,
  filePath: string,
  sourceFile: ts.SourceFile,
  callers: Map<string, CallableRecord>,
): CallableRecord | undefined {
  const functionNode = findEnclosingRuntimeFunction(node);
  if (!functionNode) return undefined;
  const variable = functionNode.parent;
  const isVariableCallable =
    ts.isVariableDeclaration(variable) &&
    variable.initializer === functionNode &&
    ts.isIdentifier(variable.name);
  const declaration = isVariableCallable ? variable : functionNode;
  const name = ts.isFunctionDeclaration(functionNode)
    ? functionNode.name?.text ?? "<anonymous>"
    : isVariableCallable
      ? variable.name.text
      : "<inline-callback>";
  return callers.get(
    createCallableId(filePath, name, declaration.getStart(sourceFile)),
  );
}

function findEnclosingRuntimeFunction(
  node: ts.Node,
): ts.FunctionLikeDeclaration | undefined {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function isAwaited(call: ts.CallExpression): boolean {
  let current: ts.Node = call;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return ts.isAwaitExpression(current.parent);
}

function getHookOperationType(name: string): GraphqlOperationType | undefined {
  if (name === "useQuery") return "query";
  if (name === "useMutation") return "mutation";
  if (name === "useSubscription") return "subscription";
  return undefined;
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
