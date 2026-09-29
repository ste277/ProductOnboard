import path from "node:path";
import ts from "typescript";
import {
  createCallableId,
  type CallableRecord,
  type FunctionCallManifest,
} from "./function-call-analyzer.js";
import type {
  ImportAnalysis,
  SourceAnalysisManifest,
  SourceLocation,
  SuccessfulSourceAnalysis,
} from "./source-analyzer.js";
import { parseTypeScriptSource } from "./typescript-parser.js";

export interface StaticHttpValue {
  kind: "static";
  value: string;
}

export interface DynamicHttpValue {
  kind: "dynamic";
  expression: string;
}

export type HttpValue = StaticHttpValue | DynamicHttpValue;

export interface HttpHeader {
  name: string;
  value: HttpValue;
  location: SourceLocation;
}

export type HttpHeaders =
  | { kind: "entries"; entries: HttpHeader[] }
  | DynamicHttpValue;

export interface HttpClientEvidence {
  expression: string;
  library: "fetch" | "axios";
  importLocation?: SourceLocation;
  instanceLocation?: SourceLocation;
}

export interface HttpCaller {
  id: string;
  name: string;
  location: SourceLocation;
}

export interface HttpRequest {
  scope: "callable" | "module";
  caller?: HttpCaller;
  client: HttpClientEvidence;
  method: HttpValue;
  url: HttpValue;
  baseUrl?: HttpValue;
  effectiveUrl?: StaticHttpValue;
  body?: HttpValue;
  headers?: HttpHeaders;
  arguments: string[];
  awaited: boolean;
  location: SourceLocation;
}

export interface HttpRequestManifest {
  root: string;
  requests: HttpRequest[];
}

interface AxiosClient {
  name: string;
  importLocation: SourceLocation;
}

interface AxiosInstance {
  name: string;
  baseUrl?: HttpValue;
  importLocation: SourceLocation;
  instanceLocation: SourceLocation;
}

interface FileHttpEvidence {
  axiosClients: Map<string, AxiosClient>;
  axiosInstances: Map<string, AxiosInstance>;
  fetchShadowed: boolean;
}

export function analyzeHttpRequests(
  sources: SourceAnalysisManifest,
  calls: FunctionCallManifest,
): HttpRequestManifest {
  if (sources.root !== calls.root) {
    throw new Error("Source and function-call manifests must have the same repository root");
  }

  const requests: HttpRequest[] = [];
  const files = sources.files.filter(isSuccessfulCodeFile);
  files.sort((left, right) => compareText(left.path, right.path));
  const callers = new Map(calls.callers.map((caller) => [caller.id, caller]));

  for (const file of files) {
    requests.push(...analyzeFile(file, callers));
  }

  return { root: sources.root, requests };
}

