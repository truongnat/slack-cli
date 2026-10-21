#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
