/**
 * 会话对话正文：按需从各工具本地日志/库读取（仅桌面、不同步）。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { agentPaths } from "./paths.js";
import { toIso } from "./types.js";

const MAX_MESSAGES = 800;
const MAX_PART_CHARS = 48_000;
const MAX_TOTAL_CHARS = 900_000;
/** Grok compact 后 chat_history 只剩窗口；完整正文在 compaction/segment_*.md */
const GROK_COMPACT_MAX_MESSAGES = 4_000;
const GROK_COMPACT_MAX_TOTAL_CHARS = 3_500_000;
const GROK_COMPACT_TOOL_CHARS = 12_000;

/**
 * @param {unknown} v
 * @param {number} [max]
 */
function clipText(v, max = MAX_PART_CHARS) {
  if (v == null) return "";
  const s = typeof v === "string" ? v : safeJson(v);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…（已截断 ${s.length - max} 字）`;
}

/**
 * @param {unknown} v
 */
function safeJson(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * @param {unknown} v
 */
function contentToString(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((p) => {
        if (p == null) return "";
        if (typeof p === "string") return p;
        if (typeof p === "object") {
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
          if (p.type === "text" && p.text) return String(p.text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    return safeJson(v);
  }
  return String(v);
}

/**
 * @param {{ type: string, text?: string, toolName?: string, toolId?: string, input?: string, output?: string, collapsedByDefault?: boolean }} part
 */
function part(partIn) {
  return {
    type: partIn.type,
    text: partIn.text != null ? clipText(partIn.text) : undefined,
    toolName: partIn.toolName,
    toolId: partIn.toolId,
    input: partIn.input != null ? clipText(partIn.input) : undefined,
    output: partIn.output != null ? clipText(partIn.output) : undefined,
    collapsedByDefault: partIn.collapsedByDefault !== false,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.role
 * @param {number} opts.index
 * @param {any[]} opts.parts
 * @param {string} [opts.ts]
 * @param {string} [opts.model]
 * @param {string} [opts.id]
 * @param {boolean} [opts.isSubagent]
 * @param {string} [opts.agentName]
 * @param {string} [opts.sourceSessionId]
 */
function msg(opts) {
  return {
    id: opts.id,
    index: opts.index,
    role: opts.role,
    ts: opts.ts,
    model: opts.model,
    parts: opts.parts || [],
    isSubagent: opts.isSubagent || undefined,
    agentName: opts.agentName,
    sourceSessionId: opts.sourceSessionId,
  };
}

/**
 * @param {any[]} messages
 * @param {{ client: string, sessionId: string, title?: string, note?: string }} meta
 * @param {{ maxMessages?: number, maxTotalChars?: number }} [limits]
 */
function finalize(messages, meta, limits = {}) {
  const maxMessages = limits.maxMessages || MAX_MESSAGES;
  const maxTotalChars = limits.maxTotalChars || MAX_TOTAL_CHARS;
  let total = 0;
  let truncated = false;
  /** @type {any[]} */
  const out = [];
  for (const m of messages) {
    if (out.length >= maxMessages) {
      truncated = true;
      break;
    }
    let size = 0;
    for (const p of m.parts || []) {
      size += (p.text || "").length + (p.input || "").length + (p.output || "").length;
    }
    if (total + size > maxTotalChars && out.length > 0) {
      truncated = true;
      break;
    }
    total += size;
    out.push({ ...m, index: out.length + 1 });
  }
  return {
    client: meta.client,
    sessionId: meta.sessionId,
    title: meta.title,
    messages: out,
    truncated: truncated || undefined,
    note: meta.note,
    messageCount: out.length,
  };
}

/**
 * Grok compact 归档：compaction/segment_NNN.md 的 Verbatim turns
 * @param {string} sessionDir
 * @param {string} sessionId
 * @returns {{ messages: any[], segmentCount: number, turnCount: number }}
 */
function loadGrokCompactionSegments(sessionDir, sessionId) {
  const cdir = path.join(sessionDir, "compaction");
  /** @type {any[]} */
  const messages = [];
  if (!fs.existsSync(cdir)) return { messages, segmentCount: 0, turnCount: 0 };

  let files;
  try {
    files = fs
      .readdirSync(cdir)
      .filter((n) => /^segment_\d+\.md$/i.test(n))
      .sort((a, b) => {
        const na = Number(a.match(/(\d+)/)?.[1] || 0);
        const nb = Number(b.match(/(\d+)/)?.[1] || 0);
        return na - nb;
      });
  } catch {
    return { messages, segmentCount: 0, turnCount: 0 };
  }

  let turnCount = 0;
  for (const file of files) {
    const segIdx = file.match(/(\d+)/)?.[1] || "?";
    let raw;
    try {
      raw = fs.readFileSync(path.join(cdir, file), "utf8");
    } catch {
      continue;
    }

    // 只取 Verbatim turns 之后；若无标记则全文扫
    const verIdx = raw.search(/^## Verbatim turns\s*$/m);
    const body = verIdx >= 0 ? raw.slice(verIdx) : raw;

    // 按 ### Turn N (Role) 切开
    const chunks = body.split(/^### Turn /m);
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const head = chunk.match(
        /^(\d+)\s+\((Human|Assistant|Function|System)\)\s*\r?\n([\s\S]*)$/i
      );
      if (!head) continue;
      const roleRaw = head[2];
      let content = (head[3] || "").trim();
      if (!content) continue;
      turnCount += 1;

      if (/^System$/i.test(roleRaw)) continue;

      // 注入 / 续聊摘要：不当成用户对话
      if (/^Human$/i.test(roleRaw)) {
        const t = content.trim();
        if (
          t.startsWith("<user_info>") ||
          t.startsWith("<system-reminder>") ||
          t.includes("This session is being continued from a previous conversation") ||
          t.includes("The following skills are available") ||
          t.includes("MCP servers connected") ||
          (t.includes("<user_info>") && !t.includes("<user_query>") && !t.includes("<user_query"))
        ) {
          continue;
        }
        const m = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
        if (m) content = m[1].trim();
        if (!content) continue;
        messages.push(
          msg({
            index: messages.length + 1,
            role: "user",
            parts: [
              part({ type: "text", text: content, collapsedByDefault: false }),
            ],
            agentName: `历史·seg${segIdx}`,
            sourceSessionId: sessionId,
          })
        );
        continue;
      }

      if (/^Function$/i.test(roleRaw)) {
        // 工具结果：强截断，默认折叠
        messages.push(
          msg({
            index: messages.length + 1,
            role: "tool",
            parts: [
              part({
                type: "tool_result",
                toolName: "function",
                output: clipText(content, GROK_COMPACT_TOOL_CHARS),
                collapsedByDefault: true,
              }),
            ],
            agentName: `历史·seg${segIdx}`,
            sourceSessionId: sessionId,
          })
        );
        continue;
      }

      // Assistant
      messages.push(
        msg({
          index: messages.length + 1,
          role: "assistant",
          parts: [
            part({ type: "text", text: content, collapsedByDefault: false }),
          ],
          agentName: `历史·seg${segIdx}`,
          sourceSessionId: sessionId,
        })
      );
    }
  }

  return { messages, segmentCount: files.length, turnCount };
}

function openDb(dbPath) {
  try {
    return new DatabaseSync(`file:${dbPath}?mode=ro&immutable=1`, {
      readOnly: true,
    });
  } catch {
    try {
      return new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      return null;
    }
  }
}

/**
 * OpenCode / ZCode 共用：message + part 表
 * @param {string} client
 * @param {string} dbPath
 * @param {string} sessionId
 */
function transcriptFromPartsDb(client, dbPath, sessionId) {
  if (!fs.existsSync(dbPath)) return null;
  const db = openDb(dbPath);
  if (!db) return null;

  try {
    let title;
    try {
      const meta = db
        .prepare(`SELECT title FROM session WHERE id = ?`)
        .get(sessionId);
      title = meta?.title || undefined;
    } catch {
      /* ignore */
    }

    /** @type {any[]} */
    let msgRows = [];
    try {
      msgRows = db
        .prepare(
          `SELECT id, data, time_created FROM message
           WHERE session_id = ?
           ORDER BY time_created ASC`
        )
        .all(sessionId);
    } catch {
      return null;
    }

    /** @type {Map<string, any[]>} */
    const partsByMsg = new Map();
    try {
      const partRows = db
        .prepare(
          `SELECT id, message_id, data, time_created FROM part
           WHERE session_id = ?
           ORDER BY time_created ASC`
        )
        .all(sessionId);
      for (const pr of partRows) {
        const mid = String(pr.message_id);
        if (!partsByMsg.has(mid)) partsByMsg.set(mid, []);
        partsByMsg.get(mid).push(pr);
      }
    } catch {
      /* no part table */
    }

    /** @type {any[]} */
    const messages = [];
    for (const row of msgRows) {
      let data;
      try {
        data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
      } catch {
        continue;
      }
      if (!data || typeof data !== "object") continue;
      const roleRaw = String(data.role || "assistant").toLowerCase();
      const role =
        roleRaw === "user" || roleRaw === "system" || roleRaw === "tool"
          ? roleRaw
          : "assistant";
      const model =
        data.modelID ||
        data.modelId ||
        (data.model && typeof data.model === "object"
          ? data.model.modelID || data.model.modelId
          : data.model) ||
        undefined;

      /** @type {any[]} */
      const parts = [];
      const partRows = partsByMsg.get(String(row.id)) || [];
      for (const pr of partRows) {
        let pd;
        try {
          pd = typeof pr.data === "string" ? JSON.parse(pr.data) : pr.data;
        } catch {
          continue;
        }
        if (!pd || typeof pd !== "object") continue;
        const t = String(pd.type || "");
        if (t === "step-start" || t === "step-finish") continue;
        if (t === "text") {
          if (pd.text) parts.push(part({ type: "text", text: String(pd.text), collapsedByDefault: false }));
        } else if (t === "reasoning" || t === "thinking") {
          if (pd.text) {
            parts.push(
              part({
                type: "thinking",
                text: String(pd.text),
                collapsedByDefault: true,
              })
            );
          }
        } else if (t === "tool") {
          const st = pd.state && typeof pd.state === "object" ? pd.state : {};
          const input = st.input != null ? st.input : pd.input;
          let output = st.output != null ? st.output : pd.output;
          if (output == null && st.error != null) output = st.error;
          if (output == null && st.metadata != null) {
            // some tools only leave metadata
          }
          if (typeof output === "object" && output !== null) {
            if (typeof output.output === "string") output = output.output;
            else if (typeof output.content === "string") output = output.content;
            else output = safeJson(output);
          }
          parts.push(
            part({
              type: "tool_call",
              toolName: String(pd.tool || pd.name || "tool"),
              toolId: pd.callID || pd.callId || pd.id || undefined,
              input: input != null ? (typeof input === "string" ? input : safeJson(input)) : undefined,
              output: output != null ? String(output) : undefined,
              collapsedByDefault: true,
            })
          );
        } else if (t === "file") {
          const label =
            pd.filename ||
            pd.source?.path ||
            pd.url ||
            pd.path ||
            "file";
          parts.push(
            part({
              type: "other",
              text: `📎 ${label}${pd.mime ? ` (${pd.mime})` : ""}`,
              collapsedByDefault: false,
            })
          );
        } else if (t === "patch") {
          const files = Array.isArray(pd.files) ? pd.files.join("\n") : "";
          parts.push(
            part({
              type: "other",
              text: `📝 patch${files ? "\n" + files : ""}`,
              collapsedByDefault: true,
            })
          );
        } else if (pd.text) {
          parts.push(
            part({
              type: "other",
              text: `[${t}] ${String(pd.text)}`,
              collapsedByDefault: true,
            })
          );
        }
      }

      // 无 part 时尽量从 data 取一点信息
      if (parts.length === 0) {
        if (typeof data.content === "string" && data.content.trim()) {
          parts.push(part({ type: "text", text: data.content, collapsedByDefault: false }));
        } else if (data.error) {
          parts.push(
            part({
              type: "other",
              text: `错误：${typeof data.error === "string" ? data.error : safeJson(data.error)}`,
              collapsedByDefault: false,
            })
          );
        } else {
          // 空 assistant 骨架（仅有 tokens）跳过
          continue;
        }
      }

      messages.push(
        msg({
          id: String(row.id),
          index: messages.length + 1,
          role,
          ts: toIso(data.time?.created || row.time_created),
          model: model ? String(model) : undefined,
          parts,
          sourceSessionId: sessionId,
        })
      );
    }

    return finalize(messages, {
      client,
      sessionId,
      title,
      note: messages.length
        ? undefined
        : "该会话在本地库中未找到可读正文（可能只有用量记录）。",
    });
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} sessionId
 */
async function claudeTranscript(sessionId) {
  const root = agentPaths().claudeProjects;
  if (!fs.existsSync(root)) return null;

  /** @type {string | null} */
  let targetFile = null;
  const walk = (d) => {
    if (targetFile) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (
        ent.isFile() &&
        ent.name.endsWith(".jsonl") &&
        path.basename(full, ".jsonl") === sessionId
      ) {
        targetFile = full;
        return;
      }
    }
  };
  walk(root);
  if (!targetFile) return null;

  /** @type {any[]} */
  const messages = [];
  const stream = fs.createReadStream(targetFile, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const type = obj.type;
    // system local_command
    if (type === "system" && obj.content) {
      messages.push(
        msg({
          index: messages.length + 1,
          role: "system",
          ts: toIso(obj.timestamp),
          parts: [
            part({
              type: "text",
              text: contentToString(obj.content),
              collapsedByDefault: true,
            }),
          ],
          sourceSessionId: sessionId,
        })
      );
      continue;
    }

    if (type !== "user" && type !== "assistant") continue;
    const m = obj.message || {};
    const role =
      m.role === "user" || m.role === "assistant" || m.role === "system"
        ? m.role
        : type;
    const content = m.content;
    /** @type {any[]} */
    const parts = [];

    if (typeof content === "string") {
      if (content.trim()) {
        parts.push(part({ type: "text", text: content, collapsedByDefault: false }));
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const bt = String(block.type || "");
        if (bt === "text") {
          if (block.text) {
            parts.push(
              part({ type: "text", text: String(block.text), collapsedByDefault: false })
            );
          }
        } else if (bt === "thinking" || bt === "redacted_thinking") {
          const t = block.thinking || block.text || "";
          if (t) {
            parts.push(
              part({ type: "thinking", text: String(t), collapsedByDefault: true })
            );
          }
        } else if (bt === "tool_use") {
          parts.push(
            part({
              type: "tool_call",
              toolName: String(block.name || "tool"),
              toolId: block.id,
              input:
                block.input != null
                  ? typeof block.input === "string"
                    ? block.input
                    : safeJson(block.input)
                  : undefined,
              collapsedByDefault: true,
            })
          );
        } else if (bt === "tool_result") {
          parts.push(
            part({
              type: "tool_result",
              toolName: block.name ? String(block.name) : undefined,
              toolId: block.tool_use_id || block.toolUseId,
              output: contentToString(block.content ?? block.output ?? block),
              collapsedByDefault: true,
            })
          );
        } else if (bt === "image") {
          parts.push(
            part({ type: "other", text: "🖼️ [图片]", collapsedByDefault: false })
          );
        } else if (block.text) {
          parts.push(
            part({
              type: "other",
              text: `[${bt}] ${String(block.text)}`,
              collapsedByDefault: true,
            })
          );
        }
      }
    }

    // skip empty meta noise
    if (parts.length === 0) continue;
    // skip pure isMeta caveats that are empty-ish — still show if has content
    if (obj.isMeta && parts.every((p) => !p.text && !p.input && !p.output)) continue;

    messages.push(
      msg({
        id: obj.uuid,
        index: messages.length + 1,
        role,
        ts: toIso(obj.timestamp),
        model: m.model || obj.model || undefined,
        parts,
        sourceSessionId: sessionId,
      })
    );
  }

  return finalize(messages, {
    client: "claude",
    sessionId,
    note: messages.length ? undefined : "未在 Claude 会话日志中解析到对话正文。",
  });
}

/**
 * @param {string} sessionId
 */
function reasonixTranscript(sessionId) {
  const dir = agentPaths().reasonixSessions;
  if (!fs.existsSync(dir)) return null;

  // sessionId 可能是文件名（含/不含 .jsonl）或 basename
  const candidates = [
    path.join(dir, `${sessionId}.jsonl`),
    path.join(dir, sessionId),
    path.join(dir, sessionId.endsWith(".jsonl") ? sessionId : `${sessionId}.jsonl`),
  ];
  let file = candidates.find((f) => fs.existsSync(f));
  if (!file) {
    // 模糊：文件名包含 id
    try {
      const entries = fs.readdirSync(dir);
      const hit = entries.find(
        (n) =>
          n.endsWith(".jsonl") &&
          (n === `${sessionId}.jsonl` ||
            n.startsWith(sessionId) ||
            path.basename(n, ".jsonl") === sessionId)
      );
      if (hit) file = path.join(dir, hit);
    } catch {
      /* ignore */
    }
  }
  if (!file) return null;

  /** @type {any[]} */
  const messages = [];
  let title;
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    const roleRaw = String(o.role || "").toLowerCase();
    if (!roleRaw) continue;

    /** @type {any[]} */
    const parts = [];

    if (roleRaw === "assistant" && o.reasoning_content) {
      parts.push(
        part({
          type: "thinking",
          text: String(o.reasoning_content),
          collapsedByDefault: true,
        })
      );
    }

    if (roleRaw === "tool") {
      parts.push(
        part({
          type: "tool_result",
          toolName: o.name ? String(o.name) : undefined,
          toolId: o.tool_call_id || o.toolCallId,
          output: contentToString(o.content),
          collapsedByDefault: true,
        })
      );
    } else if (typeof o.content === "string" && o.content.trim()) {
      parts.push(part({ type: "text", text: o.content, collapsedByDefault: false }));
      if (roleRaw === "user" && !title) {
        title = o.content.length > 80 ? `${o.content.slice(0, 80)}…` : o.content;
      }
    } else if (Array.isArray(o.content)) {
      const t = contentToString(o.content);
      if (t) parts.push(part({ type: "text", text: t, collapsedByDefault: false }));
    }

    if (Array.isArray(o.tool_calls)) {
      for (const tc of o.tool_calls) {
        const fn = tc.function || tc;
        let args = fn.arguments ?? fn.input ?? tc.arguments;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            /* keep string */
          }
        }
        parts.push(
          part({
            type: "tool_call",
            toolName: String(fn.name || tc.name || "tool"),
            toolId: tc.id,
            input:
              args != null
                ? typeof args === "string"
                  ? args
                  : safeJson(args)
                : undefined,
            collapsedByDefault: true,
          })
        );
      }
    }

    if (parts.length === 0) continue;
    const role =
      roleRaw === "user" || roleRaw === "system" || roleRaw === "tool"
        ? roleRaw
        : "assistant";
    messages.push(
      msg({
        index: messages.length + 1,
        role,
        model: o.model || undefined,
        parts,
        sourceSessionId: sessionId,
      })
    );
  }

  return finalize(messages, {
    client: "reasonix",
    sessionId,
    title,
    note: messages.length ? undefined : "Reasonix 会话文件中无消息。",
  });
}

/**
 * @param {string} sessionId
 */
function grokTranscript(sessionId) {
  const root = agentPaths().grokSessions;
  if (!fs.existsSync(root)) return null;

  const findDir = (d, depth = 0) => {
    if (depth > 8) return null;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === sessionId) return path.join(d, e.name);
      const hit = findDir(path.join(d, e.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  const dir = findDir(root);
  if (!dir) return null;

  const historyPath = path.join(dir, "chat_history.jsonl");
  const hasHistory = fs.existsSync(historyPath);

  let title;
  try {
    const sp = path.join(dir, "summary.json");
    if (fs.existsSync(sp)) {
      const s = JSON.parse(fs.readFileSync(sp, "utf8"));
      title = s.generated_title || s.session_summary || undefined;
    }
  } catch {
    /* ignore */
  }

  // 1) compact 前完整正文（segment 归档）
  const compact = loadGrokCompactionSegments(dir, sessionId);
  /** @type {any[]} */
  const messages = [...compact.messages];

  // 分隔：当前 chat_history 窗口
  if (compact.messages.length > 0 && hasHistory) {
    messages.push(
      msg({
        index: messages.length + 1,
        role: "system",
        parts: [
          part({
            type: "other",
            text: `—— 以上为 compact 归档（${compact.segmentCount} 段）· 以下为当前 chat_history 窗口 ——`,
            collapsedByDefault: false,
          }),
        ],
        sourceSessionId: sessionId,
      })
    );
  }

  // 2) 当前窗口 chat_history（compact 后 Grok 会截断此文件）
  if (hasHistory) {
    const raw = fs.readFileSync(historyPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!o || typeof o !== "object") continue;
      const type = String(o.type || "").toLowerCase();

      if (type === "system") continue;

      if (type === "reasoning") {
        const summary = Array.isArray(o.summary)
          ? o.summary.map((x) => x?.text || "").filter(Boolean).join("\n")
          : contentToString(o.summary || o.content);
        if (!summary) continue;
        messages.push(
          msg({
            id: o.id,
            index: messages.length + 1,
            role: "reasoning",
            parts: [
              part({ type: "thinking", text: summary, collapsedByDefault: true }),
            ],
            sourceSessionId: sessionId,
          })
        );
        continue;
      }

      if (type === "tool_result") {
        messages.push(
          msg({
            index: messages.length + 1,
            role: "tool",
            parts: [
              part({
                type: "tool_result",
                toolId: o.tool_call_id,
                output: contentToString(o.content),
                collapsedByDefault: true,
              }),
            ],
            sourceSessionId: sessionId,
          })
        );
        continue;
      }

      if (type === "user" || type === "assistant") {
        /** @type {any[]} */
        const parts = [];
        const text = contentToString(o.content);

        if (type === "user") {
          const t = text.trim();
          // compaction_meta / system_reminder 注入
          if (
            o.synthetic_reason === "compaction_meta" ||
            o.synthetic_reason === "system_reminder"
          ) {
            // 续聊摘要：若已有 segment 归档则跳过；无归档时折叠展示摘要
            if (compact.messages.length > 0) continue;
            if (t.includes("This session is being continued")) {
              messages.push(
                msg({
                  index: messages.length + 1,
                  role: "system",
                  parts: [
                    part({
                      type: "other",
                      text: clipText(t, 4000),
                      collapsedByDefault: true,
                    }),
                  ],
                  sourceSessionId: sessionId,
                })
              );
              continue;
            }
            continue;
          }
          const isInject =
            o.synthetic_reason ||
            t.startsWith("<user_info>") ||
            t.startsWith("<system-reminder>") ||
            t.includes("The following skills are available") ||
            t.includes("MCP servers connected") ||
            t.includes("Available Skills") ||
            (t.includes("<user_info>") && !t.includes("<user_query>"));
          if (isInject && !t.includes("<user_query>")) continue;
        }

        let display = text;
        const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
        if (m) display = m[1].trim();
        if (display && display.trim()) {
          parts.push(
            part({ type: "text", text: display, collapsedByDefault: false })
          );
        }
        if (Array.isArray(o.tool_calls)) {
          for (const tc of o.tool_calls) {
            let args = tc.arguments ?? tc.input;
            if (typeof args === "string") {
              try {
                args = JSON.parse(args);
              } catch {
                /* keep */
              }
            }
            parts.push(
              part({
                type: "tool_call",
                toolName: String(tc.name || "tool"),
                toolId: tc.id,
                input:
                  args != null
                    ? typeof args === "string"
                      ? args
                      : safeJson(args)
                    : undefined,
                collapsedByDefault: true,
              })
            );
          }
        }
        if (parts.length === 0) continue;
        messages.push(
          msg({
            index: messages.length + 1,
            role: type,
            model: o.model_id || o.model || undefined,
            parts,
            sourceSessionId: sessionId,
          })
        );
      }
    }
  }

  if (!hasHistory && compact.messages.length === 0) {
    return finalize([], {
      client: "grok",
      sessionId,
      title,
      note: "未找到 chat_history.jsonl 与 compaction 归档。",
    });
  }

  const noteParts = [];
  if (compact.segmentCount > 0) {
    noteParts.push(
      `已合并 Grok compact 归档 ${compact.segmentCount} 段（约 ${compact.turnCount} turns）+ 当前 chat_history 窗口`
    );
  }
  if (messages.length === 0) {
    noteParts.push("未解析到可展示的对话正文。");
  }

  return finalize(
    messages,
    {
      client: "grok",
      sessionId,
      title,
      note: noteParts.length ? noteParts.join("。") : undefined,
    },
    compact.segmentCount > 0
      ? {
          maxMessages: GROK_COMPACT_MAX_MESSAGES,
          maxTotalChars: GROK_COMPACT_MAX_TOTAL_CHARS,
        }
      : undefined
  );
}

/**
 * @param {string} sessionId
 */
async function kimiTranscript(sessionId) {
  const root = agentPaths().kimiRoot;
  if (!fs.existsSync(root)) return null;

  // reuse index discovery similar to adapter
  const indexPath = path.join(root, "session_index.jsonl");
  /** @type {{ sessionId: string, sessionDir: string }[]} */
  const items = [];
  if (fs.existsSync(indexPath)) {
    for (const line of fs.readFileSync(indexPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.sessionId && o.sessionDir) {
          items.push({ sessionId: o.sessionId, sessionDir: o.sessionDir });
        }
      } catch {
        /* ignore */
      }
    }
  }
  const item =
    items.find((x) => x.sessionId === sessionId) ||
    items.find(
      (x) =>
        x.sessionId.replace(/^session_/, "") ===
        sessionId.replace(/^session_/, "")
    );
  if (!item || !fs.existsSync(item.sessionDir)) {
    return finalize([], {
      client: "kimi",
      sessionId,
      note: "未找到 Kimi 会话目录。",
    });
  }

  // 优先 transcript / messages 类文件
  const candidates = [
    path.join(item.sessionDir, "chat.jsonl"),
    path.join(item.sessionDir, "messages.jsonl"),
    path.join(item.sessionDir, "transcript.jsonl"),
    path.join(item.sessionDir, "agents", "main", "messages.jsonl"),
  ];
  let file = candidates.find((f) => fs.existsSync(f));
  if (!file) {
    // 扫 wire：尝试解析含 role/content 的行
    const wire = path.join(item.sessionDir, "agents", "main", "wire.jsonl");
    if (fs.existsSync(wire)) file = wire;
  }
  if (!file) {
    return finalize([], {
      client: "kimi",
      sessionId,
      note: "Kimi 会话未找到可读对话文件（当前仅有用量 wire）。",
    });
  }

  /** @type {any[]} */
  const messages = [];
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    // wire 事件风格
    if (o.type && !o.role) {
      if (o.type === "message" || o.type === "chat.message") {
        o = o.message || o.data || o;
      } else if (
        o.type === "assistant.message" ||
        o.type === "user.message"
      ) {
        // fall through with content
      } else {
        continue;
      }
    }
    const roleRaw = String(o.role || o.type || "").toLowerCase();
    if (!roleRaw.includes("user") && !roleRaw.includes("assistant") && roleRaw !== "tool") {
      if (!(o.content || o.text || o.tool_calls)) continue;
    }
    const role = roleRaw.includes("user")
      ? "user"
      : roleRaw.includes("tool")
        ? "tool"
        : "assistant";
    /** @type {any[]} */
    const parts = [];
    const text = contentToString(o.content ?? o.text);
    if (text) parts.push(part({ type: "text", text, collapsedByDefault: false }));
    if (Array.isArray(o.tool_calls)) {
      for (const tc of o.tool_calls) {
        parts.push(
          part({
            type: "tool_call",
            toolName: String(tc.name || tc.function?.name || "tool"),
            toolId: tc.id,
            input: safeJson(tc.arguments || tc.function?.arguments || tc.input || {}),
            collapsedByDefault: true,
          })
        );
      }
    }
    if (parts.length === 0) continue;
    messages.push(
      msg({
        index: messages.length + 1,
        role,
        ts: toIso(o.time || o.timestamp),
        parts,
        sourceSessionId: sessionId,
      })
    );
  }

  return finalize(messages, {
    client: "kimi",
    sessionId,
    note: messages.length
      ? undefined
      : "Kimi 日志中未解析到对话正文（可能仅有 usage 事件）。",
  });
}

/**
 * @param {string} sessionId
 */
async function piTranscript(sessionId) {
  const root = agentPaths().piSessions;
  if (!fs.existsSync(root)) return null;

  /** @type {string | null} */
  let target = null;
  const walk = (d, depth = 0) => {
    if (target || depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (
        e.isFile() &&
        (e.name === `${sessionId}.jsonl` ||
          e.name.includes(sessionId) ||
          path.basename(full, path.extname(full)) === sessionId)
      ) {
        target = full;
        return;
      }
    }
  };
  walk(root);
  if (!target) return null;

  /** @type {any[]} */
  const messages = [];
  const stream = fs.createReadStream(target, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o.message || o;
    const roleRaw = String(m.role || "").toLowerCase();
    if (!roleRaw) continue;
    const role =
      roleRaw === "user" || roleRaw === "system" || roleRaw === "tool"
        ? roleRaw
        : "assistant";
    /** @type {any[]} */
    const parts = [];
    const text = contentToString(m.content);
    if (text) parts.push(part({ type: "text", text, collapsedByDefault: false }));
    if (Array.isArray(m.tool_calls) || Array.isArray(m.toolCalls)) {
      for (const tc of m.tool_calls || m.toolCalls) {
        parts.push(
          part({
            type: "tool_call",
            toolName: String(tc.name || tc.function?.name || "tool"),
            toolId: tc.id,
            input: safeJson(tc.arguments || tc.function?.arguments || tc.input || {}),
            collapsedByDefault: true,
          })
        );
      }
    }
    if (parts.length === 0) continue;
    messages.push(
      msg({
        index: messages.length + 1,
        role,
        ts: toIso(o.timestamp || m.timestamp),
        model: m.model || o.model,
        parts,
        sourceSessionId: sessionId,
      })
    );
  }

  return finalize(messages, {
    client: "pi",
    sessionId,
    note: messages.length ? undefined : "Pi 会话文件中未解析到对话正文。",
  });
}

/**
 * @param {{ client: string, sessionId: string, mergedChildren?: string[] }} opts
 */
export async function getSessionTranscript(opts) {
  const client = String(opts.client || "").toLowerCase();
  const sessionId = String(opts.sessionId || "");
  if (!client || !sessionId) throw new Error("缺少 client 或 sessionId");

  /** @type {any} */
  let result = null;

  switch (client) {
    case "claude":
      result = await claudeTranscript(sessionId);
      break;
    case "opencode":
      result = transcriptFromPartsDb(
        "opencode",
        agentPaths().opencodeDb,
        sessionId
      );
      break;
    case "zcode":
      result = transcriptFromPartsDb("zcode", agentPaths().zcodeDb, sessionId);
      break;
    case "mimocode":
      result = transcriptFromPartsDb(
        "mimocode",
        agentPaths().mimocodeDb,
        sessionId
      );
      break;
    case "reasonix":
      result = reasonixTranscript(sessionId);
      break;
    case "grok":
      result = grokTranscript(sessionId);
      break;
    case "kimi":
      result = await kimiTranscript(sessionId);
      break;
    case "pi":
      result = await piTranscript(sessionId);
      break;
    default:
      return {
        client,
        sessionId,
        messages: [],
        unsupported: true,
        note: `客户端 ${client} 暂不支持对话预览。`,
      };
  }

  if (!result) {
    return {
      client,
      sessionId,
      messages: [],
      note: "未找到本地对话源（文件已删或路径不匹配）。",
    };
  }

  // 可选：并入子会话对话（OpenCode/ZCode/Claude 等），标注 sub
  const children = Array.isArray(opts.mergedChildren)
    ? opts.mergedChildren.map(String).filter(Boolean)
    : [];
  if (children.length && result.messages) {
    for (const childId of children.slice(0, 20)) {
      if (childId === sessionId) continue;
      /** @type {any} */
      let child = null;
      try {
        if (client === "opencode") {
          child = transcriptFromPartsDb(
            "opencode",
            agentPaths().opencodeDb,
            childId
          );
        } else if (client === "zcode") {
          child = transcriptFromPartsDb("zcode", agentPaths().zcodeDb, childId);
        } else if (client === "mimocode") {
          child = transcriptFromPartsDb(
            "mimocode",
            agentPaths().mimocodeDb,
            childId
          );
        } else if (client === "claude") {
          child = await claudeTranscript(childId);
        } else if (client === "grok") {
          child = grokTranscript(childId);
        }
      } catch {
        child = null;
      }
      if (!child?.messages?.length) continue;
      for (const m of child.messages) {
        result.messages.push({
          ...m,
          isSubagent: true,
          agentName: m.agentName || childId.slice(0, 12),
          sourceSessionId: childId,
        });
      }
    }
    // 按时间重排
    result.messages.sort((a, b) => {
      const ta = a.ts || "";
      const tb = b.ts || "";
      if (ta && tb && ta !== tb) return ta.localeCompare(tb);
      return (a.index || 0) - (b.index || 0);
    });
    result.messages.forEach((m, i) => {
      m.index = i + 1;
    });
    if (result.messages.length > MAX_MESSAGES) {
      result.messages = result.messages.slice(0, MAX_MESSAGES);
      result.truncated = true;
    }
  }

  return result;
}
