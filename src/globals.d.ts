/**
 * Build-time constants injected by scripts/build.mjs via esbuild `define`.
 * In development (tsx) the identifier does not exist, so every use site must
 * go through a `typeof` check.
 */
declare const __AGENT_BUILD_COMMIT__: string | undefined
