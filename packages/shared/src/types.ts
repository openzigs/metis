/**
 * @metis/shared — type aggregation barrel.
 *
 * UI imports types from here (NOT from `@prisma/client`) so the UI bundle
 * stays free of Prisma's runtime.
 */
export * from "./user.js";
export * from "./project.js";
export * from "./analysis.js";
export * from "./publishing.js";
export * from "./vault.js";
export * from "./platform.js";
export * from "./common.js";
