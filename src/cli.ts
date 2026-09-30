#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import {
  AuthenticationSessionError,
  createAuthenticatedSession,
  type AuthenticationLocator,
  type AuthenticationSuccessCondition,
} from "./authenticated-session.js";
import { scanRepository } from "./repository-scanner.js";
import { captureRuntimePage, RuntimeCaptureError } from "./runtime-capture.js";
import { probeRuntimeNavigation } from "./navigation-probe.js";
import { discoverRuntimeNavigation } from "./runtime-discovery.js";
import { reconcileProductEvidence } from "./evidence-reconciliation.js";
import { buildFeatureModel } from "./feature-model.js";
import { ingestApiDocumentation } from "./product-contract-evidence.js";
import { reconcileProductContract } from "./contract-reconciliation.js";
import { buildKnowledgeEvidencePackage } from "./knowledge-base-generator.js";
import type { ProductEvidenceGraph } from "./product-evidence-graph.js";
import type { RuntimeNavigationDiscoveryGraph } from "./runtime-discovery.js";

const command = process.argv[2];

if (!command) {
  console.error("Usage: source-inventory <repository-path>");
  process.exitCode = 1;
} else if (command === "capture") {
  const url = process.argv[3];
  const captureOptions = readCaptureFlags(process.argv.slice(4));
  if (!url || !captureOptions) {
    console.error(
      "Usage: source-inventory capture <http(s)-url> [--output <directory>] [--storage-state <path>]",
    );
    process.exitCode = 1;
  } else {
    try {
      const capture = await captureRuntimePage({
        url,
        ...captureOptions,
      });
      console.log(JSON.stringify(capture, null, 2));
    } catch (error) {
      console.error(JSON.stringify(
        error instanceof RuntimeCaptureError
          ? error.failure
          : { message: error instanceof Error ? error.message : String(error) },
        null,
        2,
      ));
      process.exitCode = 1;
    }
  }
} else if (command === "reconcile") {
  const inputs = readReconcileFlags(process.argv.slice(3));
  if (!inputs) {
    console.error("Usage: source-inventory reconcile --static <static-graph.json> --runtime <runtime-discovery.json>");
    process.exitCode = 1;
  } else {
    try {
      const staticGraph = JSON.parse(await readFile(inputs.staticPath, "utf8")) as ProductEvidenceGraph;
      const runtimeDiscovery = JSON.parse(await readFile(inputs.runtimePath, "utf8")) as RuntimeNavigationDiscoveryGraph;
      console.log(JSON.stringify(reconcileProductEvidence({ staticGraph, runtimeDiscovery }), null, 2));
    } catch (error) {
      console.error(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }, null, 2));
      process.exitCode = 1;
    }
  }
} else if (command === "kb-evidence") {
  const inputs = readKnowledgeEvidenceFlags(process.argv.slice(3));
  if (!inputs) {
    console.error("Usage: source-inventory kb-evidence --feature <feature-id> --static <static-graph.json> --runtime <runtime-discovery.json> --reconciliation <reconciliation.json> --features <features.json> --contract <contract.json> --contract-reconciliation <contract-reconciliation.json>");
    process.exitCode = 1;
  } else {
    try {
      const [staticGraph, runtimeDiscovery, reconciliation, featureModel, contractEvidence, contractReconciliation] = await Promise.all([
        inputs.staticPath, inputs.runtimePath, inputs.reconciliationPath, inputs.featuresPath, inputs.contractPath,
        inputs.contractReconciliationPath,
      ].map(async (file) => JSON.parse(await readFile(file, "utf8"))));
      console.log(JSON.stringify(buildKnowledgeEvidencePackage({ featureId: inputs.featureId, staticGraph, runtimeDiscovery,
        reconciliation, featureModel, contractEvidence, contractReconciliation }), null, 2));
    } catch (error) {
      console.error(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }, null, 2));
      process.exitCode = 1;
    }
  }
} else if (command === "contract-reconcile") {
  const inputs = readContractReconcileFlags(process.argv.slice(3));
  if (!inputs) {
    console.error("Usage: source-inventory contract-reconcile --contract <contract.json> --static <static-graph.json> --runtime <runtime-discovery.json> --reconciliation <reconciliation.json> --features <features.json>");
    process.exitCode = 1;
  } else {
    try {
      const [contract, staticGraph, runtimeDiscovery, productReconciliation, featureModel] = await Promise.all([
        inputs.contractPath, inputs.staticPath, inputs.runtimePath, inputs.reconciliationPath, inputs.featuresPath,
      ].map(async (file) => JSON.parse(await readFile(file, "utf8"))));
      console.log(JSON.stringify(reconcileProductContract({ contract, staticGraph, runtimeDiscovery, productReconciliation, featureModel }), null, 2));
    } catch (error) {
      console.error(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }, null, 2));
      process.exitCode = 1;
    }
  }
} else if (command === "contract") {
  const url = process.argv[3];
  if (!url || process.argv.length > 4) {
    console.error("Usage: source-inventory contract <http(s)-url>");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await ingestApiDocumentation({ url }), null, 2));
    } catch (error) {
      console.error(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }, null, 2));
      process.exitCode = 1;
    }
  }
} else if (command === "features") {
  const inputs = readFeatureFlags(process.argv.slice(3));
  if (!inputs) {
    console.error("Usage: source-inventory features --static <static-graph.json> --runtime <runtime-discovery.json> --reconciliation <reconciliation.json>");
    process.exitCode = 1;
  } else {
    try {
      const staticGraph = JSON.parse(await readFile(inputs.staticPath, "utf8"));
      const runtimeDiscovery = JSON.parse(await readFile(inputs.runtimePath, "utf8"));
      const reconciliation = JSON.parse(await readFile(inputs.reconciliationPath, "utf8"));
      console.log(JSON.stringify(buildFeatureModel({ staticGraph, runtimeDiscovery, reconciliation }), null, 2));
    } catch (error) {
      console.error(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }, null, 2));
      process.exitCode = 1;
    }
  }
} else if (command === "discover") {
  const url = process.argv[3];
  const discoveryOptions = readDiscoveryFlags(process.argv.slice(4));
  if (!url || !discoveryOptions) {
    console.error(
      "Usage: source-inventory discover <http(s)-url> [--storage-state <path>] " +
      "[--output <directory>] [--max-depth <n>] [--max-states <n>] " +
      "[--max-transitions <n>] [--max-targets-per-state <n>]",
    );
    process.exitCode = 1;
  } else {
    try {
      const result = await discoverRuntimeNavigation({ startUrl: url, ...discoveryOptions });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }, null, 2));
      process.exitCode = 1;
    }
  }
} else if (command === "probe") {
  const url = process.argv[3];
  const probeOptions = readProbeFlags(process.argv.slice(4));
  if (!url || !probeOptions?.targetId) {
    console.error(
      "Usage: source-inventory probe <http(s)-url> --target <runtime-target-id> " +
      "[--output <directory>] [--storage-state <path>]",
    );
    process.exitCode = 1;
  } else {
    try {
      const result = await probeRuntimeNavigation({ url, targetId: probeOptions.targetId!,
        ...(probeOptions.outputDirectory ? { outputDirectory: probeOptions.outputDirectory } : {}),
        ...(probeOptions.storageStatePath ? { storageStatePath: probeOptions.storageStatePath } : {}) });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(JSON.stringify(
        error instanceof RuntimeCaptureError
          ? error.failure
          : { message: error instanceof Error ? error.message : String(error) },
        null,
        2,
      ));
      process.exitCode = 1;
    }
  }
} else if (command === "auth") {
  const configPath = process.argv[3];
  if (!configPath || process.argv.length > 4) {
    console.error("Usage: source-inventory auth <auth-config.json>");
    process.exitCode = 1;
  } else {
    try {
      const username = process.env.DEMO_USERNAME;
      const password = process.env.DEMO_PASSWORD;
      if (!username || !password) {
        throw new Error("DEMO_USERNAME and DEMO_PASSWORD environment variables are required");
      }
      const config = JSON.parse(await readFile(configPath, "utf8")) as AuthenticationCliConfig;
      const session = await createAuthenticatedSession({
        loginUrl: config.loginUrl,
        credentials: { username, password },
        locators: config.locators,
        success: config.success,
        ...(config.outputDirectory ? { outputDirectory: config.outputDirectory } : {}),
        ...(config.accountLabel ? { accountLabel: config.accountLabel } : {}),
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      });
      console.log(JSON.stringify(session, null, 2));
    } catch (error) {
      console.error(JSON.stringify(
        error instanceof AuthenticationSessionError
          ? error.failure
          : { message: error instanceof Error ? error.message : String(error) },
        null,
        2,
      ));
      process.exitCode = 1;
    }
  }
} else {
  try {
    const inventory = await scanRepository(command);
    console.log(JSON.stringify(inventory, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function readReconcileFlags(arguments_: string[]): { staticPath: string; runtimePath: string } | undefined {
  let staticPath: string | undefined;
  let runtimePath: string | undefined;
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!value) return undefined;
    if (flag === "--static") staticPath = value;
    else if (flag === "--runtime") runtimePath = value;
    else return undefined;
  }
  return staticPath && runtimePath ? { staticPath, runtimePath } : undefined;
}

function readFeatureFlags(arguments_: string[]): {
  staticPath: string;
  runtimePath: string;
  reconciliationPath: string;
} | undefined {
  let staticPath: string | undefined;
  let runtimePath: string | undefined;
  let reconciliationPath: string | undefined;
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!value) return undefined;
    if (flag === "--static") staticPath = value;
    else if (flag === "--runtime") runtimePath = value;
    else if (flag === "--reconciliation") reconciliationPath = value;
    else return undefined;
  }
  return staticPath && runtimePath && reconciliationPath
    ? { staticPath, runtimePath, reconciliationPath }
    : undefined;
}

