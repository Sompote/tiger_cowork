import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve("data");

function readJSON(file: string): any {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return file.endsWith("settings.json") ? {} : [];
  return JSON.parse(fs.readFileSync(fp, "utf-8"));
}

function writeJSON(file: string, data: any): void {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// Chat history
export interface ChatSession {
  id: string;
  title: string;
  messages: Array<{ role: string; content: string; timestamp: string; files?: string[] }>;
  createdAt: string;
  updatedAt: string;
}

export function getChatHistory(): ChatSession[] {
  return readJSON("chat_history.json");
}

export function saveChatHistory(sessions: ChatSession[]): void {
  writeJSON("chat_history.json", sessions);
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

export function getTasks(): ScheduledTask[] {
  return readJSON("tasks.json");
}

export function saveTasks(tasks: ScheduledTask[]): void {
  writeJSON("tasks.json", tasks);
}

// Settings
export interface Settings {
  sandboxDir: string;
  tigerBotApiKey: string;
  tigerBotModel: string;
  tigerBotApiUrl?: string;
  mcpTools: Array<{ name: string; url: string; enabled: boolean }>;
  webSearchEnabled: boolean;
  webSearchApiKey?: string;
  webSearchEngine?: string;
  pythonPath?: string;
  [key: string]: any;
}

export function getSettings(): Settings {
  return readJSON("settings.json");
}

export function saveSettings(settings: Settings): void {
  writeJSON("settings.json", settings);
}

// Skills
export interface Skill {
  id: string;
  name: string;
  description: string;
  source: "claude" | "openclaw" | "custom" | "clawhub";
  script: string;
  enabled: boolean;
  installedAt: string;
}

export function getSkills(): Skill[] {
  return readJSON("skills.json");
}

export function saveSkills(skills: Skill[]): void {
  writeJSON("skills.json", skills);
}
