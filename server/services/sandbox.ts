import path from "path";
import fs from "fs";

export function validatePath(sandboxDir: string, requestedPath: string): string {
  const resolved = path.resolve(sandboxDir, requestedPath);
  // Allow access to the installation folder and its contents
  const root = path.resolve(sandboxDir);
  if (!resolved.startsWith(root)) {
    throw new Error("Access denied: path outside workspace");
  }
  return resolved;
}

export function listFiles(sandboxDir: string, subPath: string = ""): any[] {
  const dir = validatePath(sandboxDir, subPath);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    path: path.join(subPath, entry.name),
    isDirectory: entry.isDirectory(),
    size: entry.isDirectory() ? 0 : fs.statSync(path.join(dir, entry.name)).size,
    modified: fs.statSync(path.join(dir, entry.name)).mtime.toISOString(),
  }));
}

export function readFile(sandboxDir: string, filePath: string): string {
  const resolved = validatePath(sandboxDir, filePath);
  return fs.readFileSync(resolved, "utf-8");
}

export function writeFile(sandboxDir: string, filePath: string, content: string): void {
  const resolved = validatePath(sandboxDir, filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, content);
}

export function deleteFile(sandboxDir: string, filePath: string): void {
  const resolved = validatePath(sandboxDir, filePath);
  if (fs.statSync(resolved).isDirectory()) {
    fs.rmSync(resolved, { recursive: true });
  } else {
    fs.unlinkSync(resolved);
  }
}
