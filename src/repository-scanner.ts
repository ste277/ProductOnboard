import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const SOURCE_TYPES = {
  ".ts": "typescript",
  ".tsx": "typescript-react",
  ".js": "javascript",
  ".jsx": "javascript-react",
  ".json": "json",
} as const;

export type SourceExtension = keyof typeof SOURCE_TYPES;
export type SourceType = (typeof SOURCE_TYPES)[SourceExtension];

export interface RepositoryFile {
  path: string;
  extension: SourceExtension;
  type: SourceType;
  sizeBytes: number;
}

export interface RepositoryInventory {
  root: string;
  files: RepositoryFile[];
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

export async function scanRepository(
  repositoryPath: string,
): Promise<RepositoryInventory> {
  const root = path.resolve(repositoryPath);
  await validateRepositoryRoot(root);

  const files: RepositoryFile[] = [];
  await scanDirectory(root, root, files);
  files.sort((left, right) => compareText(left.path, right.path));

  return { root, files };
}

async function validateRepositoryRoot(root: string): Promise<void> {
  let metadata;

  try {
    metadata = await stat(root);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Repository path does not exist: ${root}`, { cause: error });
    }
    throw new Error(`Repository path is not readable: ${root}`, { cause: error });
  }

  if (!metadata.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${root}`);
  }
}

async function scanDirectory(
  root: string,
  directory: string,
  files: RepositoryFile[],
): Promise<void> {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read repository directory: ${directory}`, {
      cause: error,
    });
  }

  entries.sort((left, right) => compareText(left.name, right.name));

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await scanDirectory(root, absolutePath, files);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!isSourceExtension(extension)) {
      continue;
    }

    const metadata = await stat(absolutePath);
    files.push({
      path: path.relative(root, absolutePath).split(path.sep).join("/"),
      extension,
      type: SOURCE_TYPES[extension],
      sizeBytes: metadata.size,
    });
  }
}

function isSourceExtension(extension: string): extension is SourceExtension {
  return Object.hasOwn(SOURCE_TYPES, extension);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
