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
