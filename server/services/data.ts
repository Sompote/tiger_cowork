import fs from "fs/promises";
import path from "path";

const DATA_DIR = path.resolve("data");

// Per-file promise-chain mutex: serializes reads-for-update and writes so
// concurrent writers can't interleave or clobber each other's updates.
const fileLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(file) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(
    () => {},
    () => {}
  );
  fileLocks.set(file, tail);
  // Drop the entry once idle so the map doesn't hold settled promises forever.
  tail.then(() => {
    if (fileLocks.get(file) === tail) fileLocks.delete(file);
  });
  return next;
}

function defaultFor(file: string): any {
  return file.endsWith("settings.json") ? {} : [];
}

async function readJSONUnlocked(file: string): Promise<any> {
  const fp = path.join(DATA_DIR, file);
  let content: string;
  try {
    content = await fs.readFile(fp, "utf-8");
  } catch {
    // Missing file (or unreadable) — start from the default.
    return defaultFor(file);
  }
  try {
    return JSON.parse(content);
  } catch (err) {
    // Corrupt store: preserve it for manual recovery instead of letting the
    // next save silently overwrite it with the default.
    const backup = `${fp}.corrupt-${Date.now()}`;
    console.error(`[data] ${file} is corrupt, moving to ${backup}:`, err);
    try {
      await fs.rename(fp, backup);
    } catch {}
    return defaultFor(file);
  }
}

async function readJSON(file: string): Promise<any> {
  return withFileLock(file, () => readJSONUnlocked(file));
}

async function writeJSONUnlocked(file: string, data: any): Promise<void> {
  const fp = path.join(DATA_DIR, file);
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, fp);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {}
    throw err;
  }
}

async function writeJSON(file: string, data: any): Promise<void> {
  return withFileLock(file, () => writeJSONUnlocked(file, data));
}

// Read-modify-write under the file lock so concurrent updaters can't drop
// each other's changes. The mutator receives fresh state and returns the
// state to persist.
async function updateJSON<T>(file: string, mutator: (current: T) => T | Promise<T>): Promise<T> {
  return withFileLock(file, async () => {
    const current = (await readJSONUnlocked(file)) as T;
    const updated = await mutator(current);
    await writeJSONUnlocked(file, updated);
    return updated;
  });
}

// Chat history
export interface ChatMessageFeedback {
  rating?: "up" | "down";
  comment?: string;
  submittedAt?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Array<{ role: string; content: string; timestamp: string; files?: string[]; feedback?: ChatMessageFeedback }>;
  createdAt: string;
  updatedAt: string;
}

export async function getChatHistory(): Promise<ChatSession[]> {
  return readJSON("chat_history.json");
}

export async function saveChatHistory(sessions: ChatSession[]): Promise<void> {
  await writeJSON("chat_history.json", sessions);
}

// Atomic read-modify-write for chat history. Prefer this over
// getChatHistory()+saveChatHistory() when the caller may run concurrently
// with other writers (route handlers, late bus results) — a stale snapshot
// saved wholesale silently drops the other writer's messages.
export async function updateChatHistory(
  mutator: (sessions: ChatSession[]) => ChatSession[] | Promise<ChatSession[]>
): Promise<ChatSession[]> {
  return updateJSON("chat_history.json", mutator);
}

// Tasks (cron)
export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  command: string;
  enabled: boolean;
  lastRun?: string;
  lastResult?: string;
  createdAt: string;
}

export async function getTasks(): Promise<ScheduledTask[]> {
  return readJSON("tasks.json");
}

export async function saveTasks(tasks: ScheduledTask[]): Promise<void> {
  await writeJSON("tasks.json", tasks);
}

// Settings
export interface Settings {
  sandboxDir: string;
  tigerBotApiKey: string;
  tigerBotModel: string;
  tigerBotApiUrl?: string;
  mcpTools: Array<{ name: string; url: string; enabled: boolean; type?: string; headers?: Record<string, string> }>;
  webSearchEnabled: boolean;
  webSearchApiKey?: string;
  webSearchEngine?: string;
  pythonPath?: string;
  subAgentEnabled?: boolean;
  subAgentMode?: string; // "auto" | "auto_create" | "manual" | "realtime" | "auto_swarm"
  subAgentModel?: string;
  subAgentMaxDepth?: number;
  subAgentMaxConcurrent?: number;
  subAgentTimeout?: number;
  subAgentConfigFile?: string;
  remoteEnabled?: boolean; // master toggle – when false, remote token auth and remote UI are disabled
  remoteAgentConfig?: string; // YAML config file for incoming remote tasks ("" = simple chat)
  remoteSystemPrompt?: string; // hidden system prompt prepended to incoming remote tasks — instructs how the remote agent answers, invisible to the caller
  remoteTaskMaxRetries?: number; // max re-delegations on subAgentTimeout for realtime remote tasks (default 2 → up to 3 total attempts)
  remoteInstances?: Array<{ id: string; name: string; url: string; token: string }>;
  remoteToken?: string;  // this machine's token for incoming remote connections (separate from accessToken)
  // Skill auto-update loop (cloned conceptually from hermes-agent's cron-driven skill_manage)
  skillAutoUpdateEnabled?: boolean;
  skillAutoUpdateIntervalMinutes?: number;
  skillAutoUpdateMaxCandidates?: number;
  skillAutoUpdateRequireApproval?: boolean;
  skillAutoUpdateLastRunAt?: string;
  skillAutoUpdateLastRunSummary?: string;
  skillAutoUpdateCursor?: string; // ISO ts of newest session processed last run
  skillAutoUpdateHumanFeedbackEnabled?: boolean; // when on, chat UI shows thumb up/down + comment per assistant message; feedback is fed into the synthesiser prompt
  [key: string]: any;
}