function readContractReconcileFlags(arguments_: string[]): {
  contractPath: string; staticPath: string; runtimePath: string; reconciliationPath: string; featuresPath: string;
} | undefined {
  const result: Partial<{ contractPath: string; staticPath: string; runtimePath: string; reconciliationPath: string; featuresPath: string }> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]; const value = arguments_[index + 1]; if (!value) return undefined;
    if (flag === "--contract") result.contractPath = value;
    else if (flag === "--static") result.staticPath = value;
    else if (flag === "--runtime") result.runtimePath = value;
    else if (flag === "--reconciliation") result.reconciliationPath = value;
    else if (flag === "--features") result.featuresPath = value;
    else return undefined;
  }
  return result.contractPath && result.staticPath && result.runtimePath && result.reconciliationPath && result.featuresPath
    ? result as Required<typeof result> : undefined;
}

function readKnowledgeEvidenceFlags(arguments_: string[]): {
  featureId: string; contractPath: string; staticPath: string; runtimePath: string; reconciliationPath: string;
  featuresPath: string; contractReconciliationPath: string;
} | undefined {
  const result: Partial<{ featureId: string; contractPath: string; staticPath: string; runtimePath: string;
    reconciliationPath: string; featuresPath: string; contractReconciliationPath: string }> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]; const value = arguments_[index + 1]; if (!value) return undefined;
    if (flag === "--feature") result.featureId = value;
    else if (flag === "--contract") result.contractPath = value;
    else if (flag === "--static") result.staticPath = value;
    else if (flag === "--runtime") result.runtimePath = value;
    else if (flag === "--reconciliation") result.reconciliationPath = value;
    else if (flag === "--features") result.featuresPath = value;
    else if (flag === "--contract-reconciliation") result.contractReconciliationPath = value;
    else return undefined;
  }
  return result.featureId && result.contractPath && result.staticPath && result.runtimePath && result.reconciliationPath &&
    result.featuresPath && result.contractReconciliationPath ? result as Required<typeof result> : undefined;
}

