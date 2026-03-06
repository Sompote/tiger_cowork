import { Router } from "express";
import { runPython } from "../services/python";
import { getSettings } from "../services/data";
import path from "path";

export const pythonRouter = Router();

pythonRouter.post("/run", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });

  const settings = getSettings();
  const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
  const result = await runPython(code, sandboxDir);
  res.json(result);
});
