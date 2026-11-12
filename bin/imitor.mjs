#!/usr/bin/env node
import { main } from "../src/cli.mjs";
import { scrubForRoot } from "../src/secrets.mjs";
main(process.argv.slice(2)).catch((error) => {
  console.error(`imitor: ${scrubForRoot(process.cwd(), String(error.message))}`);
  process.exit(1);
});
