#!/usr/bin/env node

import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const projectRoot = resolve(process.argv[2] ?? process.cwd());
const codexRoot = resolve(process.argv[3] ?? join(process.env.USERPROFILE ?? "", ".codex"));
const outputRoot = join(projectRoot, "chat-exports");
const sourceRoots = [join(codexRoot, "sessions"), join(codexRoot, "archived_sessions")];

function normalizePath(value) {
  return resolve(String(value ?? "")).toLowerCase();
}

function safeName(value) {
  return String(value ?? "untitled")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .toLowerCase() || "untitled";
}

function redactSecrets(value) {
  return String(value)
    .replace(/\bgho_[a-zA-Z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[a-zA-Z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-[a-zA-Z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?)[^\s"']{12,}/gi, "$1[REDACTED]");
}

async function collectJsonlFiles(root) {
  if (!existsSync(root)) return [];
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await collectJsonlFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found;
}

function loadTitles() {
  const indexPath = join(codexRoot, "session_index.jsonl");
  const titles = new Map();
  if (!existsSync(indexPath)) return titles;
  for (const line of readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.id && item.thread_name) titles.set(item.id, item.thread_name);
    } catch {
      // Ignore a partially written index line.
    }
  }
  return titles;
}

async function readChat(path, titles) {
  let meta = null;
  const messages = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });

  for await (const line of lines) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }

    if (item.type === "session_meta") {
      meta = item.payload ?? null;
      continue;
    }
    if (item.type !== "event_msg") continue;

    const payload = item.payload ?? {};
    if (payload.type === "user_message" && typeof payload.message === "string") {
      messages.push({ timestamp: item.timestamp, role: "User", text: redactSecrets(payload.message) });
    } else if (payload.type === "agent_message" && typeof payload.message === "string") {
      const phase = payload.phase === "commentary" ? " (progress update)" : "";
      messages.push({ timestamp: item.timestamp, role: `Assistant${phase}`, text: redactSecrets(payload.message) });
    }
  }

  if (!meta || normalizePath(meta.cwd) !== normalizePath(projectRoot) || messages.length === 0) return null;
  const id = meta.session_id ?? meta.id ?? basename(path, ".jsonl");
  return {
    id,
    title: titles.get(id) ?? "Untitled Codex task",
    createdAt: meta.timestamp ?? messages[0]?.timestamp ?? null,
    cwd: meta.cwd,
    source: meta.originator ?? meta.source ?? "Codex",
    messages,
  };
}

function compactText(value, limit) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function renderCompactChat(chat) {
  const userMessages = chat.messages.filter((message) => message.role === "User");
  const assistantMessages = chat.messages.filter((message) => message.role.startsWith("Assistant"));
  const initialRequest = userMessages[0]?.text ?? "No user message captured.";
  const latestRequest = userMessages.at(-1)?.text ?? initialRequest;
  const latestOutcome = assistantMessages.at(-1)?.text ?? "No assistant outcome captured.";
  const latestRequestLine = latestRequest === initialRequest
    ? ""
    : `- Latest request/context: ${compactText(latestRequest, 700)}\n`;
  return [
    `## ${chat.title}`,
    "",
    `- Thread ID: \`${chat.id}\``,
    `- Created: ${chat.createdAt ?? "unknown"}`,
    `- Initial request: ${compactText(initialRequest, 700)}`,
    latestRequestLine.trimEnd(),
    `- Latest outcome/context: ${compactText(latestOutcome, 1200)}`,
    "",
  ].filter((line) => line !== "").join("\n");
}

const titles = loadTitles();
const files = (await Promise.all(sourceRoots.map(collectJsonlFiles))).flat();
const chatsById = new Map();

for (const file of files) {
  const chat = await readChat(file, titles);
  if (chat) chatsById.set(chat.id, chat);
}

if (existsSync(outputRoot)) rmSync(outputRoot, { recursive: true });
mkdirSync(outputRoot, { recursive: true });

const chats = [...chatsById.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
const index = [
  "# Codex continuation context",
  "",
  "## Primary project goal",
  "",
  "Add daily roster, depth-chart, injury, transaction, practice, usage, and news signals.",
  "",
  "Build separate position models instead of applying one broadly similar forecasting recipe.",
  "",
  "Correct point-scale calibration by position and player tier.",
  "",
  "Add legally usable market information such as ADP or licensed projection inputs where available.",
  "",
  "Backtest chronologically against actual results and benchmark against every provider.",
  "",
  "Keep all new models in shadow mode until they clear the worst-provider threshold.",
  "",
  "**Bring pure Draft Goblin up to at least the worst major provider’s standard before treating it as a serious projection source.**",
  "",
  "Canonical goal: [PROJECT_GOAL.md](../PROJECT_GOAL.md)",
  "",
  "## Prior task summaries",
  "",
  "Compact summaries of local Codex tasks associated with this repository. System instructions, hidden reasoning, credentials, and tool logs are excluded.",
  "",
  `Summarized tasks: ${chats.length}`,
  "",
];

for (const chat of chats) {
  index.push(renderCompactChat(chat));
}

writeFileSync(join(outputRoot, "README.md"), `${index.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ scannedSessionFiles: files.length, summarizedChats: chats.length, outputRoot }, null, 2));
