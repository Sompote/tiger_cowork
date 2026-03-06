import { getSettings } from "./data";
import { getTools, callTool } from "./toolbox";

interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

interface TigerBotResponse {
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  toolResults?: Array<{ tool: string; result: any }>;
}

function getApiConfig() {
  const settings = getSettings();
  const apiKey = settings.tigerBotApiKey;
  const model = settings.tigerBotModel || "TigerBot-70B-Chat";
  const rawUrl = settings.tigerBotApiUrl || "https://api.tigerbot.com/bot-chat/openai/v1/chat/completions";
  const apiUrl = rawUrl.endsWith("/chat/completions") ? rawUrl : rawUrl.replace(/\/$/, "") + "/chat/completions";
  return { apiKey, model, apiUrl };
}

// Single LLM call (no tool loop)
async function llmCall(messages: ChatMessage[], options: { tools?: any[]; model?: string } = {}): Promise<any> {
  const { apiKey, model, apiUrl } = getApiConfig();
  if (!apiKey) throw new Error("API key not configured");

  const body: any = {
    model: options.model || model,
    messages,
    temperature: 0.7,
    max_tokens: 8192,
  };
  if (options.tools && options.tools.length) {
    body.tools = options.tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API Error (${response.status}): ${error}`);
  }

  return response.json();
}

// Tool-calling loop (like Tiger_bot's runWithTools)
export async function callTigerBotWithTools(
  messages: ChatMessage[],
  systemPrompt?: string,
  onToolCall?: (name: string, args: any) => void,
  onToolResult?: (name: string, result: any) => void
): Promise<TigerBotResponse> {
  const { apiKey } = getApiConfig();
  if (!apiKey) {
    return { content: "API key not configured. Go to Settings to add your API key." };
  }

  const allMessages: ChatMessage[] = [];
  if (systemPrompt) {
    allMessages.push({ role: "system", content: systemPrompt });
  }
  allMessages.push(...messages);

  const maxToolRounds = 8;
  const maxToolCalls = 12;
  const toolResults: Array<{ tool: string; result: any }> = [];
  const toolCallHistory: string[] = [];
  let totalToolCalls = 0;
  let usesSkill = false; // Track if a skill was loaded (needs more tool calls)
  let consecutiveErrors = 0;

  for (let round = 0; round < maxToolRounds; round++) {
    let data: any;
    try {
      data = await llmCall(allMessages, { tools: getTools() });
    } catch (err: any) {
      return { content: `Connection error: ${err.message}`, toolResults };
    }

    const choice = data.choices?.[0];
    if (!choice) return { content: "No response from API.", usage: data.usage, toolResults };

    const message = choice.message;
    const toolCalls = message.tool_calls || [];

    // Add assistant message to context
    allMessages.push({
      role: "assistant",
      content: message.content || "",
      tool_calls: toolCalls.length ? toolCalls : undefined,
    });

    // If no tool calls, we're done — return the text response
    if (!toolCalls.length) {
      return {
        content: message.content || "No response generated.",
        usage: data.usage,
        toolResults,
      };
    }

    // Loop detection: same tools with same args called 3 rounds in a row → stop
    // Use tool names + truncated args hash to distinguish explore vs chart vs fix
    const currentSignature = toolCalls.map((tc: any) => {
      const name = tc.function?.name || "";
      const args = tc.function?.arguments || "";
      const argSnippet = typeof args === "string" ? args.slice(0, 100) : JSON.stringify(args).slice(0, 100);
      return `${name}:${argSnippet}`;
    }).sort().join("|");
    toolCallHistory.push(currentSignature);
    if (toolCallHistory.length >= 3) {
      const last3 = toolCallHistory.slice(-3);
      if (last3[0] === last3[1] && last3[1] === last3[2]) {
        console.log(`[ToolLoop] Loop detected: same tools+args 3 rounds. Breaking.`);
        break;
      }
    }

    // Execute each tool call
    for (const tc of toolCalls) {
      const fnName = tc.function?.name || "";
      let fnArgs: any = {};
      const rawArgs = tc.function?.arguments || "{}";
      if (typeof rawArgs === "object" && rawArgs !== null) {
        fnArgs = rawArgs;
      } else try {
        fnArgs = JSON.parse(rawArgs);
      } catch (parseErr: any) {
        console.error(`[Tool ${fnName}] JSON parse failed:`, parseErr.message);
        console.error(`[Tool ${fnName}] Raw args (first 500):`, rawArgs.slice(0, 500));
        if (fnName === "run_react" || fnName === "run_python") {
          const codeKey = rawArgs.indexOf('"code"');
          if (codeKey !== -1) {
            const valueStart = rawArgs.indexOf('"', codeKey + 6) + 1;
            if (valueStart > 0) {
              let valueEnd = rawArgs.lastIndexOf('"');
              const trailingKeys = ['"title"', '"dependencies"'];
              for (const tk of trailingKeys) {
                const tkPos = rawArgs.lastIndexOf(tk);
                if (tkPos > valueStart) {
                  const commaPos = rawArgs.lastIndexOf(',', tkPos);
                  if (commaPos > valueStart) {
                    const quoteBeforeComma = rawArgs.lastIndexOf('"', commaPos - 1);
                    if (quoteBeforeComma > valueStart) {
                      valueEnd = quoteBeforeComma;
                    }
                  }
                }
              }
              if (valueEnd > valueStart) {
                const codeValue = rawArgs.slice(valueStart, valueEnd);
                fnArgs = { code: codeValue };
                const titleMatch = rawArgs.match(/"title"\s*:\s*"([^"]*)"/);
                if (titleMatch) fnArgs.title = titleMatch[1];
                const depsMatch = rawArgs.match(/"dependencies"\s*:\s*\[([^\]]*)\]/);
                if (depsMatch) {
                  fnArgs.dependencies = depsMatch[1].split(',').map((s: string) => s.trim().replace(/"/g, '')).filter(Boolean);
                }
                console.log(`[Tool ${fnName}] Recovered code (${codeValue.length} chars)`);
              }
            }
          }
        }
      }

      // Track skill usage — if a skill is loaded, allow more tool calls
      if (fnName === "load_skill") usesSkill = true;

      console.log(`[Tool ${fnName}] args:`, Object.keys(fnArgs), fnArgs.code ? `code(${fnArgs.code.length})` : fnArgs.command || fnArgs.cmd || fnArgs.query || fnArgs.skill || fnArgs.path || "");

      if (onToolCall) onToolCall(fnName, fnArgs);

      let result: any;
      try {
        result = await callTool(fnName, fnArgs);
      } catch (err: any) {
        result = { ok: false, error: err.message };
      }

      // Track consecutive errors — if tool keeps failing, stop
      if (result?.ok === false || result?.exitCode === 1) {
        consecutiveErrors++;
        console.log(`[Tool ${fnName}] Failed (${consecutiveErrors} consecutive errors):`, result?.error || result?.stderr || "");
      } else {
        consecutiveErrors = 0;
      }

      if (onToolResult) onToolResult(fnName, result);
      toolResults.push({ tool: fnName, result });
      totalToolCalls++;

      // Truncate large tool results to prevent context overflow
      let resultStr = JSON.stringify(result);
      const maxLen = fnName === "load_skill" ? 3000 : 6000;
      if (resultStr.length > maxLen) {
        resultStr = resultStr.slice(0, maxLen) + "\n...(truncated)";
      }
      allMessages.push({
        role: "tool",
        content: resultStr,
        tool_call_id: tc.id,
      });

      // Stop if too many consecutive errors (tool/command not available)
      if (consecutiveErrors >= 3) {
        console.log(`[ToolLoop] 3 consecutive errors. Breaking.`);
        break;
      }

      // Hard stop at max tool calls
      if (totalToolCalls >= maxToolCalls) break;
    }

    if (totalToolCalls >= maxToolCalls || consecutiveErrors >= 3) break;
  }

  console.log(`[ToolLoop] Ended after ${totalToolCalls} tool calls. Generating final response...`);

  // Check if user likely wanted output files but none were generated
  const hasOutputFiles = toolResults.some((tr) => tr.result?.outputFiles?.length > 0);
  const userWantsOutput = allMessages.some((m) =>
    m.role === "user" && /\b(chart|graph|plot|report|analy[sz]|visual|diagram|figure)\b/i.test(m.content)
  );

  // If user wanted graphs/analysis but none were generated, do extra rounds to generate them
  if (userWantsOutput && !hasOutputFiles && totalToolCalls > 0) {
    // Collect any error messages from failed tool calls to help LLM fix them
    const errors = toolResults
      .filter((tr) => tr.result?.exitCode === 1 || tr.result?.ok === false)
      .map((tr) => tr.result?.stderr || tr.result?.error || "unknown error")
      .join("\n");

    const errorHint = errors
      ? `\n\nYour previous code had errors:\n${errors.slice(0, 1000)}\n\nFix these errors in your new code.`
      : "";

    console.log("[ToolLoop] User wanted output files but none generated. Nudging LLM to create them...");
    allMessages.push({
      role: "system",
      content: `IMPORTANT: The user asked for charts/graphs/analysis but you have NOT generated any output files yet. You MUST now call run_python to create matplotlib charts and save them as PNG files. Write simple, robust code — avoid complex table formatting. Use plt.savefig('filename.png', dpi=150, bbox_inches='tight') for each chart. Combine reading data + creating charts in one run_python call.${errorHint}`,
    });

    const maxNudgeRounds = 3;
    for (let nudgeRound = 0; nudgeRound < maxNudgeRounds; nudgeRound++) {
      try {
        const nudgeData = await llmCall(allMessages, { tools: getTools() });
        const nudgeChoice = nudgeData.choices?.[0];
        if (!nudgeChoice?.message?.tool_calls?.length) {
          // LLM responded with text instead of tools
          if (nudgeChoice?.message?.content) {
            return { content: nudgeChoice.message.content, usage: nudgeData.usage, toolResults };
          }
          break;
        }

        const nudgeMsg = nudgeChoice.message;
        allMessages.push({
          role: "assistant",
          content: nudgeMsg.content || "",
          tool_calls: nudgeMsg.tool_calls,
        });

        let nudgeHasOutput = false;
        for (const tc of nudgeMsg.tool_calls) {
          const fnName = tc.function?.name || "";
          let fnArgs: any = {};
          try { fnArgs = JSON.parse(tc.function?.arguments || "{}"); } catch { fnArgs = {}; }
          if (onToolCall) onToolCall(fnName, fnArgs);
          let result: any;
          try { result = await callTool(fnName, fnArgs); } catch (err: any) { result = { ok: false, error: err.message }; }
          if (onToolResult) onToolResult(fnName, result);
          toolResults.push({ tool: fnName, result });
          totalToolCalls++;
          if (result?.outputFiles?.length > 0) nudgeHasOutput = true;
          let resultStr = JSON.stringify(result);
          if (resultStr.length > 6000) resultStr = resultStr.slice(0, 6000) + "\n...(truncated)";
          allMessages.push({ role: "tool", content: resultStr, tool_call_id: tc.id });
        }

        // If we got output files, we're done nudging
        if (nudgeHasOutput) {
          console.log("[NudgeLoop] Output files generated successfully.");
          break;
        }

        // If code errored, add a fix hint for next round
        const lastResult = toolResults[toolResults.length - 1]?.result;
        if (lastResult?.exitCode === 1 && lastResult?.stderr) {
          allMessages.push({
            role: "system",
            content: `Your code failed with error:\n${lastResult.stderr.slice(0, 800)}\n\nFix the error and try again. Keep the code simple — avoid complex formatting. Just create basic charts with plt.plot/plt.bar/plt.scatter and plt.savefig.`,
          });
        }
      } catch (err: any) {
        console.error("[NudgeLoop] Failed:", err.message);
        break;
      }
    }
  }

  // Force a final text response — build a summary of what tools found
  const toolSummary = toolResults.map((tr) => {
    let brief = "";
    try {
      const r = tr.result;
      if (typeof r === "string") brief = r.slice(0, 500);
      else if (r?.stdout) brief = r.stdout.slice(0, 500);
      else if (r?.result) brief = String(r.result).slice(0, 500);
      else if (r?.content) brief = String(r.content).slice(0, 500);
      else if (r?.ok === false) brief = `Error: ${r.error || "failed"}`;
      else brief = JSON.stringify(r).slice(0, 500);
    } catch { brief = "(result unavailable)"; }
    return `[${tr.tool}]: ${brief}`;
  }).join("\n\n");

  allMessages.push({
    role: "system",
    content: `You have gathered results from ${totalToolCalls} tool calls. Here is a summary:\n\n${toolSummary}\n\nNow provide a clear, helpful response to the user based on these results. Do NOT call any more tools.`,
  });

  try {
    const data = await llmCall(allMessages);
    const content = data.choices?.[0]?.message?.content || "";
    if (content) {
      return { content, usage: data.usage, toolResults };
    }
  } catch (err: any) {
    console.error("[FinalResponse] Failed to generate summary:", err.message);
  }

  // Absolute fallback: show tool results directly (skip internal skill docs)
  const fallbackContent = toolResults.filter((tr) => tr.tool !== "load_skill").map((tr) => {
    let text = "";
    try {
      const r = tr.result;
      if (r?.stdout) text = r.stdout;
      else if (r?.result) text = String(r.result);
      else if (r?.content) text = String(r.content);
      else if (r?.data) text = typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2);
      else text = JSON.stringify(r, null, 2);
    } catch { text = "(no result)"; }
    return `**${tr.tool}:**\n${text.slice(0, 2000)}`;
  }).join("\n\n---\n\n");

  return { content: fallbackContent || "No results from tools.", toolResults };
}

// Simple call without tools (backwards compat)
export async function callTigerBot(
  messages: ChatMessage[],
  systemPrompt?: string
): Promise<TigerBotResponse> {
  const { apiKey } = getApiConfig();
  if (!apiKey) {
    return { content: "TigerBot API key not configured. Go to Settings to add your API key." };
  }

  const allMessages: ChatMessage[] = [];
  if (systemPrompt) {
    allMessages.push({ role: "system", content: systemPrompt });
  }
  allMessages.push(...messages);

  try {
    const data = await llmCall(allMessages);
    return {
      content: data.choices?.[0]?.message?.content || "No response from TigerBot.",
      usage: data.usage,
    };
  } catch (err: any) {
    return { content: `Connection error: ${err.message}` };
  }
}

// Streaming with tool support
export async function streamTigerBotWithTools(
  messages: ChatMessage[],
  systemPrompt: string,
  onChunk: (text: string) => void,
  onToolCall: (name: string, args: any) => void,
  onToolResult: (name: string, result: any) => void,
  onDone: (toolResults: Array<{ tool: string; result: any }>) => void
): Promise<void> {
  // Use non-streaming tool loop for reliability, then stream the final answer
  const result = await callTigerBotWithTools(messages, systemPrompt, onToolCall, onToolResult);
  if (result.content) {
    onChunk(result.content);
  }
  onDone(result.toolResults || []);
}

// Legacy streaming (no tools) for backwards compat
export async function streamTigerBot(
  messages: ChatMessage[],
  systemPrompt: string,
  onChunk: (text: string) => void,
  onDone: () => void
): Promise<void> {
  const { apiKey, model, apiUrl } = getApiConfig();

  if (!apiKey) {
    onChunk("TigerBot API key not configured. Go to Settings to add your API key.");
    onDone();
    return;
  }

  const allMessages: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...messages];

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: allMessages,
        temperature: 0.7,
        max_tokens: 4096,
        stream: true,
      }),
    });

    if (!response.ok) {
      onChunk(`API Error (${response.status}): ${await response.text()}`);
      onDone();
      return;
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    if (!reader) { onDone(); return; }

    let buffer = "";
    let fullContent = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || trimmed === "data: [DONE]") continue;
        if (trimmed.startsWith("data: ")) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              onChunk(delta);
            }
          } catch {}
        }
      }
    }
    if (!fullContent.trim()) {
      const result = await callTigerBot(allMessages.map(m => ({ role: m.role as any, content: m.content })));
      if (result.content) onChunk(result.content);
    }
    onDone();
  } catch (err: any) {
    onChunk(`Connection error: ${err.message}`);
    onDone();
  }
}