function readDiscoveryFlags(arguments_: string[]): {
  storageStatePath?: string;
  outputDirectory?: string;
  limits?: { maxDepth?: number; maxStates?: number; maxTransitions?: number; maxTargetsPerState?: number };
} | undefined {
  const result: {
    storageStatePath?: string;
    outputDirectory?: string;
    limits?: { maxDepth?: number; maxStates?: number; maxTransitions?: number; maxTargetsPerState?: number };
  } = {};
  const limits: NonNullable<typeof result.limits> = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!value) return undefined;
    if (flag === "--storage-state") result.storageStatePath = value;
    else if (flag === "--output") result.outputDirectory = value;
    else {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0) return undefined;
      if (flag === "--max-depth") limits.maxDepth = number;
      else if (flag === "--max-states") limits.maxStates = number;
      else if (flag === "--max-transitions") limits.maxTransitions = number;
      else if (flag === "--max-targets-per-state") limits.maxTargetsPerState = number;
      else return undefined;
    }
  }
  if (Object.keys(limits).length > 0) result.limits = limits;
  return result;
}

function readProbeFlags(arguments_: string[]): {
  targetId?: string;
  outputDirectory?: string;
  storageStatePath?: string;
} | undefined {
  const result: { targetId?: string; outputDirectory?: string; storageStatePath?: string } = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!value) return undefined;
    if (flag === "--target") result.targetId = value;
    else if (flag === "--output") result.outputDirectory = value;
    else if (flag === "--storage-state") result.storageStatePath = value;
    else return undefined;
  }
  return result;
}

interface AuthenticationCliConfig {
  loginUrl: string;
  locators: {
    username: AuthenticationLocator;
    password: AuthenticationLocator;
    submit: AuthenticationLocator;
  };
  success: AuthenticationSuccessCondition;
  outputDirectory?: string;
  accountLabel?: string;
  timeoutMs?: number;
}

function readCaptureFlags(
  arguments_: string[],
): { outputDirectory?: string; storageStatePath?: string } | undefined {
  const result: { outputDirectory?: string; storageStatePath?: string } = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!value) return undefined;
    if (flag === "--output") result.outputDirectory = value;
    else if (flag === "--storage-state") result.storageStatePath = value;
    else return undefined;
  }
  return result;
}
