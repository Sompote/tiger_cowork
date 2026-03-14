import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { api, sandboxUrl } from "../utils/api";
import { useSocket } from "../hooks/useSocket";
import { Icon } from "../components/Layout";
import ReactComponentRenderer from "../components/ReactComponentRenderer";
import "./ChatPage.css";

interface AttachedFile {
  name: string;
  path: string;
  size: number;
  type: string;
}

interface Message {
  role: string;
  content: string;
  timestamp: string;
  files?: string[];
  attachments?: AttachedFile[];
}

interface Session {
  id: string;
  title: string;
  messageCount?: number;
  createdAt: string;
  updatedAt: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["pdf"].includes(ext)) return "PDF";
  if (["doc", "docx"].includes(ext)) return "DOC";
  if (["xls", "xlsx", "csv"].includes(ext)) return "XLS";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "IMG";
  if (["py", "js", "ts", "html", "css", "json", "md", "yaml", "yml", "xml"].includes(ext)) return "TXT";
  if (["zip", "tar", "gz"].includes(ext)) return "ZIP";
  return "FILE";
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
      {/* Inline images (charts, plots) */}
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

      {/* Native React components (compiled JSX) */}
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

      {/* HTML reports in iframe */}
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

      {/* PDF preview with extracted text */}
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

      {/* Word document preview */}
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

      {/* Other files as download chips */}
      {otherFiles.length > 0 && (
        <div className="canvas-other-files">
          {otherFiles.map((f) => (
            <a key={f} href={api.downloadUrl(f)} className="file-chip" download>
              <span className="file-chip-icon">{getFileIcon(f)}</span>
              {f.split("/").pop()}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChatPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [outputPanelOpen, setOutputPanelOpen] = useState(true);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [activeTaskSessions, setActiveTaskSessions] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { connected, sendMessage, onChunk, onResponse, onStatus } = useSocket();

  // Collect all output files from messages for the right panel
  const allOutputFiles = messages.reduce<{ files: string[]; msgIndex: number }[]>((acc, msg, i) => {
    if (msg.files && msg.files.length > 0) {
      acc.push({ files: msg.files, msgIndex: i });
    }
    return acc;
  }, []);

  useEffect(() => {
    api.getSessions().then(setSessions);
  }, []);

  useEffect(() => {
    if (activeSession) {
      api.getSession(activeSession).then((session: any) => {
        setMessages(session.messages || []);
      });
    }
  }, [activeSession]);

  const toolLabels: Record<string, string> = {
    web_search: "Searching the web",
    fetch_url: "Fetching URL",
    run_python: "Running Python",
    run_react: "Running React",
    run_shell: "Running command",
    read_file: "Reading file",
    write_file: "Writing file",
    list_files: "Listing files",
    list_skills: "Listing skills",
    load_skill: "Loading skill",
    clawhub_search: "Searching ClawHub",
    clawhub_install: "Installing skill",
    spawn_subagent: "Spawning sub-agent",
  };

  // Restore in-progress state on mount, reconnect, or session switch
  useEffect(() => {
    if (!activeSession) return;
    let cancelled = false;

    const checkActiveTasks = () => {
      api.getActiveTasks().then((tasks: any[]) => {
        if (cancelled) return;
        // Track all sessions with active tasks for sidebar indicators
        setActiveTaskSessions(new Set(tasks.map((t: any) => t.sessionId).filter(Boolean)));
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

    // Poll every 5 seconds to keep status fresh after reconnect
    const interval = setInterval(() => {
      if (!cancelled) checkActiveTasks();
    }, 5000);

    return () => { cancelled = true; clearInterval(interval); };
  }, [activeSession, connected]);

  useEffect(() => {
    const unsub1 = onChunk((data: any) => {
      if (data.sessionId === activeSession) {
        if (data.clear) {
          setStreaming("");
        } else {
          setStreaming((prev) => prev + data.content);
        }
      }
    });
    const unsub2 = onResponse((data) => {
      // Remove completed task from sidebar indicators
      if (data.sessionId) {
        setActiveTaskSessions((prev) => {
          const next = new Set(prev);
          next.delete(data.sessionId);
          return next;
        });
      }
      if (data.sessionId === activeSession) {
        // Refresh messages from server to get the complete history including the new response
        api.getSession(activeSession).then((session: any) => {
          setMessages(session.messages || []);
        });
        setStreaming("");
        setIsLoading(false);
        setStatus("");
      }
    });
    const unsub3 = onStatus((data: any) => {
      // Track active task sessions for sidebar indicators
      if (data.sessionId && (data.status === "thinking" || data.status === "tool_call")) {
        setActiveTaskSessions((prev) => {
          if (prev.has(data.sessionId)) return prev;
          const next = new Set(prev);
          next.add(data.sessionId);
          return next;
        });
      }

      // Only update loading/status UI for active session
      if (data.sessionId && data.sessionId !== activeSession) return;

      if (data.status === "thinking") {
        setIsLoading(true);
        setStatus("Thinking...");
      } else if (data.status === "running_python") {
        setIsLoading(true);
        setStatus("Running Python...");
      } else if (data.status === "tool_call") {
        setIsLoading(true);
        const label = toolLabels[data.tool] || data.tool;
        setStatus(`${label}...`);
      } else if (data.status === "tool_result") {
        const label = toolLabels[data.tool] || data.tool;
        setStatus(`${label} done, thinking...`);
      } else if (data.status === "subagent_spawn") {
        setIsLoading(true);
        setStatus(`Sub-agent "${data.label}" spawned...`);
      } else if (data.status === "subagent_tool") {
        setIsLoading(true);
        const label = toolLabels[data.tool] || data.tool;
        setStatus(`Sub-agent "${data.label}": ${label}...`);
      } else if (data.status === "subagent_tool_done") {
        const label = toolLabels[data.tool] || data.tool;
        setStatus(`Sub-agent "${data.label}": ${label} done...`);
      } else if (data.status === "subagent_done") {
        setStatus(`Sub-agent "${data.label}" completed`);
      } else if (data.status === "subagent_error") {
        setStatus(`Sub-agent "${data.label}" failed: ${data.error}`);
      } else {
        setStatus("");
      }
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [activeSession, onChunk, onResponse, onStatus]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  const createNewSession = async () => {
    const session = await api.createSession();
    setSessions((prev) => [session, ...prev]);
    setActiveSession(session.id);
    setMessages([]);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    try {
      const result = await api.chatUpload(Array.from(files));
      if (result.success && result.files) {
        setAttachedFiles((prev) => [...prev, ...result.files]);
      }
    } catch (err) {
      console.error("Upload failed:", err);
    }
    setUploading(false);
    // Reset input so same file can be selected again
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeAttachment = (idx: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSend = useCallback(() => {
    if ((!input.trim() && attachedFiles.length === 0) || isLoading) return;

    // Separate image attachments for multimodal API payload
    const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
    const imageAttachments = attachedFiles.filter((f) => imageExts.includes(getFileExt(f.name)));
    const nonImageAttachments = attachedFiles.filter((f) => !imageExts.includes(getFileExt(f.name)));

    // Build message with non-image attachment info
    let msg = input.trim();
    if (nonImageAttachments.length > 0) {
      const fileInfo = nonImageAttachments.map((f) => `[Attached file: ${f.name} (${f.type}, ${formatFileSize(f.size)}) saved at: ${f.path}]`).join("\n");
      msg = msg ? `${msg}\n\n${fileInfo}` : fileInfo;
    }
    // Add image file info as text context (the actual image is sent via multimodal payload)
    if (imageAttachments.length > 0) {
      const imgInfo = imageAttachments.map((f) => `[Image attached: ${f.name}]`).join("\n");
      msg = msg ? `${msg}\n\n${imgInfo}` : `What's in this image?\n\n${imgInfo}`;
    }

    // Build images payload for multimodal API
    const images = imageAttachments.map((f) => ({ path: f.path, type: f.type }));

    const userMessage: Message = {
      role: "user",
      content: msg,
      timestamp: new Date().toISOString(),
      attachments: attachedFiles.length > 0 ? [...attachedFiles] : undefined,
    };

    setInput("");
    setAttachedFiles([]);

    if (!activeSession) {
      const title = input.trim().slice(0, 50) || attachedFiles[0]?.name || "File upload";
      api.createSession(title).then((session: any) => {
        setSessions((prev) => [session, ...prev]);
        setActiveSession(session.id);
        setMessages([userMessage]);
        setIsLoading(true);
        sendMessage(session.id, msg, images.length > 0 ? images : undefined);
      });
    } else {
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);
      sendMessage(activeSession, msg, images.length > 0 ? images : undefined);
    }
  }, [input, activeSession, isLoading, sendMessage, attachedFiles]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const result = await api.chatUpload(Array.from(files));
      if (result.success && result.files) {
        setAttachedFiles((prev) => [...prev, ...result.files]);
      }
    } catch (err) {
      console.error("Drop upload failed:", err);
    }
    setUploading(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await api.deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeSession === id) {
      setActiveSession(null);
      setMessages([]);
    }
  };

  const isImageFile = (name: string) => {
    const ext = name.split(".").pop()?.toLowerCase() || "";
    return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext);
  };

  return (
    <div className="chat-page">
      <div className={`chat-sidebar-backdrop ${mobileSidebar ? "visible" : ""}`} onClick={() => setMobileSidebar(false)} />
      <div className={`chat-sidebar ${mobileSidebar ? "mobile-open" : ""}`}>
        <button className="btn btn-primary new-chat-btn" onClick={() => { createNewSession(); setMobileSidebar(false); }}>
          <Icon name="add" /> New chat
        </button>
        <div className="session-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${activeSession === s.id ? "active" : ""}`}
              onClick={() => { setActiveSession(s.id); setMobileSidebar(false); }}
            >
              {activeTaskSessions.has(s.id) && <span className="session-running-indicator" title="Task running" />}
              <span className="session-title">{s.title}</span>
              <button className="session-delete btn-icon btn-ghost" onClick={(e) => deleteSession(s.id, e)}>
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="chat-main" onDrop={handleDrop} onDragOver={handleDragOver}>
        <button className="mobile-sessions-toggle" onClick={() => setMobileSidebar(true)}>
          <Icon name="chat" />
          <span>{activeSession ? sessions.find(s => s.id === activeSession)?.title || "Chat" : "Sessions"}</span>
        </button>
        {!activeSession && messages.length === 0 ? (
          <div className="chat-empty">
            <h1>Tiger Cowork</h1>
            <p>Start a conversation to get help with coding, run Python, manage files, and more.</p>
            <div className="chat-suggestions">
              {["Write a Python script to generate a PDF report", "Help me analyze a CSV file", "Build a React dashboard with charts", "Create a web scraper"].map((s) => (
                <button key={s} className="suggestion-chip" onClick={() => { setInput(s); textareaRef.current?.focus(); }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat-messages">
            {messages.map((msg, i) => (
              <div key={i} className={`message ${msg.role}`}>
                <div className="message-avatar">{msg.role === "user" ? "U" : "C"}</div>
                <div className="message-content">
                  {msg.role === "assistant" ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{msg.content}</ReactMarkdown>
                  ) : (
                    <>
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="message-attachments">
                          {msg.attachments.map((f, j) => (
                            <div key={j} className="attachment-item">
                              {isImageFile(f.name) ? (
                                <img src={sandboxUrl(f.path)} alt={f.name} className="attachment-image-preview" />
                              ) : (
                                <div className="attachment-icon">{getFileIcon(f.name)}</div>
                              )}
                              <div className="attachment-info">
                                <span className="attachment-name">{f.name}</span>
                                <span className="attachment-size">{formatFileSize(f.size)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <p>{msg.content.replace(/\[Attached file:.*?\]/g, "").trim()}</p>
                    </>
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
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{streaming}</ReactMarkdown>
                </div>
              </div>
            )}
            {status && <div className="chat-status">{status}</div>}
            <div ref={messagesEndRef} />
          </div>
        )}

        <div className="chat-input-container">
          {/* Attached files preview */}
          {attachedFiles.length > 0 && (
            <div className="attachments-preview">
              {attachedFiles.map((f, i) => (
                <div key={i} className="attachment-preview-item">
                  {isImageFile(f.name) ? (
                    <img src={sandboxUrl(f.path)} alt={f.name} className="attachment-thumb" />
                  ) : (
                    <div className="attachment-preview-icon">{getFileIcon(f.name)}</div>
                  )}
                  <span className="attachment-preview-name">{f.name}</span>
                  <button className="attachment-remove" onClick={() => removeAttachment(i)}>&times;</button>
                </div>
              ))}
            </div>
          )}
          <div className="chat-input-wrapper">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.json,.xml,.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp,.py,.js,.ts,.html,.css,.md,.yaml,.yml,.zip,.tar,.gz"
              style={{ display: "none" }}
              onChange={handleFileSelect}
            />
            <button
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading || uploading}
              title="Attach files (PDF, images, documents, code)"
            >
              {uploading ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="spin">
                  <path d="M12 4V2C6.48 2 2 6.48 2 12h2c0-4.42 3.58-8 8-8z" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z" />
                </svg>
              )}
            </button>
            <textarea
              ref={textareaRef}
              className="chat-input"
              placeholder="Message Tiger Cowork..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={isLoading}
            />
            <button
              className={`send-btn ${input.trim() || attachedFiles.length > 0 ? "active" : ""}`}
              onClick={handleSend}
              disabled={(!input.trim() && attachedFiles.length === 0) || isLoading}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </div>
          <div className="chat-input-hint">
            {connected ? "Connected" : "Disconnected"} · Attach files with the clip icon or drag & drop · Press Enter to send
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
  );
}
