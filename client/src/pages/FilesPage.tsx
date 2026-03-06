import { useState, useEffect } from "react";
import { api } from "../utils/api";
import "./PageStyles.css";

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string;
}

export default function FilesPage() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    loadFiles(currentPath);
  }, [currentPath]);

  const loadFiles = async (path: string) => {
    const data = await api.listFiles(path);
    setFiles(data);
  };

  const openFile = async (file: FileEntry) => {
    if (file.isDirectory) {
      setCurrentPath(file.path);
      setSelectedFile(null);
    } else {
      const data = await api.readFile(file.path);
      setSelectedFile(file.path);
      setFileContent(data.content);
      setEditing(false);
    }
  };

  const saveFile = async () => {
    if (!selectedFile) return;
    await api.writeFile(selectedFile, fileContent);
    setEditing(false);
  };

  const createFile = async () => {
    if (!newFileName) return;
    const filePath = currentPath ? `${currentPath}/${newFileName}` : newFileName;
    await api.writeFile(filePath, "");
    setShowNew(false);
    setNewFileName("");
    loadFiles(currentPath);
  };

  const deleteFile = async (path: string) => {
    if (!confirm(`Delete ${path}?`)) return;
    await api.deleteFile(path);
    if (selectedFile === path) {
      setSelectedFile(null);
      setFileContent("");
    }
    loadFiles(currentPath);
  };

  const goUp = () => {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    setCurrentPath(parts.join("/"));
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "-";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="page-split">
      <div className="panel">
        <div className="panel-header">
          <h2>Sandbox Files</h2>
          <div className="panel-actions">
            <button className="btn btn-secondary" onClick={() => setShowNew(true)}>New file</button>
          </div>
        </div>

        <div className="breadcrumb">
          <button className="breadcrumb-item" onClick={() => setCurrentPath("")}>sandbox</button>
          {currentPath.split("/").filter(Boolean).map((part, i, arr) => (
            <span key={i}>
              <span className="breadcrumb-sep">/</span>
              <button className="breadcrumb-item" onClick={() => setCurrentPath(arr.slice(0, i + 1).join("/"))}>
                {part}
              </button>
            </span>
          ))}
        </div>

        {showNew && (
          <div className="inline-form">
            <input placeholder="filename.txt" value={newFileName} onChange={(e) => setNewFileName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createFile()} autoFocus />
            <button className="btn btn-primary" onClick={createFile}>Create</button>
            <button className="btn btn-ghost" onClick={() => setShowNew(false)}>Cancel</button>
          </div>
        )}

        {currentPath && (
          <div className="file-item" onClick={goUp}>
            <span className="file-icon">↑</span>
            <span className="file-name">..</span>
          </div>
        )}

        <div className="file-list">
          {files.map((file) => (
            <div key={file.name} className={`file-item ${selectedFile === file.path ? "active" : ""}`} onClick={() => openFile(file)}>
              <span className="file-icon">{file.isDirectory ? "📁" : "📄"}</span>
              <span className="file-name">{file.name}</span>
              <span className="file-size">{formatSize(file.size)}</span>
              <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); deleteFile(file.path); }}>×</button>
              {!file.isDirectory && (
                <a className="btn btn-ghost btn-sm" href={api.downloadUrl(file.path)} download onClick={(e) => e.stopPropagation()}>↓</a>
              )}
            </div>
          ))}
          {files.length === 0 && <div className="empty-state">No files yet</div>}
        </div>
      </div>

      {selectedFile && (
        <div className="panel editor-panel">
          <div className="panel-header">
            <h3>{selectedFile}</h3>
            <div className="panel-actions">
              {editing ? (
                <>
                  <button className="btn btn-primary" onClick={saveFile}>Save</button>
                  <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
                </>
              ) : (
                <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit</button>
              )}
            </div>
          </div>
          {editing ? (
            <textarea className="file-editor" value={fileContent} onChange={(e) => setFileContent(e.target.value)} />
          ) : (
            <pre className="file-preview">{fileContent}</pre>
          )}
        </div>
      )}
    </div>
  );
}
