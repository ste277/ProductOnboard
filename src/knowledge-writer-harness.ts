import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildKnowledgeWriterInput,
  formatKnowledgeBaseArticle,
  generateKnowledgeBaseArticleFromPackage,
  type KnowledgeBaseArticle,
  type KnowledgeEvidencePackage,
  type KnowledgeWriter,
} from "./knowledge-base-generator.js";
import { mapKnowledgeStepsToScreenshots, type ScreenshotStepMapping } from "./screenshot-step-mapping.js";
import type { RuntimeNavigationDiscoveryGraph } from "./runtime-discovery.js";

export interface RunKnowledgeWriterHarnessInput {
  evidencePackage: KnowledgeEvidencePackage;
  writer: KnowledgeWriter;
  outputDirectory: string;
  generatedAt?: string;
  runtimeDiscovery?: RuntimeNavigationDiscoveryGraph;
  qualityComparison?: unknown;
}

export interface KnowledgeWriterHarnessResult {
  article: KnowledgeBaseArticle;
  screenshotMapping?: ScreenshotStepMapping;
  outputDirectory: string;
  artifactPaths: string[];
}

export async function runKnowledgeWriterHarness(
  input: RunKnowledgeWriterHarnessInput,
): Promise<KnowledgeWriterHarnessResult> {
  const writerInput = buildKnowledgeWriterInput(input.evidencePackage);
  const article = await generateKnowledgeBaseArticleFromPackage({
    evidencePackage: input.evidencePackage,
    writer: input.writer,
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
  });
  const screenshotMapping = input.runtimeDiscovery ? mapKnowledgeStepsToScreenshots({
    article,
    evidencePackage: input.evidencePackage,
    runtimeDiscovery: input.runtimeDiscovery,
  }) : undefined;
  await mkdir(input.outputDirectory, { recursive: true });
  const artifacts: Array<[string, unknown | string]> = [
    ["writer-request-summary.json", {
      evidencePackageId: input.evidencePackage.id,
      featureId: input.evidencePackage.feature.id,
      objectiveClaimCount: writerInput.claims.length,
      screenshotCount: writerInput.screenshots.length,
      limitationCount: writerInput.limitations.length,
      provider: article.metadata.writerProvider,
      model: article.metadata.writerModel,
    }],
    ["claim-selection.json", article.claimSelection ?? null],
    ["article-plan.json", article.articlePlan ?? null],
    ["article.json", article],
    ["article.md", formatKnowledgeBaseArticle(article)],
    ["grounding-validation.json", article.grounding],
  ];
  if (screenshotMapping) artifacts.push(["screenshot-mapping.json", screenshotMapping]);
  if (input.qualityComparison !== undefined) artifacts.push(["quality-comparison.json", input.qualityComparison]);
  const artifactPaths: string[] = [];
  for (const [name, value] of artifacts) {
    const path = join(input.outputDirectory, name);
    await writeFile(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
    artifactPaths.push(path);
  }
  return { article, ...(screenshotMapping ? { screenshotMapping } : {}), outputDirectory: input.outputDirectory, artifactPaths };
}
