/**
 * `pnpm embeddings:smoke` — is this machine embedding for REAL, or writing hash noise? (#785)
 *
 * The one command a developer runs after setting up local embeddings — on Windows
 * (in-process under tsx, or against the Docker Desktop sidecar), macOS or Linux —
 * to find out whether the thing that just started up is a real model or the
 * deterministic stub. It loads the configured embedder, prints backend / model /
 * dims / pooling / dtype / cache, and then makes the embedder PROVE it has
 * semantics by separating a paraphrase from an off-topic sentence.
 *
 *   pnpm --filter @metis/server embeddings:smoke
 *   pnpm --filter @metis/server embeddings:smoke --json
 *
 * Exit code is the contract, so this can gate a setup script or CI:
 *   0 — real semantic embeddings
 *   1 — hash stub, a backend that failed to load, or a vector space that does
 *       not discriminate (see the printed verdict for which)
 *
 * All the logic lives in `src/lib/rag/embed-smoke.ts` (unit-tested); this file is
 * argv + stdout + exit code.
 */
import { isMainModule } from "../src/lib/main-module.js";
import { formatSmokeReport, exitCodeFor, runEmbedSmoke } from "../src/lib/rag/embed-smoke.js";

export async function main(
  argv: string[] = process.argv.slice(2),
  log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`),
): Promise<number> {
  const json = argv.includes("--json");
  const report = await runEmbedSmoke();
  log(json ? JSON.stringify(report, null, 2) : formatSmokeReport(report));
  return exitCodeFor(report.verdict);
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      // `process.exitCode`, NOT `process.exit()` — and this is load-bearing, not style.
      //
      // A successful run has just loaded an ONNX model, so onnxruntime-node holds a
      // live inference session on a native thread pool. `process.exit()` tears the
      // process down underneath it, and ORT aborts:
      //
      //   libc++abi: terminating due to uncaught exception of type
      //   std::__1::system_error: mutex lock failed: Invalid argument
      //
      // That abort lands as **SIGABRT / exit 134** — so the in-process backend, on
      // its happy path, printed "VERDICT: REAL" and then exited *non-zero*. The exit
      // code IS this tool's contract (it is meant to gate setup scripts and CI), and
      // it was reporting failure precisely when everything worked. Observed on
      // darwin/arm64 with gte-modernbert + onnxruntime-node 1.21.0.
      //
      // Setting `exitCode` lets Node drain and exit normally, which lets ORT release
      // its session first.
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // runEmbedSmoke() does not throw; anything landing here is a wiring failure
      // (a bad EMBED_DTYPE, an invalid HF_ENDPOINT — both of which fail loud by
      // design at config-resolution time). Surface it rather than exiting 0.
      process.stderr.write(
        `Embeddings smoke check could not run: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    });
}
