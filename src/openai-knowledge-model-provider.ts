import { readFile } from "node:fs/promises";
import type {
  GroundedKnowledgeWriterRequest,
  GroundedKnowledgeWriterResponse,
  KnowledgeModelProvider,
} from "./grounded-ai-knowledge-writer.js";

export interface OpenAiKnowledgeModelProviderOptions {
  apiKey: string;
  model: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}

export interface OpenAiEnvironmentConfig {
  apiKey: string;
  model: string;
}

interface OpenAiResponseEnvelope {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class OpenAiKnowledgeModelProvider implements KnowledgeModelProvider {
  readonly provider = "openai";
  readonly model: string;
  readonly structuredResponses: GroundedKnowledgeWriterResponse[] = [];
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetch_: typeof globalThis.fetch;

  constructor(options: OpenAiKnowledgeModelProviderOptions) {
    if (!options.apiKey) throw new TypeError("OpenAI API key is required");
    if (!options.model) throw new TypeError("OpenAI model is required");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
    this.fetch_ = options.fetch ?? globalThis.fetch;
  }

  async generate(request: GroundedKnowledgeWriterRequest): Promise<GroundedKnowledgeWriterResponse> {
    const response = await this.fetch_(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        store: false,
        input: [
          { role: "system", content: providerInstructions(request.rules) },
          { role: "user", content: JSON.stringify({ objective: request.objective, articleMode: request.articleMode,
            evidence: request.evidence, ...(request.repair ? { repair: request.repair } : {}) }) },
        ],
        text: { format: { type: "json_schema", name: "grounded_knowledge_article", strict: true,
          schema: GROUNDED_OUTPUT_SCHEMA } },
      }),
    });
    if (!response.ok) {
      const failure = await safeFailure(response);
      throw new Error(`OpenAI Responses API request failed with status ${response.status}${failure ? ` (${failure})` : ""}`);
    }
    const envelope = await response.json() as OpenAiResponseEnvelope;
    const text = outputText(envelope);
    if (!text) throw new Error("OpenAI Responses API returned no structured output");
    const output = normalizeOutput(JSON.parse(text));
    const result: GroundedKnowledgeWriterResponse = {
      output,
      ...(envelope.usage ? { usage: {
        ...(envelope.usage.input_tokens !== undefined ? { inputTokens: envelope.usage.input_tokens } : {}),
        ...(envelope.usage.output_tokens !== undefined ? { outputTokens: envelope.usage.output_tokens } : {}),
      } } : {}),
    };
    this.structuredResponses.push(structuredClone(result));
    return result;
  }
}

export async function loadOpenAiEnvironmentConfig(path = ".env.local"): Promise<OpenAiEnvironmentConfig> {
  const values = parseEnvironment(await readFile(path, "utf8"));
  const apiKey = process.env.OPENAI_API_KEY || values.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || values.OPENAI_MODEL;
  if (!apiKey || !model) throw new Error("OPENAI_API_KEY and OPENAI_MODEL must be configured");
  return { apiKey, model };
}

function parseEnvironment(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]!] = value;
  }
  return result;
}

function providerInstructions(rules: string[]): string {
  return [
    "Produce one grounded customer-facing knowledge article as JSON matching the supplied schema.",
    "Complete claim selection and article planning before writing prose.",
    "Classify every supplied claim exactly once. Keep reasons concise.",
    "Use null when no expected result is supported and null for an unlabeled step group.",
    ...rules,
  ].join("\n");
}

function outputText(response: OpenAiResponseEnvelope): string | undefined {
  if (response.output_text) return response.output_text;
  return response.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
}

async function safeFailure(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { type?: unknown; code?: unknown } };
    const parts = [body.error?.type, body.error?.code].filter((item): item is string => typeof item === "string")
      .map((item) => item.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80));
    return [...new Set(parts)].join("/");
  } catch { return ""; }
}

