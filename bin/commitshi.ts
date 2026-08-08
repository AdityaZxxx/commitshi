#!/usr/bin/env bun
// Entry point for `bunx commitshi`. All behavior lives in src/main.ts; this
// shim only wires process.exitCode so partial stdout/stderr writes flush
// before the process exits.

import { main } from "../src/main.ts";

try {
  process.exitCode = await main();
} catch (error) {
  console.error("commitshi: error:", (error as Error).message);
  process.exitCode = 1;
}
