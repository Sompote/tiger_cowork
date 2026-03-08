const BASE = "/api";

async function request(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return res.json();
}

export const api = {
  // Chat
  getSessions: () => request("/chat/sessions"),
  getSession: (id: string) => request(`/chat/sessions/${id}`),
  createSession: (title?: string) => request("/chat/sessions", { method: "POST", body: JSON.stringify({ title }) }),
  deleteSession: (id: string) => request(`/chat/sessions/${id}`, { method: "DELETE" }),
  renameSession: (id: string, title: string) => request(`/chat/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),

  // Files
  listFiles: (path?: string) => request(`/files?path=${encodeURIComponent(path || "")}`),
  readFile: (path: string) => request(`/files/read?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string) => request("/files/write", { method: "POST", body: JSON.stringify({ path, content }) }),
  deleteFile: (path: string) => request(`/files?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
  mkdir: (path: string) => request("/files/mkdir", { method: "POST", body: JSON.stringify({ path }) }),
  previewFile: (path: string) => request(`/files/preview?path=${encodeURIComponent(path)}`),
  downloadUrl: (path: string) => `/api/files/download?path=${encodeURIComponent(path)}`,
  uploadFile: async (file: File, destPath: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("path", destPath);
    const res = await fetch(`${BASE}/files/upload`, { method: "POST", body: form });
    return res.json();
  },

  // Python
  runPython: (code: string) => request("/python/run", { method: "POST", body: JSON.stringify({ code }) }),

  // Tasks
  getTasks: () => request("/tasks"),
  createTask: (data: any) => request("/tasks", { method: "POST", body: JSON.stringify(data) }),
  updateTask: (id: string, data: any) => request(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteTask: (id: string) => request(`/tasks/${id}`, { method: "DELETE" }),

  // Skills
  getSkills: () => request("/skills"),
  getSkillCatalog: () => request("/skills/catalog"),
  installSkill: (data: any) => request("/skills", { method: "POST", body: JSON.stringify(data) }),
  uploadSkill: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${BASE}/skills/upload`, { method: "POST", body: form });
    return res.json();
  },
  updateSkill: (id: string, data: any) => request(`/skills/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteSkill: (id: string) => request(`/skills/${id}`, { method: "DELETE" }),

  // Clawhub
  clawhubSearch: (query: string, limit = 10) => request(`/clawhub/search?q=${encodeURIComponent(query)}&limit=${limit}`),
  clawhubInstall: (slug: string, force = false) => request("/clawhub/install", { method: "POST", body: JSON.stringify({ slug, force }) }),
  clawhubInfo: (slug: string) => request(`/clawhub/info/${encodeURIComponent(slug)}`),
  clawhubSkills: () => request("/clawhub/skills"),

  // Chat file upload
  chatUpload: async (files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    const res = await fetch(`${BASE}/files/chat-upload`, { method: "POST", body: form });
    return res.json();
  },

  // Settings
  getSettings: () => request("/settings"),
  saveSettings: (data: any) => request("/settings", { method: "PUT", body: JSON.stringify(data) }),
  testConnection: (data: any) => request("/settings/test-connection", { method: "POST", body: JSON.stringify(data) }),

  // Tools
  webSearch: (query: string) => request("/tools/web-search", { method: "POST", body: JSON.stringify({ query }) }),

  // MCP
  mcpStatus: () => request("/settings/mcp/status"),
  mcpConnect: (name: string, url: string) => request("/settings/mcp/connect", { method: "POST", body: JSON.stringify({ name, url }) }),
  mcpDisconnect: (name: string) => request("/settings/mcp/disconnect", { method: "POST", body: JSON.stringify({ name }) }),
  mcpReconnectAll: () => request("/settings/mcp/reconnect-all", { method: "POST" }),
};