function analyzeFile(
  file: SuccessfulSourceAnalysis,
  callers: Map<string, CallableRecord>,
): HttpRequest[] {
  const sourceFile = parseTypeScriptSource(file.path, file.sourceText);
  const evidence = collectHttpEvidence(file, sourceFile);
  const requests: HttpRequest[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const request = readHttpRequest(
        node,
        file,
        sourceFile,
        evidence,
        callers,
      );
      if (request) requests.push(request);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return requests;
}

function collectHttpEvidence(
  file: SuccessfulSourceAnalysis,
  sourceFile: ts.SourceFile,
): FileHttpEvidence {
  const axiosClients = new Map<string, AxiosClient>();

  for (const entry of file.imports) {
    if (entry.source !== "axios") continue;
    if (entry.default) {
      axiosClients.set(entry.default, {
        name: entry.default,
        importLocation: entry.location,
      });
    }
    if (entry.namespace) {
      axiosClients.set(entry.namespace, {
        name: entry.namespace,
        importLocation: entry.location,
      });
    }
    for (const named of entry.named) {
      if (named.imported === "default") {
        axiosClients.set(named.local, {
          name: named.local,
          importLocation: entry.location,
        });
      }
    }
  }

  const axiosInstances = new Map<string, AxiosInstance>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      isTopLevelVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const expression = unwrapParentheses(node.initializer.expression);
      if (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "create" &&
        ts.isIdentifier(expression.expression)
      ) {
        const client = axiosClients.get(expression.expression.text);
        if (client) {
          const config = node.initializer.arguments[0];
          const baseUrl = config && ts.isObjectLiteralExpression(config)
            ? readObjectValue(config, "baseURL", sourceFile)
            : undefined;
          axiosInstances.set(node.name.text, {
            name: node.name.text,
            ...(baseUrl ? { baseUrl } : {}),
            importLocation: client.importLocation,
            instanceLocation: getLocation(node, sourceFile, file.path),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    axiosClients,
    axiosInstances,
    fetchShadowed: isFetchShadowed(file.imports, sourceFile),
  };
}

function readHttpRequest(
  call: ts.CallExpression,
  file: SuccessfulSourceAnalysis,
  sourceFile: ts.SourceFile,
  evidence: FileHttpEvidence,
  callers: Map<string, CallableRecord>,
): HttpRequest | undefined {
  const expression = unwrapParentheses(call.expression);
  const caller = findCaller(call, file.path, sourceFile, callers);
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
    arguments: call.arguments.map((argument) => argument.getText(sourceFile)),
    awaited: isAwaited(call),
    location: getLocation(call, sourceFile, file.path),
  };

  if (
    ts.isIdentifier(expression) &&
    expression.text === "fetch" &&
    !evidence.fetchShadowed &&
    !isShadowedInEnclosingFunction(call, "fetch")
  ) {
    const urlExpression = call.arguments[0];
    if (!urlExpression) return undefined;
    const options = call.arguments[1];
    const optionsObject = options && ts.isObjectLiteralExpression(options)
      ? options
      : undefined;
    const method = optionsObject
      ? readObjectValue(optionsObject, "method", sourceFile) ?? staticValue("GET")
      : options
        ? dynamicValue(`${options.getText(sourceFile)}.method`)
        : staticValue("GET");
    const body = optionsObject
      ? readObjectValue(optionsObject, "body", sourceFile)
      : undefined;
    const headers = optionsObject
      ? readHeaders(optionsObject, sourceFile, file.path)
      : undefined;

    return {
      ...common,
      client: { expression: "fetch", library: "fetch" },
      method: normalizeMethod(method),
      url: readValue(urlExpression, sourceFile),
      ...(body ? { body } : {}),
      ...(headers ? { headers } : {}),
    };
  }

  const axios = identifyAxiosCall(expression, evidence);
  if (!axios || axios.operation === "create") return undefined;
  if (isShadowedInEnclosingFunction(call, axios.clientName)) return undefined;

  const details = readAxiosDetails(call, axios.operation, sourceFile, file.path);
  if (!details) return undefined;
  const instance = axios.instance;
  const effectiveUrl = instance?.baseUrl?.kind === "static" && details.url.kind === "static"
    ? combineUrls(instance.baseUrl.value, details.url.value)
    : undefined;

  return {
    ...common,
    client: {
      expression: axios.clientName,
      library: "axios",
      importLocation: axios.importLocation,
      ...(instance ? { instanceLocation: instance.instanceLocation } : {}),
    },
    method: normalizeMethod(details.method),
    url: details.url,
    ...(instance?.baseUrl ? { baseUrl: instance.baseUrl } : {}),
    ...(effectiveUrl ? { effectiveUrl: staticValue(effectiveUrl) } : {}),
    ...(details.body ? { body: details.body } : {}),
    ...(details.headers ? { headers: details.headers } : {}),
  };
}

function identifyAxiosCall(
  expression: ts.Expression,
  evidence: FileHttpEvidence,
): {
  clientName: string;
  operation: string;
  importLocation: SourceLocation;
  instance?: AxiosInstance;
} | undefined {
  if (ts.isIdentifier(expression)) {
    const client = evidence.axiosClients.get(expression.text);
    if (client) {
      return {
        clientName: client.name,
        operation: "config",
        importLocation: client.importLocation,
      };
    }
    const instance = evidence.axiosInstances.get(expression.text);
    if (instance) {
      return {
        clientName: instance.name,
        operation: "config",
        importLocation: instance.importLocation,
        instance,
      };
    }
    return undefined;
  }

  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression)
  ) {
    const root = expression.expression.text;
    const client = evidence.axiosClients.get(root);
    if (client) {
      return {
        clientName: root,
        operation: expression.name.text,
        importLocation: client.importLocation,
      };
    }
    const instance = evidence.axiosInstances.get(root);
    if (instance) {
      return {
        clientName: root,
        operation: expression.name.text,
        importLocation: instance.importLocation,
        instance,
      };
    }
  }

  return undefined;
}

function readAxiosDetails(
  call: ts.CallExpression,
  operation: string,
  sourceFile: ts.SourceFile,
  filePath: string,
): {
  method: HttpValue;
  url: HttpValue;
  body?: HttpValue;
  headers?: HttpHeaders;
} | undefined {
  const methodName = operation.toUpperCase();
  const methodOperations = new Set([
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ]);

  if (methodOperations.has(methodName)) {
    const url = call.arguments[0];
    if (!url) return undefined;
    const hasBody = methodName === "POST" || methodName === "PUT" || methodName === "PATCH";
    const body = hasBody && call.arguments[1]
      ? readValue(call.arguments[1], sourceFile)
      : undefined;
    const config = call.arguments[hasBody ? 2 : 1];
    const headers = config && ts.isObjectLiteralExpression(config)
      ? readHeaders(config, sourceFile, filePath)
      : undefined;
    return {
      method: staticValue(methodName),
      url: readValue(url, sourceFile),
      ...(body ? { body } : {}),
      ...(headers ? { headers } : {}),
    };
  }

  if (operation !== "config" && operation !== "request") return undefined;
  const config = call.arguments[0];
  if (!config) return undefined;
  if (!ts.isObjectLiteralExpression(config)) {
    const text = config.getText(sourceFile);
    return {
      method: dynamicValue(`${text}.method`),
      url: dynamicValue(`${text}.url`),
    };
  }

  const method = readObjectValue(config, "method", sourceFile) ?? staticValue("GET");
  const url = readObjectValue(config, "url", sourceFile);
  if (!url) return undefined;
  const body = readObjectValue(config, "data", sourceFile);
  const headers = readHeaders(config, sourceFile, filePath);
  return {
    method,
    url,
    ...(body ? { body } : {}),
    ...(headers ? { headers } : {}),
  };
}

function readHeaders(
  config: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
): HttpHeaders | undefined {
  const expression = getObjectValueExpression(config, "headers");
  if (!expression) return undefined;
  if (!ts.isObjectLiteralExpression(expression)) {
    return dynamicValue(expression.getText(sourceFile));
  }

  const entries: HttpHeader[] = [];
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = getPropertyName(property.name, sourceFile);
    if (!name) continue;
    entries.push({
      name,
      value: readValue(property.initializer, sourceFile),
      location: getLocation(property, sourceFile, filePath),
    });
  }
  return { kind: "entries", entries };
}

