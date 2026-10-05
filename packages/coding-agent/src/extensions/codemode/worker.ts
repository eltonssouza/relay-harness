/**
 * Worker entry for the codemode sandbox in bundled builds. The Node bundle and the Bun binary
 * build this file as a separate entrypoint because relay-codemode's own worker file is not on disk
 * there; `getCodemodeWorkerSpecifier()` in config.ts resolves it.
 */
import "@relay-harness/codemode/worker";
