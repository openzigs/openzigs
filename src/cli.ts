#!/usr/bin/env node

import { runSetup } from "./cli/setup.js";

const [, , command] = process.argv;

const run = async () => {
  if (command === "setup") {
    await runSetup();
    return;
  }

  console.error("Usage: openzigs setup");
  process.exitCode = 1;
};

void run();
