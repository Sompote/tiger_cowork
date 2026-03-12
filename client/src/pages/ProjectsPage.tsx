import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, sandboxUrl } from "../utils/api";
import { useSocket } from "../hooks/useSocket";
import { Icon } from "../components/Layout";
import ReactComponentRenderer from "../components/ReactComponentRenderer";
import "./ProjectsPage.css";

interface Project {
  id: string;
  name: string;
  description: string;
  workingFolder: string;
  memory: string;
  skills: string[];
  createdAt: string;
  updatedAt: string;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  source: string;
  enabled: boolean;
}

interface FileEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  path: string;
}

interface Message {
  role: string;
  content: string;
  timestamp: string;
  files?: string[];
}

interface Session {
  id: string;
  title: string;
  messageCount?: number;
  createdAt: string;
  updatedAt: string;
}

function getFileExt(name: string): string {
  return (name.split(".").pop() || "").toLowerCase();
}

function DocPreview({ file }: { file: string }) {
  const [html, setHtml] = useState<string>("");
  const [info, setInfo] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    setLoading(true);
    setError("");
    api.previewFile(file).then((data: any) => {
      if (data.error) {
        setError(data.error);
      } else {
        setHtml(data.html || "");
        if (data.pages) setInfo(`${data.pages} page${data.pages > 1 ? "s" : ""}`);
      }
      setLoading(false);
    }).catch((err: any) => {
      setError(err.message || "Failed to load preview");
      setLoading(false);
    });
  }, [file]);

  if (loading) return <div className="doc-preview-loading">Loading preview...</div>;
  if (error) return <div className="doc-preview-error">Preview unavailable: {error}</div>;

  return (
    <div className="doc-preview-content">
      {info && <div className="doc-preview-info">{info}</div>}
      <div className="doc-preview-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function OutputCanvas({ files }: { files: string[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const images = files.filter((f) => ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(getFileExt(f)));
  const reactFiles = files.filter((f) => f.endsWith(".jsx.js"));
  const htmlFiles = files.filter((f) => getFileExt(f) === "html" && !f.endsWith(".jsx.js"));
  const pdfFiles = files.filter((f) => getFileExt(f) === "pdf");
  const docFiles = files.filter((f) => ["doc", "docx"].includes(getFileExt(f)));
  const otherFiles = files.filter((f) => !images.includes(f) && !reactFiles.includes(f) && !htmlFiles.includes(f) && !pdfFiles.includes(f) && !docFiles.includes(f));

  return (
    <div className="output-canvas">
      {images.length > 0 && (
        <div className="canvas-images">
          {images.map((f) => (
            <div key={f} className="canvas-image-wrap">
              <img
                src={sandboxUrl(f, true)}
                alt={f}
                className={`canvas-image ${expanded === f ? "expanded" : ""}`}
                onClick={() => setExpanded(expanded === f ? null : f)}
              />
              <div className="canvas-image-toolbar">
                <span className="canvas-image-name">{f.split("/").pop()}</span>
                <a href={api.downloadUrl(f)} download className="canvas-dl-btn" title="Download">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                </a>
              </div>
            </div>
          ))}
        </div>
      )}

      {reactFiles.map((f) => (
        <div key={f} className="canvas-react-wrap">
          <div className="canvas-html-header">
            <span>{f.split("/").pop()?.replace(".jsx.js", "")}</span>
            <a href={api.downloadUrl(f)} download className="canvas-dl-btn" title="Download source">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            </a>
          </div>
          <div className="canvas-react-body">
            <ReactComponentRenderer src={sandboxUrl(f, true)} />
          </div>
        </div>
      ))}

      {htmlFiles.map((f) => (
        <div key={f} className="canvas-html-wrap">
          <div className="canvas-html-header">
            <span>{f.split("/").pop()}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <a href={sandboxUrl(f)} target="_blank" rel="noreferrer" className="canvas-dl-btn" title="Open in new tab">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
              </a>
              <a href={api.downloadUrl(f)} download className="canvas-dl-btn" title="Download">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              </a>
            </div>
          </div>
          <iframe src={sandboxUrl(f, true)} className="canvas-html-iframe" title={f} />
        </div>
      ))}

      {pdfFiles.map((f) => (
        <div key={f} className="canvas-doc-wrap">
          <div className="canvas-doc-header">
            <div className="canvas-doc-icon pdf">PDF</div>
            <span>{f.split("/").pop()}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <a href={sandboxUrl(f)} target="_blank" rel="noreferrer" className="canvas-dl-btn" title="Open">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
              </a>
              <a href={api.downloadUrl(f)} download className="canvas-dl-btn" title="Download">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              </a>
            </div>
          </div>
          <DocPreview file={f} />
        </div>
      ))}

      {docFiles.map((f) => (
        <div key={f} className="canvas-doc-wrap">
          <div className="canvas-doc-header">
            <div className="canvas-doc-icon doc">DOC</div>
            <span>{f.split("/").pop()}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <a href={api.downloadUrl(f)} download className="canvas-dl-btn" title="Download">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              </a>
            </div>
          </div>
          <DocPreview file={f} />
        </div>
      ))}

      {otherFiles.length > 0 && (
        <div className="canvas-other-files">
          {otherFiles.map((f) => (
            <a key={f} href={api.downloadUrl(f)} className="file-chip" download>
              <span className="file-chip-icon">{getFileExt(f).toUpperCase() || "FILE"}</span>
              {f.split("/").pop()}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Project Chat ─── */
function ProjectChat({ project, allSkills }: { project: Project; allSkills: Skill[] }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [outputPanelOpen, setOutputPanelOpen] = useState(true);
  const [mobileSessions, setMobileSessions] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { connected, sendProjectMessage, onChunk, onResponse, onStatus } = useSocket();

  // Collect all output files from messages for the right panel
  const allOutputFiles = messages.reduce<{ files: string[]; msgIndex: number }[]>((acc, msg, i) => {
    if (msg.files && msg.files.length > 0) {
      acc.push({ files: msg.files, msgIndex: i });
    }
    return acc;
  }, []);

  // Load sessions that belong to this project (prefixed with [ProjectName])
  useEffect(() => {
    api.getSessions().then((all: Session[]) => {
      const prefix = `[${project.name}]`;
      const projectSessions = all.filter((s) => s.title.startsWith(prefix));
      setSessions(projectSessions);
    });
  }, [project.id, project.name]);

  useEffect(() => {
    if (activeSession) {
      api.getSession(activeSession).then((session: any) => {
        setMessages(session.messages || []);
      });
    }
  }, [activeSession]);

  const toolLabels: Record<string, string> = {
    web_search: "Searching the web", fetch_url: "Fetching URL", run_python: "Running Python",
    run_react: "Running React", run_shell: "Running command", read_file: "Reading file",
    write_file: "Writing file", list_files: "Listing files", list_skills: "Listing skills",
    load_skill: "Loading skill", clawhub_search: "Searching ClawHub", clawhub_install: "Installing skill",
  };

  // Restore in-progress state on mount, reconnect, or session switch
  useEffect(() => {
    if (!activeSession) return;
    let cancelled = false;

    const checkActiveTasks = () => {
      api.getActiveTasks().then((tasks: any[]) => {
        if (cancelled) return;
        const activeTask = tasks.find((t: any) => t.sessionId === activeSession);
        if (activeTask) {
          setIsLoading(true);
          if (activeTask.status.startsWith("Running:")) {
            const tool = activeTask.status.replace("Running: ", "");
            const label = toolLabels[tool] || tool;
            setStatus(`${label}...`);
          } else if (activeTask.status.includes("done, thinking")) {
            setStatus(activeTask.status);
          } else {
            setStatus("Thinking...");
          }
        }
      }).catch(() => {});
    };

    checkActiveTasks();
    const interval = setInterval(() => {
      if (!cancelled) checkActiveTasks();
    }, 5000);

    return () => { cancelled = true; clearInterval(interval); };
  }, [activeSession, connected]);

  useEffect(() => {
    const unsub1 = onChunk((data) => {
      if (data.sessionId === activeSession) {
        setStreaming((prev) => prev + data.content);
      }
    });
    const unsub2 = onResponse((data) => {
      if (data.sessionId === activeSession) {
        api.getSession(activeSession).then((session: any) => {
          setMessages(session.messages || []);
        });
        setStreaming("");
        setIsLoading(false);
        setStatus("");
      }
    });
    const unsub3 = onStatus((data: any) => {
      if (data.sessionId && data.sessionId !== activeSession) return;

      if (data.status === "thinking") { setIsLoading(true); setStatus("Thinking..."); }
      else if (data.status === "tool_call") { setIsLoading(true); setStatus(`${toolLabels[data.tool] || data.tool}...`); }
      else if (data.status === "tool_result") setStatus(`${toolLabels[data.tool] || data.tool} done, thinking...`);
      else setStatus("");
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [activeSession, onChunk, onResponse, onStatus]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  const createNewSession = async () => {
    const session = await api.createSession(`[${project.name}] New chat`);
    setSessions((prev) => [session, ...prev]);
    setActiveSession(session.id);
    setMessages([]);
  };

  const handleSend = useCallback(() => {
    if (!input.trim() || isLoading) return;
    const msg = input.trim();
    const userMessage: Message = { role: "user", content: msg, timestamp: new Date().toISOString() };
    setInput("");

    if (!activeSession) {
      const title = `[${project.name}] ${msg.slice(0, 40)}`;
      api.createSession(title).then((session: any) => {
        setSessions((prev) => [session, ...prev]);
        setActiveSession(session.id);
        setMessages([userMessage]);
        setIsLoading(true);
        sendProjectMessage(project.id, session.id, msg);
      });
    } else {
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);
      sendProjectMessage(project.id, activeSession, msg);
    }
  }, [input, activeSession, isLoading, sendProjectMessage, project]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await api.deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeSession === id) { setActiveSession(null); setMessages([]); }
  };

  // Build context info for display
  const selectedSkillNames = allSkills.filter((s) => project.skills?.includes(s.id)).map((s) => s.name);

  return (
    <div className="project-chat">
      {/* Context banner */}
      <div className="project-chat-context">
        <div className="context-items">
          {project.memory && <span className="context-chip memory">Memory loaded</span>}
          {project.workingFolder && <span className="context-chip folder">{project.workingFolder.split("/").pop()}</span>}
          {selectedSkillNames.map((s) => <span key={s} className="context-chip skill">{s}</span>)}
        </div>
      </div>

      <div className="project-chat-body">
        {/* Mobile session toggle button */}
        <button className="mobile-sessions-toggle" onClick={() => setMobileSessions(true)}>
          <Icon name="chat" />
          <span>{activeSession ? sessions.find(s => s.id === activeSession)?.title?.replace(`[${project.name}] `, "") || "Chat" : "Sessions"}</span>
        </button>

        {/* Mobile backdrop */}
        <div className={`mobile-sessions-backdrop ${mobileSessions ? "visible" : ""}`} onClick={() => setMobileSessions(false)} />

        {/* Session sidebar */}
        <div className={`project-chat-sessions ${mobileSessions ? "mobile-open" : ""}`}>
          <button className="btn btn-primary btn-sm" onClick={createNewSession} style={{ width: "100%" }}>
            <Icon name="add" /> New Chat
          </button>
          <div className="project-session-list">
            {sessions.map((s) => (
              <div key={s.id} className={`session-item ${activeSession === s.id ? "active" : ""}`} onClick={() => { setActiveSession(s.id); setMobileSessions(false); }}>
                <span className="session-title">{s.title.replace(`[${project.name}] `, "")}</span>
                <button className="session-delete btn-icon btn-ghost" onClick={(e) => deleteSession(s.id, e)}>
                  <Icon name="close" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Chat area */}
        <div className="project-chat-main">
          {!activeSession && messages.length === 0 ? (
            <div className="project-chat-empty">
              <h3>Chat with {project.name}</h3>
              <p>The agent has access to your project memory, working folder, and selected skills.</p>
              <div className="project-chat-suggestions">
                {["What files are in the working folder?", "Summarize the project memory", "Help me with this project"].map((s) => (
                  <button key={s} className="suggestion-chip" onClick={() => { setInput(s); textareaRef.current?.focus(); }}>{s}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="project-chat-messages">
              {messages.map((msg, i) => (
                <div key={i} className={`message ${msg.role}`}>
                  <div className="message-avatar">{msg.role === "user" ? "U" : "C"}</div>
                  <div className="message-content">
                    {msg.role === "assistant" ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    ) : (
                      <p>{msg.content}</p>
                    )}
                    {msg.files && msg.files.length > 0 && (
                      <div className="message-output-indicator" onClick={() => setOutputPanelOpen(true)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
                        {msg.files.length} output{msg.files.length > 1 ? "s" : ""} — view in panel
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {streaming && (
                <div className="message assistant">
                  <div className="message-avatar">C</div>
                  <div className="message-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{streaming}</ReactMarkdown>
                  </div>
                </div>
              )}
              {status && <div className="chat-status">{status}</div>}
              <div ref={messagesEndRef} />
            </div>
          )}

          <div className="project-chat-input-area">
            <div className="project-chat-input-wrapper">
              <textarea
                ref={textareaRef}
                className="chat-input"
                placeholder={`Message ${project.name}...`}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={1}
                disabled={isLoading}
              />
              <button
                className={`send-btn ${input.trim() ? "active" : ""}`}
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </button>
            </div>
            <div className="project-chat-hint">
              {connected ? "Connected" : "Disconnected"} · Project context active · Enter to send
            </div>
          </div>
        </div>

        {/* Right-side Output Panel */}
        {allOutputFiles.length > 0 && outputPanelOpen && (
          <div className="output-panel">
            <div className="output-panel-header">
              <h3>Outputs</h3>
              <button className="btn-icon btn-ghost" onClick={() => setOutputPanelOpen(false)}>
                <Icon name="close" />
              </button>
            </div>
            <div className="output-panel-content">
              {allOutputFiles.map((group, gi) => (
                <OutputCanvas key={gi} files={group.files} />
              ))}
            </div>
          </div>
        )}

        {/* Toggle button when panel is closed but outputs exist */}
        {allOutputFiles.length > 0 && !outputPanelOpen && (
          <button className="output-panel-toggle" onClick={() => setOutputPanelOpen(true)} title="Show outputs">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
            <span className="output-toggle-badge">{allOutputFiles.reduce((n, g) => n + g.files.length, 0)}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Main ProjectsPage ─── */
export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<"chat" | "overview" | "memory" | "skills" | "files">("chat");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [sandboxDir, setSandboxDir] = useState("");
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryEditing, setMemoryEditing] = useState(false);
  const [allSkills, setAllSkills] = useState<Skill[]>([]);
  const [projectFiles, setProjectFiles] = useState<FileEntry[]>([]);
  const [filePath, setFilePath] = useState("");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editFolder, setEditFolder] = useState("");
  const [mobileSidebar, setMobileSidebar] = useState(false);

  useEffect(() => {
    api.getProjects().then(setProjects);
    api.getSkills().then(setAllSkills);
    api.getSettings().then((s: any) => setSandboxDir(s.sandboxDir || ""));
  }, []);

  useEffect(() => {
    if (activeProject) {
      // Fetch memory from file (memory.md in working folder) via API
      api.getProjectMemory(activeProject.id).then((data: any) => {
        setMemoryContent(data.content || "");
      }).catch(() => {
        setMemoryContent(activeProject.memory || "");
      });
      setMemoryDirty(false);
      setMemoryEditing(false);
      setFilePath("");
      loadFiles(activeProject, "");
    }
  }, [activeProject?.id]);

  const loadFiles = async (project: Project, subPath: string) => {
    if (!project.workingFolder) { setProjectFiles([]); return; }
    try {
      const data = await api.getProjectFiles(project.id, subPath);
      setProjectFiles(data.files || []);
    } catch { setProjectFiles([]); }
  };

  const createProject = async () => {
    if (!newName.trim()) return;
    const project = await api.createProject({
      name: newName.trim(),
      description: newDesc.trim(),
      workingFolder: newFolder.trim(),
    });
    setProjects((prev) => [...prev, project]);
    setActiveProject(project);
    setCreating(false);
    setNewName(""); setNewDesc(""); setNewFolder("");
  };

  const deleteProject = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this project?")) return;
    await api.deleteProject(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
    if (activeProject?.id === id) setActiveProject(null);
  };

  const saveMemory = async () => {
    if (!activeProject) return;
    setMemorySaving(true);
    await api.saveProjectMemory(activeProject.id, memoryContent);
    const updated = { ...activeProject, memory: memoryContent };
    setActiveProject(updated);
    setProjects((prev) => prev.map((p) => p.id === updated.id ? updated : p));
    setMemoryDirty(false);
    setMemorySaving(false);
    setMemoryEditing(false);
  };

  const toggleSkill = async (skillId: string) => {
    if (!activeProject) return;
    const current = activeProject.skills || [];
    const updated = current.includes(skillId) ? current.filter((s) => s !== skillId) : [...current, skillId];
    const project = await api.updateProject(activeProject.id, { skills: updated });
    setActiveProject(project);
    setProjects((prev) => prev.map((p) => p.id === project.id ? project : p));
  };

  const saveEdit = async () => {
    if (!activeProject) return;
    const project = await api.updateProject(activeProject.id, {
      name: editName.trim() || activeProject.name,
      description: editDesc.trim(),
      workingFolder: editFolder.trim(),
    });
    setActiveProject(project);
    setProjects((prev) => prev.map((p) => p.id === project.id ? project : p));
    setEditing(false);
  };

  const startEdit = () => {
    if (!activeProject) return;
    setEditName(activeProject.name);
    setEditDesc(activeProject.description);
    setEditFolder(activeProject.workingFolder);
    setEditing(true);
  };

  const navigateFile = (entry: FileEntry) => {
    if (!activeProject) return;
    if (entry.isDirectory) { setFilePath(entry.path); loadFiles(activeProject, entry.path); }
  };

  const navigateUp = () => {
    if (!activeProject) return;
    const parent = filePath.split("/").slice(0, -1).join("/");
    setFilePath(parent);
    loadFiles(activeProject, parent);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const TABS = [
    { key: "chat" as const, label: "Chat" },
    { key: "overview" as const, label: "Overview" },
    { key: "memory" as const, label: "Memory" },
    { key: "skills" as const, label: "Skills" },
    { key: "files" as const, label: "Files" },
  ];

  return (
    <div className="projects-page">
      <div className={`projects-sidebar-backdrop ${mobileSidebar ? "visible" : ""}`} onClick={() => setMobileSidebar(false)} />
      <div className={`projects-sidebar ${mobileSidebar ? "mobile-open" : ""}`}>
        <button className="btn btn-primary new-project-btn" onClick={() => setCreating(true)}>
          <Icon name="add" /> New Project
        </button>

        {creating && (
          <div className="project-create-form">
            <input
              placeholder="Project name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createProject()}
              autoFocus
            />
            <input
              placeholder="Description (optional)"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
            <div>
              <input
                placeholder="Folder name (optional, e.g. my-project)"
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
              />
              {sandboxDir && <span className="hint" style={{ fontSize: 10 }}>Path: {sandboxDir}/{newFolder || "..."}</span>}
            </div>
            <div className="project-create-actions">
              <button className="btn btn-primary btn-sm" onClick={createProject} disabled={!newName.trim()}>Create</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </div>
        )}

        <div className="project-list">
          {projects.map((p) => (
            <div
              key={p.id}
              className={`project-item ${activeProject?.id === p.id ? "active" : ""}`}
              onClick={() => { setActiveProject(p); setMobileSidebar(false); setEditing(false); setTab("chat"); }}
            >
              <div className="project-item-icon"><Icon name="project" /></div>
              <div className="project-item-info">
                <span className="project-item-name">{p.name}</span>
                {p.description && <span className="project-item-desc">{p.description}</span>}
              </div>
              <button className="project-delete btn-icon btn-ghost" onClick={(e) => deleteProject(p.id, e)}>
                <Icon name="close" />
              </button>
            </div>
          ))}
          {projects.length === 0 && !creating && (
            <div className="projects-empty">No projects yet</div>
          )}
        </div>
      </div>

      <div className="projects-main">
        <button className="mobile-projects-toggle" onClick={() => setMobileSidebar(true)}>
          <Icon name="project" />
          <span>{activeProject ? activeProject.name : "Projects"}</span>
        </button>

        {!activeProject ? (
          <div className="projects-welcome">
            <h1>Projects</h1>
            <p>Create a project to organize your work with a dedicated working folder, memory notes, and skill selection.</p>
            <button className="btn btn-primary" onClick={() => { setCreating(true); setMobileSidebar(true); }}>
              Create your first project
            </button>
          </div>
        ) : (
          <div className="project-detail">
            <div className="project-detail-header">
              <div className="project-detail-title">
                <h2>{activeProject.name}</h2>
                {activeProject.description && <p className="project-detail-desc">{activeProject.description}</p>}
              </div>
              <button className="btn btn-ghost btn-sm" onClick={startEdit}>Edit</button>
            </div>

            {editing && (
              <div className="project-edit-form card">
                <div className="form-group">
                  <label>Name</label>
                  <input value={editName} onChange={(e) => setEditName(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Description</label>
                  <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Working Folder</label>
                  <input value={editFolder} onChange={(e) => setEditFolder(e.target.value)} placeholder="Folder name (e.g. my-project)" />
                  {sandboxDir && <span className="hint" style={{ fontSize: 10 }}>Path: {sandboxDir}/{editFolder || "..."}</span>}
                </div>
                <div className="form-actions">
                  <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
                </div>
              </div>
            )}

            <div className="project-tabs">
              {TABS.map((t) => (
                <button key={t.key} className={`tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
                  {t.label}
                </button>
              ))}
            </div>

            <div className={`project-tab-content ${tab === "chat" ? "chat-tab-active" : ""}`}>
              {tab === "chat" && (
                <ProjectChat project={activeProject} allSkills={allSkills} />
              )}

              {tab === "overview" && (
                <div className="project-overview">
                  <div className="overview-cards">
                    <div className="overview-card" onClick={() => setTab("files")}>
                      <div className="overview-card-icon"><Icon name="folder" /></div>
                      <div className="overview-card-info">
                        <strong>Working Folder</strong>
                        <span>{activeProject.workingFolder || "Not set"}</span>
                      </div>
                    </div>
                    <div className="overview-card" onClick={() => setTab("memory")}>
                      <div className="overview-card-icon"><Icon name="chat" /></div>
                      <div className="overview-card-info">
                        <strong>Memory</strong>
                        <span>{activeProject.memory ? `${activeProject.memory.split("\n").length} lines` : "Empty"}</span>
                      </div>
                    </div>
                    <div className="overview-card" onClick={() => setTab("skills")}>
                      <div className="overview-card-icon"><Icon name="extension" /></div>
                      <div className="overview-card-info">
                        <strong>Skills</strong>
                        <span>{activeProject.skills?.length || 0} selected</span>
                      </div>
                    </div>
                  </div>
                  <div className="overview-meta">
                    <span>Created: {new Date(activeProject.createdAt).toLocaleDateString()}</span>
                    <span>Updated: {new Date(activeProject.updatedAt).toLocaleDateString()}</span>
                  </div>
                </div>
              )}

              {tab === "memory" && (
                <div className="project-memory">
                  <div className="memory-header">
                    <div>
                      <h3>Project Memory</h3>
                      <p className="hint">Record project characteristics, decisions, and notes. The agent reads this as context.</p>
                    </div>
                    <div className="memory-actions">
                      {memoryEditing ? (
                        <>
                          {memoryDirty && (
                            <button className="btn btn-primary btn-sm" onClick={saveMemory} disabled={memorySaving}>
                              {memorySaving ? "Saving..." : "Save"}
                            </button>
                          )}
                          <button className="btn btn-ghost btn-sm" onClick={() => { setMemoryContent(activeProject.memory || ""); setMemoryDirty(false); setMemoryEditing(false); }}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="btn btn-ghost btn-sm" onClick={() => setMemoryEditing(true)}>
                          Edit
                        </button>
                      )}
                    </div>
                  </div>
                  {memoryEditing ? (
                    <textarea
                      className="memory-editor"
                      value={memoryContent}
                      onChange={(e) => { setMemoryContent(e.target.value); setMemoryDirty(true); }}
                      placeholder={"# Project Memory\n\nRecord project info here...\n\n## Tech Stack\n- ...\n\n## Key Decisions\n- ...\n\n## Notes\n- ..."}
                      autoFocus
                    />
                  ) : (
                    <div className="memory-view">
                      {memoryContent ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{memoryContent}</ReactMarkdown>
                      ) : (
                        <div className="memory-empty">
                          <p>No memory recorded yet.</p>
                          <button className="btn btn-primary btn-sm" onClick={() => setMemoryEditing(true)}>Add Memory</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {tab === "skills" && (
                <div className="project-skills">
                  <h3>Select Skills for this Project</h3>
                  <p className="hint">Choose which skills are available when working in this project. These are prioritized during search.</p>
                  <div className="skill-select-list">
                    {allSkills.map((skill) => {
                      const selected = activeProject.skills?.includes(skill.id) || false;
                      return (
                        <div key={skill.id} className={`skill-select-item ${selected ? "selected" : ""}`} onClick={() => toggleSkill(skill.id)}>
                          <div className="skill-select-check">
                            {selected ? (
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--accent)">
                                <path d="M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
                              </svg>
                            ) : (
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--text-tertiary)">
                                <path d="M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                              </svg>
                            )}
                          </div>
                          <div className="skill-select-info">
                            <span className="skill-select-name">{skill.name}</span>
                            <span className="skill-select-desc">{skill.description}</span>
                          </div>
                          <span className={`source-badge ${skill.source}`}>{skill.source}</span>
                        </div>
                      );
                    })}
                    {allSkills.length === 0 && (
                      <div className="projects-empty">No skills installed. Go to Skills page to install some.</div>
                    )}
                  </div>
                </div>
              )}

              {tab === "files" && (
                <div className="project-files">
                  <div className="files-header">
                    <h3>Working Folder</h3>
                    {activeProject.workingFolder && <span className="hint">{activeProject.workingFolder}</span>}
                  </div>
                  {!activeProject.workingFolder ? (
                    <div className="projects-empty">
                      <p>No working folder set.</p>
                      <button className="btn btn-ghost btn-sm" onClick={startEdit}>Set working folder</button>
                    </div>
                  ) : (
                    <>
                      {filePath && (
                        <div className="files-breadcrumb">
                          <button className="btn btn-ghost btn-sm" onClick={navigateUp}>&larr; Back</button>
                          <span className="hint">/{filePath}</span>
                        </div>
                      )}
                      <div className="project-file-list">
                        {projectFiles.map((f) => (
                          <div key={f.path} className="project-file-item" onClick={() => navigateFile(f)}>
                            <span className="file-icon">{f.isDirectory ? "📁" : "📄"}</span>
                            <span className="file-name">{f.name}</span>
                            {!f.isDirectory && <span className="file-size">{formatSize(f.size)}</span>}
                          </div>
                        ))}
                        {projectFiles.length === 0 && <div className="projects-empty">Folder is empty</div>}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
