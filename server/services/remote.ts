/**
 * Remote Agent Bridge — execute tasks on another Tiger Cowork instance.
 *
 * Both machines run the same codebase. Either can be orchestrator or worker.
 * The REST API is always on; adding a Remote Instance + referencing it in YAML
 * is all that's needed to delegate work across machines.
 *
 * Flow (new endpoint):
 *   1. POST /api/remote/task → submit the task, get { taskId }
 *   2. Poll GET /api/remote/task/:id → progress + result
 *
 * Fallback: If the remote doesn't support /api/remote/task, falls back to
 *   the legacy session-based flow (POST /api/chat/sessions + messages + poll).
 */

export interface RemoteInstance {
  id: string;
  name: string;
  url: string;   // e.g. http://192.168.1.50:3001
  token: string;  // the remote machine's ACCESS_TOKEN
}

export interface RemoteTaskOptions {
  idleTimeoutMs?: number;   // abort if no new messages for this long (default 120s)
  maxTimeoutMs?: number;    // hard deadline (default 30 min)
  signal?: AbortSignal;     // external abort
  onProgress?: (msg: string) => void;  // progress callback
}

interface RemoteMessage {
  role: string;
  content: string;
}

/**
 * Send a task to a remote Tiger Cowork instance and poll until it replies.
 *
 * Tries the new /api/remote/task endpoint first (supports realtime agents + progress).
 * Falls back to legacy session-based flow if the endpoint is unavailable.
 */
export async function remoteTask(
  instance: RemoteInstance,
  task: string,
  opts: RemoteTaskOptions = {},
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const maxTimeoutMs = opts.maxTimeoutMs ?? 1_800_000;
  const baseUrl = instance.url.replace(/\/+$/, "");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${instance.token}`,
  };

  // Try the new /api/remote/task endpoint first
  try {
    const submitRes = await fetch(`${baseUrl}/api/remote/task`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task }),
    });

    if (submitRes.ok) {
      const { taskId } = await submitRes.json();
      console.log(`[Remote] Task ${taskId} submitted to ${instance.name} via /api/remote/task`);
      return await pollRemoteTask(baseUrl, headers, taskId, instance.name, opts);
    }

    // If 404 or 403, fall through to legacy flow
    if (submitRes.status !== 404 && submitRes.status !== 403) {
      const errText = await submitRes.text();
      return { ok: false, error: `Remote task submission failed (${submitRes.status}): ${errText}` };
    }
    console.log(`[Remote] /api/remote/task not available on ${instance.name}, using legacy flow`);
  } catch {
    console.log(`[Remote] /api/remote/task fetch failed on ${instance.name}, using legacy flow`);
  }

  // --- Legacy flow (session-based) ---
  return await legacyRemoteTask(instance, task, opts);
}

/**
 * Poll the new /api/remote/task/:id endpoint for progress and result.
 */
async function pollRemoteTask(
  baseUrl: string,
  headers: Record<string, string>,
  taskId: string,
  instanceName: string,
  opts: RemoteTaskOptions,
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const maxTimeoutMs = opts.maxTimeoutMs ?? 1_800_000;
  const POLL_INTERVAL = 3_000;
  const startTime = Date.now();
  let lastProgressCount = 0;
  let lastActivityAt = Date.now();

  while (true) {
    if (opts.signal?.aborted) {
      return { ok: false, error: "Remote task aborted by caller" };
    }
    if (Date.now() - startTime > maxTimeoutMs) {
      return { ok: false, error: `Remote task exceeded max timeout (${Math.round(maxTimeoutMs / 1000)}s)` };
    }
    if (Date.now() - lastActivityAt > idleTimeoutMs) {
      return { ok: false, error: `Remote task idle timeout (${Math.round(idleTimeoutMs / 1000)}s with no progress)` };
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

    try {
      const pollRes = await fetch(`${baseUrl}/api/remote/task/${taskId}`, { headers });
      if (!pollRes.ok) continue;

      const data = await pollRes.json();

      // Report new progress messages
      if (data.progress && data.progress.length > lastProgressCount) {
        for (let i = lastProgressCount; i < data.progress.length; i++) {
          const msg = data.progress[i];
          console.log(`[Remote:${instanceName}] ${msg}`);
          opts.onProgress?.(msg);
        }
        lastProgressCount = data.progress.length;
        lastActivityAt = Date.now();
      }

      if (data.status === "completed") {
        console.log(`[Remote] Task ${taskId} completed on ${instanceName}`);
        return { ok: true, result: data.result };
      }

      if (data.status === "error") {
        return { ok: false, error: data.error || "Remote task failed" };
      }

      // Still running — activity detected by progress messages above
    } catch {
      // Network blip, retry
    }
  }
}

/**
 * Legacy session-based remote task flow (for backward compatibility).
 */
async function legacyRemoteTask(
  instance: RemoteInstance,
  task: string,
  opts: RemoteTaskOptions,
): Promise<{ ok: boolean; result?: string; error?: string }> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 60_000;
  const maxTimeoutMs = opts.maxTimeoutMs ?? 1_800_000;
  const baseUrl = instance.url.replace(/\/+$/, "");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${instance.token}`,
  };

  try {
    // 1. Create session
    const createRes = await fetch(`${baseUrl}/api/chat/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: `Remote task from ${instance.name || instance.id}` }),
    });
    if (!createRes.ok) {
      const errText = await createRes.text();
      return { ok: false, error: `Failed to create remote session (${createRes.status}): ${errText}` };
    }
    const session = await createRes.json();
    const sessionId: string = session.id;
    console.log(`[Remote] Session ${sessionId} created on ${instance.name} (${baseUrl}) [legacy]`);

    // 2. Send task as user message
    const msgRes = await fetch(`${baseUrl}/api/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "user", message: task }),
    });
    if (!msgRes.ok) {
      const errText = await msgRes.text();
      return { ok: false, error: `Failed to send task to remote (${msgRes.status}): ${errText}` };
    }
    console.log(`[Remote] Task sent to ${instance.name} [legacy], polling for response...`);

    // 3. Activity-based polling
    const startTime = Date.now();
    let lastActivityAt = Date.now();
    let lastMessageCount = 0;
    const POLL_INTERVAL = 2_000;

    while (true) {
      if (opts.signal?.aborted) {
        return { ok: false, error: "Remote task aborted by caller" };
      }
      if (Date.now() - startTime > maxTimeoutMs) {
        return { ok: false, error: `Remote task exceeded max timeout (${Math.round(maxTimeoutMs / 1000)}s)` };
      }
      if (Date.now() - lastActivityAt > idleTimeoutMs) {
        return { ok: false, error: `Remote task idle timeout (${Math.round(idleTimeoutMs / 1000)}s with no new messages)` };
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

      let sessionData: any;
      try {
        const pollRes = await fetch(`${baseUrl}/api/chat/sessions/${sessionId}`, { headers });
        if (!pollRes.ok) continue;
        sessionData = await pollRes.json();
      } catch {
        continue;
      }

      const messages: RemoteMessage[] = sessionData.messages || [];

      if (messages.length > lastMessageCount) {
        lastActivityAt = Date.now();
        lastMessageCount = messages.length;
      }

      if (messages.length > 0) {
        const last = messages[messages.length - 1];
        if (last.role === "assistant") {
          console.log(`[Remote] Got response from ${instance.name} (${messages.length} messages) [legacy]`);
          return { ok: true, result: last.content };
        }
      }
    }
  } catch (err: any) {
    return { ok: false, error: `Remote task error: ${err.message}` };
  }
}
