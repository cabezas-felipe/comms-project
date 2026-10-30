#!/usr/bin/env node
/**
 * @deprecated Use post-pricing-catalog-review.mjs with CATALOG=model.
 * Thin wrapper for older docs / local habits.
 */
process.env.CATALOG = "model";
await import("./post-pricing-catalog-review.mjs");
