import os from "node:os";
import path from "node:path";

export function homeDir() {
  return os.homedir();
}

export function agentPaths() {
  const home = homeDir();
  return {
    opencodeDb: path.join(home, ".local", "share", "opencode", "opencode.db"),
    claudeProjects: path.join(home, ".claude", "projects"),
    grokSessions: path.join(home, ".grok", "sessions"),
    grokUnifiedLog: path.join(home, ".grok", "logs", "unified.jsonl"),
    kimiRoot: path.join(home, ".kimi-code"),
    zcodeDb: path.join(home, ".zcode", "cli", "db", "db.sqlite"),
    // Pi agent stores under ~/.omp (Token Monitor / tokscale label: pi)
    piSessions: path.join(home, ".omp", "agent", "sessions"),
    reasonixSessions: path.join(home, ".reasonix", "sessions"),
    // 小米 MiMo Code：XDG data 或 $MIMOCODE_HOME/data
    mimocodeDb: process.env.MIMOCODE_HOME
      ? path.join(process.env.MIMOCODE_HOME, "data", "mimocode.db")
      : path.join(home, ".local", "share", "mimocode", "mimocode.db"),
    codexStateDb: path.join(home, ".codex", "state_5.sqlite"),
    cursorAiTracking: path.join(home, ".cursor", "ai-tracking", "ai-code-tracking.db"),
  };
}