// Per-project settings overrides using AsyncLocalStorage for proper async scoping
import { AsyncLocalStorage } from "async_hooks";
const _settingsOverrideStore = new AsyncLocalStorage<Partial<Settings>>();

export function runWithSettingsOverride<T>(overrides: Partial<Settings>, fn: () => T): T {
  return _settingsOverrideStore.run(overrides, fn);
}

export async function getSettings(): Promise<Settings> {
  const settings = await readJSON("settings.json") as Settings;
  const overrides = _settingsOverrideStore.getStore();
  if (overrides) {
    return { ...settings, ...overrides };
  }
  return settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeJSON("settings.json", settings);
}

// Atomic read-modify-write for settings. The mutator sees the raw on-disk
// settings (no AsyncLocalStorage overrides baked in) so long-running callers
// don't revert user edits made while they were working.
export async function updateSettings(
  mutator: (settings: Settings) => Settings | Promise<Settings>
): Promise<Settings> {
  return updateJSON("settings.json", mutator);
}

// Projects
export interface Project {
  id: string;
  name: string;
  description: string;
  workingFolder: string;
  memory: string;
  skills: string[];
  // Per-project agent overrides (if set, override system settings)
  agentOverride?: {
    enabled?: boolean;
    subAgentMode?: string;
    subAgentConfigFile?: string;
    autoArchitectureType?: string;
    autoAgentCount?: number | string;
    autoProtocols?: string[];
  };
  createdAt: string;
  updatedAt: string;
}

export async function getProjects(): Promise<Project[]> {
  return readJSON("projects.json");
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await writeJSON("projects.json", projects);
}

// File Access Tokens
export interface FileToken {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

export async function getFileTokens(): Promise<FileToken[]> {
  return readJSON("file_tokens.json");
}

export async function saveFileTokens(tokens: FileToken[]): Promise<void> {
  await writeJSON("file_tokens.json", tokens);
}

export function generateToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 48; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

export async function isValidFileToken(token: string): Promise<boolean> {
  const tokens = await getFileTokens();
  return tokens.some((t) => t.token === token);
}

// Skills
export interface Skill {
  id: string;
  name: string;
  description: string;
  source: "claude" | "openclaw" | "custom" | "clawhub" | "auto";
  script: string;
  enabled: boolean;
  installedAt: string;
  // Auto-generated skills only:
  reviewStatus?: "pending" | "approved" | "rejected";
  autoMeta?: {
    kind: "create" | "update";
    basedOn: string[];     // chat session IDs
    generatedAt: string;
    model: string;
    proposedPath?: string; // SKILL.md.proposed for updates pending approval
    rationale?: string;
  };
}

export async function getSkills(): Promise<Skill[]> {
  return readJSON("skills.json");
}

export async function saveSkills(skills: Skill[]): Promise<void> {
  await writeJSON("skills.json", skills);
}

// Agent History (JSONL-based, per-session folder)
const AGENT_HISTORY_DIR = path.join(DATA_DIR, "agent_history");

export async function ensureAgentHistoryDir(sessionId: string): Promise<string> {
  const dir = path.join(AGENT_HISTORY_DIR, sessionId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function appendAgentHistory(sessionId: string, file: string, entry: any): Promise<void> {
  const dir = await ensureAgentHistoryDir(sessionId);
  const fp = path.join(dir, file);
  await fs.appendFile(fp, JSON.stringify(entry) + "\n");
}

export async function readAgentHistory(sessionId: string, file: string): Promise<any[]> {
  const fp = path.join(AGENT_HISTORY_DIR, sessionId, file);
  try {
    const content = await fs.readFile(fp, "utf-8");
    return content
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export async function deleteAgentHistory(sessionId: string): Promise<void> {
  const dir = path.join(AGENT_HISTORY_DIR, sessionId);
  await fs.rm(dir, { recursive: true, force: true });
}

export async function flushAgentHistory(_sessionId: string): Promise<void> {
  // JSONL is append-per-call, no buffering needed. Reserved for future batching.
}

// Checkpoint directory for tool loop recovery
const CHECKPOINT_DIR = path.join(DATA_DIR, "checkpoints");

export async function getCheckpointDir(): Promise<string> {
  await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
  return CHECKPOINT_DIR;
}