function normalizeOutput(value: unknown): GroundedKnowledgeWriterResponse["output"] {
  if (!value || typeof value !== "object") return value as GroundedKnowledgeWriterResponse["output"];
  const output = structuredClone(value) as Record<string, unknown>;
  if (output.expectedResult === null) delete output.expectedResult;
  if (output.articlePlan && typeof output.articlePlan === "object") {
    const plan = output.articlePlan as Record<string, unknown>;
    if (Array.isArray(plan.stepGroups)) plan.stepGroups = plan.stepGroups.map((group) => {
      if (!group || typeof group !== "object") return group;
      const normalized = { ...(group as Record<string, unknown>) };
      if (normalized.label === null) delete normalized.label;
      return normalized;
    });
  }
  return output as unknown as GroundedKnowledgeWriterResponse["output"];
}

const STATEMENT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["text", "claimIds"],
  properties: { text: { type: "string" }, claimIds: { type: "array", items: { type: "string" } } },
} as const;
const SELECTION_SCHEMA = (relevance: string) => ({
  type: "object", additionalProperties: false, required: ["claimId", "relevance", "reason"],
  properties: { claimId: { type: "string" }, relevance: { type: "string", enum: [relevance] }, reason: { type: "string" } },
});
const GROUNDED_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["title", "titleClaimIds", "articleType", "summary", "prerequisites", "steps", "expectedResult", "notes",
    "limitations", "claimSelection", "articlePlan", "screenshotIntents"],
  properties: {
    title: { type: "string" }, titleClaimIds: { type: "array", items: { type: "string" } },
    articleType: { type: "string", enum: ["overview", "procedure"] }, summary: STATEMENT_SCHEMA,
    prerequisites: { type: "array", items: STATEMENT_SCHEMA }, steps: { type: "array", items: STATEMENT_SCHEMA },
    expectedResult: { anyOf: [STATEMENT_SCHEMA, { type: "null" }] }, notes: { type: "array", items: STATEMENT_SCHEMA },
    limitations: { type: "array", items: STATEMENT_SCHEMA },
    claimSelection: {
      type: "object", additionalProperties: false,
      required: ["selectedClaims", "contextClaims", "excludedClaims", "duplicatesRemoved"],
      properties: {
        selectedClaims: { type: "array", items: SELECTION_SCHEMA("task-relevant") },
        contextClaims: { type: "array", items: SELECTION_SCHEMA("context-navigation") },
        excludedClaims: { type: "array", items: {
          type: "object", additionalProperties: false, required: ["claimId", "relevance", "reason"],
          properties: { claimId: { type: "string" }, relevance: { type: "string",
            enum: ["shared-shell", "incidental", "unsupported-for-task"] }, reason: { type: "string",
            enum: ["shared-navigation", "duplicate", "unrelated-action", "insufficient-task-evidence", "internal-only"] } },
        } },
        duplicatesRemoved: { type: "array", items: { type: "object", additionalProperties: false,
          required: ["claimId", "retainedClaimId"], properties: { claimId: { type: "string" }, retainedClaimId: { type: "string" } } } },
      },
    },
    articlePlan: {
      type: "object", additionalProperties: false,
      required: ["titleClaimIds", "summaryClaimIds", "prerequisiteClaimIds", "navigationClaimIds", "stepGroups",
        "expectedResultClaimIds", "noteClaimIds", "limitationClaimIds"],
      properties: {
        titleClaimIds: { type: "array", items: { type: "string" } }, summaryClaimIds: { type: "array", items: { type: "string" } },
        prerequisiteClaimIds: { type: "array", items: { type: "string" } }, navigationClaimIds: { type: "array", items: { type: "string" } },
        stepGroups: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "claimIds"],
          properties: { label: { anyOf: [{ type: "string" }, { type: "null" }] },
            claimIds: { type: "array", items: { type: "string" } } } } },
        expectedResultClaimIds: { type: "array", items: { type: "string" } }, noteClaimIds: { type: "array", items: { type: "string" } },
        limitationClaimIds: { type: "array", items: { type: "string" } },
      },
    },
    screenshotIntents: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["stepIndex", "claimIds", "reason"], properties: { stepIndex: { type: "integer" },
        claimIds: { type: "array", items: { type: "string" } }, reason: { type: "string" } } } },
  },
} as const;
