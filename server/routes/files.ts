import { Router } from "express";
import { listFiles, readFile, writeFile, deleteFile, validatePath } from "../services/sandbox";
import multer from "multer";
import path from "path";
import fs from "fs";
import mammoth from "mammoth";
// @ts-ignore
import pdfParse from "pdf-parse";

export const filesRouter = Router();

filesRouter.get("/", (req, res) => {
  try {
    const subPath = (req.query.path as string) || "";
    const files = listFiles(req.app.locals.sandboxDir, subPath);
    res.json(files);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

filesRouter.get("/read", (req, res) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "path required" });
    const content = readFile(req.app.locals.sandboxDir, filePath);
    res.json({ content, path: filePath });
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

filesRouter.post("/write", (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: "path required" });
    writeFile(req.app.locals.sandboxDir, filePath, content || "");
    res.json({ success: true, path: filePath });
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

filesRouter.delete("/", (req, res) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "path required" });
    deleteFile(req.app.locals.sandboxDir, filePath);
    res.json({ success: true });
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

// Mkdir
filesRouter.post("/mkdir", (req, res) => {
  try {
    const dirPath = req.body.path;
    if (!dirPath) return res.status(400).json({ error: "path required" });
    const resolved = validatePath(req.app.locals.sandboxDir, dirPath);
    if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    res.json({ success: true, path: dirPath });
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

// Upload
const upload = multer({ dest: "/tmp/cowork-uploads" });
filesRouter.post("/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const destDir = req.body.path || "";
    const destPath = destDir ? destDir + "/" + req.file.originalname : req.file.originalname;
    const resolved = validatePath(req.app.locals.sandboxDir, destPath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(req.file.path, resolved);
    res.json({ success: true, path: destPath });
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});

// Chat file upload (multiple files, saved to uploads/ in sandbox)
const chatUpload = multer({
  dest: "/tmp/cowork-uploads",
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt", ".json", ".xml",
      ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg",
      ".py", ".js", ".ts", ".html", ".css", ".md", ".yaml", ".yml",
      ".zip", ".tar", ".gz",
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

filesRouter.post("/chat-upload", chatUpload.array("files", 10), (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) return res.status(400).json({ error: "No files" });

    const sandboxDir = req.app.locals.sandboxDir;
    const uploadsDir = path.join(sandboxDir, "uploads");
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const uploaded: { name: string; path: string; size: number; type: string }[] = [];
    for (const file of files) {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const destName = `${Date.now()}_${safeName}`;
      const destPath = path.join(uploadsDir, destName);
      fs.renameSync(file.path, destPath);
      uploaded.push({
        name: file.originalname,
        path: `uploads/${destName}`,
        size: file.size,
        type: file.mimetype,
      });
    }
    res.json({ success: true, files: uploaded });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Preview PDF / DOCX — returns extracted HTML content
filesRouter.get("/preview", async (req, res) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "path required" });
    const resolved = validatePath(req.app.locals.sandboxDir, filePath);
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: "File not found" });

    const ext = path.extname(resolved).toLowerCase();

    if (ext === ".pdf") {
      const buffer = fs.readFileSync(resolved);
      const data = await pdfParse(buffer);
      // Return pages of text as HTML
      const html = data.text
        .split(/\f/) // form-feed = page break in pdf-parse
        .map((page: string) => page.trim())
        .filter((p: string) => p.length > 0)
        .map((page: string) => `<div class="pdf-page">${page.replace(/\n/g, "<br/>")}</div>`)
        .join('<hr class="page-break"/>');
      res.json({ type: "pdf", pages: data.numpages, html });
    } else if (ext === ".docx" || ext === ".doc") {
      const buffer = fs.readFileSync(resolved);
      const result = await mammoth.convertToHtml({ buffer });
      res.json({ type: "docx", html: result.value });
    } else {
      res.status(400).json({ error: "Unsupported file type for preview" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Download
filesRouter.get("/download", (req, res) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "path required" });
    const resolved = validatePath(req.app.locals.sandboxDir, filePath);
    res.download(resolved);
  } catch (err: any) {
    res.status(403).json({ error: err.message });
  }
});
