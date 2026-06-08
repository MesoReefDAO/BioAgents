import "dotenv/config";
import { VectorSearchWithDocuments } from "../src/embeddings/vectorSearchWithDocs";

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const docsPath = readArg("path") || process.env.KNOWLEDGE_DOCS_PATH || "docs";
  const force = hasFlag("force");
  const dryRun = hasFlag("dry-run");
  const extractBioprospecting = hasFlag("bioprospecting");
  const registerExisting = !hasFlag("no-register-existing");
  const ignorePatterns = (
    readArg("ignore") ||
    process.env.KNOWLEDGE_INGEST_IGNORE ||
    ""
  )
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);

  console.log("Starting Research Brain ingestion");
  console.log(
    JSON.stringify(
      {
        docsPath,
        force,
        dryRun,
        extractBioprospecting,
        registerExisting,
        ignorePatterns,
      },
      null,
      2,
    ),
  );

  const vectorSearch = new VectorSearchWithDocuments();
  if (dryRun) {
    const report = await vectorSearch.dryRunIngestDirectory(docsPath, {
      force,
      ignorePatterns: ignorePatterns.length > 0 ? ignorePatterns : undefined,
    });
    console.log("Dry run completed");
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const result = await vectorSearch.ingestDirectory(docsPath, {
    force,
    registerExisting,
    extractBioprospecting,
    ignorePatterns: ignorePatterns.length > 0 ? ignorePatterns : undefined,
  });

  console.log("Ingestion completed");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Ingestion failed");
  console.error(error);
  process.exit(1);
});