function readObjectValue(
  object: ts.ObjectLiteralExpression,
  name: string,
  sourceFile: ts.SourceFile,
): HttpValue | undefined {
  const expression = getObjectValueExpression(object, name);
  return expression ? readValue(expression, sourceFile) : undefined;
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

function readValue(expression: ts.Expression, sourceFile: ts.SourceFile): HttpValue {
  const value = unwrapParentheses(expression);
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
    ? staticValue(value.text)
    : dynamicValue(value.getText(sourceFile));
}

function normalizeMethod(method: HttpValue): HttpValue {
  return method.kind === "static"
    ? staticValue(method.value.toUpperCase())
    : method;
}

function combineUrls(baseUrl: string, requestUrl: string): string | undefined {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(requestUrl)) return requestUrl;
  if (!baseUrl || !requestUrl) return undefined;
  return `${baseUrl.replace(/\/$/, "")}/${requestUrl.replace(/^\//, "")}`;
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
  const id = createCallableId(
    filePath,
    name,
    declaration.getStart(sourceFile),
  );
  return callers.get(id);
}

function isFetchShadowed(
  imports: ImportAnalysis[],
  sourceFile: ts.SourceFile,
): boolean {
  const imported = imports.some(
    (entry) =>
      entry.default === "fetch" ||
      entry.namespace === "fetch" ||
      entry.named.some((named) => named.local === "fetch"),
  );
  if (imported) return true;

  return sourceFile.statements.some(
    (statement) =>
      (ts.isFunctionDeclaration(statement) && statement.name?.text === "fetch") ||
      (ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (declaration) =>
            ts.isIdentifier(declaration.name) && declaration.name.text === "fetch",
        )),
  );
}

function isShadowedInEnclosingFunction(node: ts.Node, name: string): boolean {
  let scope = findEnclosingRuntimeFunction(node);

  while (scope) {
    if (
      scope.parameters.some(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name,
      )
    ) {
      return true;
    }

    let found = false;
    const visit = (candidate: ts.Node): void => {
      if (found) return;
      if (candidate !== scope?.body && isRuntimeFunction(candidate)) {
        if (ts.isFunctionDeclaration(candidate) && candidate.name?.text === name) {
          found = true;
        }
        return;
      }
      if (
        ts.isVariableDeclaration(candidate) &&
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === name
      ) {
        found = true;
        return;
      }
      ts.forEachChild(candidate, visit);
    };

    if (scope.body) visit(scope.body);
    if (found) return true;
    scope = findEnclosingRuntimeFunction(scope);
  }

  return false;
}

function isTopLevelVariableDeclaration(node: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(node.parent) &&
    ts.isVariableStatement(node.parent.parent) &&
    ts.isSourceFile(node.parent.parent.parent);
}

function isAwaited(call: ts.CallExpression): boolean {
  let current: ts.Node = call;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return ts.isAwaitExpression(current.parent);
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

function isRuntimeFunction(
  node: ts.Node,
): node is ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression {
  return ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node);
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function staticValue(value: string): StaticHttpValue {
  return { kind: "static", value };
}

function dynamicValue(expression: string): DynamicHttpValue {
  return { kind: "dynamic", expression };
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
