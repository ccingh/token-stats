#!/usr/bin/env node
import { scanAll } from "./scanner/index.js";

const result = await scanAll();
const summary = {
  scannedAt: result.scannedAt,
  durationMs: result.durationMs,
  reports: result.reports,
  totals: result.totals,
  sessionCount: result.sessions.length,
  top: result.sessions.slice(0, 15).map((s) => ({
    client: s.client,
    title: s.title,
    model: s.model,
    input: s.inputTokens,
    output: s.outputTokens,
    cacheRead: s.cacheReadTokens,
    reasoning: s.reasoningTokens,
    total: s.totalTokens,
    quality: s.quality,
  })),
};
console.log(JSON.stringify(summary, null, 2));
