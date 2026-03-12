import { getSettings } from "./data";
import { getTools, callTool } from "./toolbox";

interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: any[];
  tool_call_id?: string;
}

interface TigerBotResponse {
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  toolResults?: Array<{ tool: string; result: any }>;
}

// Strip internal tool call markers from LLM responses before showing to users
// Handles various formats the LLM may use to represent tool calls inline
function sanitizeToolCallContent(content: string): string {
  if (!content) return content;
  let cleaned = content;
  // Remove [tool_name]({"param": "value", ...}) style markers (JSON args)
  cleaned = cleaned.replace(/\[(\w+)\]\s*\(\s*\{[^}]*\}\s*\)/g, "");
  // Remove [tool_name](<parameter name="...">...</parameter>) style markers (XML-like, single line)
  cleaned = cleaned.replace(/\[(\w+)\]\s*\(<parameter[^)]*\)/g, "");
  // Remove multi-line XML parameter blocks: [tool_name](<parameter name="key">value</parameter>)
  // Also handles malformed variants like <fetch_url](<parameter...
  cleaned = cleaned.replace(/\[?\w+\]?\s*\(<parameter\s+name="[^"]*">[^<]*<\/parameter>\s*\)/g, "");
  // Remove standalone [tool_name] markers for known internal tools
  cleaned = cleaned.replace(/\[(web_search|fetch_url|run_python|run_react|read_file|write_file|list_files|web_fetch|load_skill)\]/g, "");
  // Remove lines that are just tool call artifacts (e.g., bare parameter tags)
  cleaned = cleaned.replace(/^.*<parameter\s+name="[^"]*">.*<\/parameter>.*$/gm, "");
  // Clean up excessive blank lines left after removal
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned.trim();
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
async function llmCall(messages: ChatMessage[], options: { tools?: any[]; model?: string; signal?: AbortSignal } = {}): Promise<any> {
  const { apiKey, model, apiUrl } = getApiConfig();
  if (!apiKey) throw new Error("API key not configured");

  const settings = getSettings();
  const body: any = {
    model: options.model || model,
    messages,
    temperature: settings.agentTemperature ?? 0.7,
    max_tokens: 81920,
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
    signal: options.signal,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API Error (${response.status}): ${error}`);
  }

  const json = await response.json();
  if (!json.choices?.length) {
    console.error(`[llmCall] API returned no choices. Response:`, JSON.stringify(json).slice(0, 2000));
    // Check if messages contain image content for debugging
    const hasImages = messages.some(m => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'));
    if (hasImages) console.error(`[llmCall] Request included images. Model may not support vision or format is wrong.`);
  }
  return json;
}

// Tool-calling loop (like Tiger_bot's runWithTools)
export async function callTigerBotWithTools(
  messages: ChatMessage[],
  systemPrompt?: string,
  onToolCall?: (name: string, args: any) => void,
  onToolResult?: (name: string, result: any) => void,
  signal?: AbortSignal
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

  const settings = getSettings();
  const maxToolRounds = settings.agentMaxToolRounds || 8;
  const maxToolCalls = settings.agentMaxToolCalls || 12;
  const toolResults: Array<{ tool: string; result: any }> = [];
  const toolCallHistory: string[] = [];
  let totalToolCalls = 0;
  let usesSkill = false; // Track if a skill was loaded (needs more tool calls)
  let consecutiveErrors = 0;
  let lastUsage: any = undefined;
  let earlyContent: string | null = null;

  for (let round = 0; round < maxToolRounds; round++) {
    if (signal?.aborted) {
      return { content: earlyContent || "Task was cancelled.", toolResults };
    }
    let data: any;
    try {
      data = await llmCall(allMessages, { tools: getTools(), signal });
    } catch (err: any) {
      if (err.name === "AbortError") {
        return { content: earlyContent || "Task was cancelled.", toolResults };
      }
      return { content: `Connection error: ${err.message}`, toolResults };
    }

    const choice = data.choices?.[0];
    if (!choice) {
      console.log(`[ToolLoop] No response from API at round ${round}. Full API response:`, JSON.stringify(data).slice(0, 1000));
      break;
    }

    const message = choice.message;
    const toolCalls = message.tool_calls || [];
    lastUsage = data.usage;

    // Add assistant message to context — truncate large tool_call args to prevent context overflow
    const truncatedToolCalls = toolCalls.length ? toolCalls.map((tc: any) => {
      const args = tc.function?.arguments || "";
      const argsStr = typeof args === "string" ? args : JSON.stringify(args);
      if (argsStr.length > 4000) {
        return { ...tc, function: { ...tc.function, arguments: argsStr.slice(0, 4000) + "..." } };
      }
      return tc;
    }) : undefined;
    allMessages.push({
      role: "assistant",
      content: message.content || "",
      tool_calls: truncatedToolCalls,
    });

    // If no tool calls, save the content and break to allow reflection check
    if (!toolCalls.length) {
      earlyContent = message.content || "No response generated.";
      break;
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
      // Check abort before each tool call
      if (signal?.aborted) {
        return { content: earlyContent || "Task was cancelled.", toolResults };
      }

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
                // Unescape JSON string escapes (\n, \t, \", \\)
                const codeValue = rawArgs.slice(valueStart, valueEnd)
                  .replace(/\\n/g, "\n")
                  .replace(/\\t/g, "\t")
                  .replace(/\\"/g, '"')
                  .replace(/\\\\/g, "\\");
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
      const baseMaxLen = settings.agentToolResultMaxLen || 6000;
      const maxLen = fnName === "load_skill" ? Math.min(3000, baseMaxLen) : baseMaxLen;
      if (resultStr.length > maxLen) {
        resultStr = resultStr.slice(0, maxLen) + "\n...(truncated)";
      }
      allMessages.push({
        role: "tool",
        content: resultStr,
        tool_call_id: tc.id,
      });

      // Check abort after tool completes
      if (signal?.aborted) {
        return { content: earlyContent || "Task was cancelled.", toolResults };
      }

      // Stop if too many consecutive errors (tool/command not available)
      const maxConsecutiveErrors = settings.agentMaxConsecutiveErrors || 3;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        console.log(`[ToolLoop] ${maxConsecutiveErrors} consecutive errors. Breaking.`);
        break;
      }

      // Hard stop at max tool calls
      if (totalToolCalls >= maxToolCalls) break;
    }

    if (totalToolCalls >= maxToolCalls || consecutiveErrors >= (settings.agentMaxConsecutiveErrors || 3)) break;
  }

  console.log(`[ToolLoop] Ended after ${totalToolCalls} tool calls.`);

  // If no tools were called and we have early content, return it directly (no reflection needed)
  if (earlyContent && totalToolCalls === 0) {
    console.log(`[ToolLoop] No tool calls made. Returning direct response.`);
    return { content: sanitizeToolCallContent(earlyContent), usage: lastUsage, toolResults };
  }

  // === Reflection Loop Check (optional — saves tokens when disabled) ===
  const reflectionEnabled = settings.agentReflectionEnabled ?? false;
  const evalThreshold = settings.agentEvalThreshold ?? 0.7;
  const maxReflectionRetries = settings.agentMaxReflectionRetries ?? 2;

  console.log(`[Reflection] Settings: enabled=${reflectionEnabled}, threshold=${evalThreshold}, maxRetries=${maxReflectionRetries}, toolCalls=${totalToolCalls}`);

  if (reflectionEnabled && totalToolCalls > 0) {
    try {
    // Extract the original user objective from messages
    const userObjective = allMessages
      .filter(m => m.role === "user")
      .map(m => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) return m.content.map((p: any) => p.text || "").join(" ");
        return "";
      })
      .join("\n");

    console.log(`[Reflection] User objective (first 200 chars): ${userObjective.slice(0, 200)}`);

    for (let retryRound = 0; retryRound < maxReflectionRetries; retryRound++) {
      console.log(`[Reflection] Round ${retryRound + 1}/${maxReflectionRetries} — evaluating objective satisfaction...`);

      // Build evaluation prompt
      const evalMessages: ChatMessage[] = [];
      if (systemPrompt) evalMessages.push({ role: "system", content: systemPrompt });

      const toolSummaryForEval = toolResults.map(tr => {
        const r = tr.result;
        if (r?.outputFiles?.length) return `[${tr.tool}] Generated: ${r.outputFiles.join(", ")}`;
        if (r?.ok === false) return `[${tr.tool}] Error: ${r.error || "failed"}`;
        if (r?.stdout) return `[${tr.tool}] ${r.stdout.slice(0, 300)}`;
        return `[${tr.tool}] ${JSON.stringify(r).slice(0, 300)}`;
      }).join("\n");

      evalMessages.push({
        role: "user",
        content: `You are an evaluation judge. Score how well the agent satisfied the user's objective.

USER OBJECTIVE:
${userObjective}

AGENT ACTIONS (${totalToolCalls} tool calls):
${toolSummaryForEval}

LAST ASSISTANT MESSAGE:
${allMessages.filter(m => m.role === "assistant").pop()?.content || "(none)"}

Respond in EXACTLY this JSON format (no other text):
{"score": <0.0-1.0>, "satisfied": <true/false>, "missing": "<what is missing or incomplete, empty string if satisfied>"}

Scoring guide:
- 1.0: Fully satisfied, all parts addressed
- 0.7-0.9: Mostly satisfied, minor gaps
- 0.4-0.6: Partially satisfied, significant gaps
- 0.0-0.3: Not satisfied, major parts missing`
      });

      try {
        const evalData = await llmCall(evalMessages);
        const evalContent = evalData.choices?.[0]?.message?.content || "";
        console.log(`[Reflection] Raw eval response: ${evalContent.slice(0, 300)}`);

        // Parse the evaluation JSON
        const jsonMatch = evalContent.match(/\{[\s\S]*?"score"[\s\S]*?\}/);
        if (!jsonMatch) {
          console.log("[Reflection] Could not parse eval JSON. Skipping reflection.");
          break;
        }

        const evalResult = JSON.parse(jsonMatch[0]);
        const score = parseFloat(evalResult.score) || 0;
        const satisfied = evalResult.satisfied === true;
        const missing = evalResult.missing || "";

        console.log(`[Reflection] Score: ${score}, Satisfied: ${satisfied}, Missing: ${missing.slice(0, 200)}`);

        // If score meets threshold, we're done
        if (score >= evalThreshold || satisfied) {
          console.log(`[Reflection] Score ${score} >= threshold ${evalThreshold}. Objective satisfied.`);
          break;
        }

        // Score below threshold — retry the main agent with guidance on what's missing
        console.log(`[Reflection] Score ${score} < threshold ${evalThreshold}. Re-entering agent loop to address gaps...`);

        allMessages.push({
          role: "system",
          content: `REFLECTION CHECK: Your work scored ${score}/1.0 (threshold: ${evalThreshold}). The evaluation found these gaps:\n${missing}\n\nPlease address what's missing to fully satisfy the user's objective. Use tools as needed.`
        });

        // Run additional tool rounds to address the gaps
        const retryMaxRounds = Math.min(maxToolRounds, 5);
        for (let round = 0; round < retryMaxRounds; round++) {
          let data: any;
          try {
            data = await llmCall(allMessages, { tools: getTools() });
          } catch (err: any) {
            console.error(`[Reflection retry] LLM call failed: ${err.message}`);
            break;
          }

          const choice = data.choices?.[0];
          if (!choice) break;

          const message = choice.message;
          const retryToolCalls = message.tool_calls || [];

          allMessages.push({
            role: "assistant",
            content: message.content || "",
            tool_calls: retryToolCalls.length ? retryToolCalls : undefined,
          });

          if (!retryToolCalls.length) break; // LLM done

          for (const tc of retryToolCalls) {
            const fnName = tc.function?.name || "";
            let fnArgs: any = {};
            try { fnArgs = JSON.parse(tc.function?.arguments || "{}"); } catch { fnArgs = {}; }
            if (onToolCall) onToolCall(fnName, fnArgs);
            let result: any;
            try { result = await callTool(fnName, fnArgs); } catch (err: any) { result = { ok: false, error: err.message }; }
            if (onToolResult) onToolResult(fnName, result);
            toolResults.push({ tool: fnName, result });
            totalToolCalls++;
            let resultStr = JSON.stringify(result);
            const maxLen = settings.agentToolResultMaxLen || 6000;
            if (resultStr.length > maxLen) resultStr = resultStr.slice(0, maxLen) + "\n...(truncated)";
            allMessages.push({ role: "tool", content: resultStr, tool_call_id: tc.id });
          }
        }
        // Loop back to re-evaluate
      } catch (err: any) {
        console.error(`[Reflection] Eval failed: ${err.message}`);
        break;
      }
    }
    } catch (outerErr: any) {
      console.error(`[Reflection] Unexpected error in reflection block: ${outerErr.message}`);
    }
  }

  // If agent finished naturally with content and reflection didn't trigger a retry, return early content
  if (earlyContent && !reflectionEnabled) {
    return { content: earlyContent, usage: lastUsage, toolResults };
  }

  console.log(`[ToolLoop] Final total: ${totalToolCalls} tool calls. Generating final response...`);

  // Check if user likely wanted output files but none were generated
  const hasOutputFiles = toolResults.some((tr) => tr.result?.outputFiles?.length > 0);
  const userWantsOutput = allMessages.some((m) => {
    if (m.role !== "user") return false;
    const text = typeof m.content === "string" ? m.content : m.content.map((p) => p.text || "").join(" ");
    return /\b(chart|graph|plot|report|analy[sz]|visual|diagram|figure)\b/i.test(text);
  });

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

  // Build a compact summary of tool results for the final response
  const toolSummary = toolResults.map((tr) => {
    let brief = "";
    try {
      const r = tr.result;
      if (r?.outputFiles?.length > 0) brief = `Generated: ${r.outputFiles.join(", ")}`;
      else if (r?.ok === false) brief = `Error: ${r.error || "failed"}`;
      else if (r?.stdout) brief = r.stdout.slice(0, 300);
      else if (typeof r === "string") brief = r.slice(0, 300);
      else brief = JSON.stringify(r).slice(0, 300);
    } catch { brief = "(result unavailable)"; }
    return `[${tr.tool}]: ${brief}`;
  }).join("\n");

  // Build a minimal message list for the final summary call to avoid context overflow
  // Keep: system prompt, user messages, and a compact summary — drop all tool call details
  const finalMessages: ChatMessage[] = [];
  for (const m of allMessages) {
    if (m.role === "system" && finalMessages.length === 0) {
      finalMessages.push(m); // keep system prompt
    } else if (m.role === "user") {
      finalMessages.push(m);
    }
  }
  finalMessages.push({
    role: "system",
    content: `You executed ${totalToolCalls} tool calls. Summary:\n${toolSummary}\n\nProvide a clear, helpful response to the user. Mention any generated files. Do NOT call tools. IMPORTANT: Do NOT include any internal tool call syntax, function names, parameter details, or markers like [web_search], [fetch_url], etc. in your response. The user should only see the final results, not the tools you used.`,
  });

  try {
    const data = await llmCall(finalMessages);
    const content = data.choices?.[0]?.message?.content || "";
    if (content) {
      return { content: sanitizeToolCallContent(content), usage: data.usage, toolResults };
    }
  } catch (err: any) {
    console.error("[FinalResponse] Failed to generate summary:", err.message);
  }

  // Absolute fallback: build a simple summary directly
  const outputFiles = toolResults.flatMap((tr) => tr.result?.outputFiles || []);
  const errors = toolResults.filter((tr) => tr.result?.exitCode === 1).map((tr) => tr.result?.stderr?.slice(0, 200) || "").filter(Boolean);
  const stdouts = toolResults.filter((tr) => tr.result?.stdout).map((tr) => tr.result.stdout.slice(0, 500));

  let fallback = "";
  if (outputFiles.length > 0) {
    fallback += `Generated ${outputFiles.length} file(s): ${outputFiles.join(", ")}\n\n`;
  }
  if (stdouts.length > 0) {
    fallback += stdouts.join("\n---\n").slice(0, 3000);
  }
  if (errors.length > 0) {
    fallback += `\n\nSome errors occurred:\n${errors.join("\n")}`;
  }

  return { content: sanitizeToolCallContent(fallback) || "Task completed. Check the output panel for results.", toolResults };
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
  const settings = getSettings();

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
        temperature: settings.agentTemperature ?? 0.7,
        max_tokens: 40960,
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
