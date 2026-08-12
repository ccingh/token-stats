#!/usr/bin/env node
import { scanAll } from "./scanner/index.js";

const clientsArg = process.argv.find((a) => a.startsWith("--clients="));
const clients = clientsArg
  ? clientsArg
      .slice("--clients=".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : undefined;

const result = await scanAll({ clients });
process.stdout.write(JSON.stringify(result));
