import { getSettings } from "./data";
import { tools, callTool } from "./toolbox";

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
    max_tokens: 4096,
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
  const toolResults: Array<{ tool: string; result: any }> = [];

  for (let round = 0; round < maxToolRounds; round++) {
    let data: any;
    try {
      data = await llmCall(allMessages, { tools });
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

    // If no tool calls, we're done
    if (!toolCalls.length) {
      return {
        content: message.content || "No response generated.",
        usage: data.usage,
        toolResults,
      };
    }

    // Execute each tool call
    for (const tc of toolCalls) {
      const fnName = tc.function?.name || "";
      let fnArgs: any = {};
      const rawArgs = tc.function?.arguments || "{}";
      // Some APIs return arguments as an object already, not a string
      if (typeof rawArgs === "object" && rawArgs !== null) {
        fnArgs = rawArgs;
      } else try {
        fnArgs = JSON.parse(rawArgs);
      } catch (parseErr: any) {
        console.error(`[Tool ${fnName}] JSON parse failed:`, parseErr.message);
        console.error(`[Tool ${fnName}] Raw args (first 500):`, rawArgs.slice(0, 500));
        // For code tools, the AI often sends unescaped code in JSON
        // Try to extract the code value manually
        if (fnName === "run_react" || fnName === "run_python") {
          const codeKey = rawArgs.indexOf('"code"');
          if (codeKey !== -1) {
            // Find the start of the code value after "code": "
            const valueStart = rawArgs.indexOf('"', codeKey + 6) + 1;
            if (valueStart > 0) {
              // Find the closing pattern: look for ", " or "} at end
              let valueEnd = rawArgs.lastIndexOf('"');
              // Walk back past any trailing keys like "title", "dependencies"
              const trailingKeys = ['"title"', '"dependencies"'];
              for (const tk of trailingKeys) {
                const tkPos = rawArgs.lastIndexOf(tk);
                if (tkPos > valueStart) {
                  // Find the comma before this key
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
                // Try to also extract title
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

      console.log(`[Tool ${fnName}] Parsed args keys:`, Object.keys(fnArgs), fnArgs.code ? `code length: ${fnArgs.code.length}` : "NO CODE");

      if (onToolCall) onToolCall(fnName, fnArgs);

      let result: any;
      try {
        result = await callTool(fnName, fnArgs);
      } catch (err: any) {
        result = { ok: false, error: err.message };
      }

      if (onToolResult) onToolResult(fnName, result);
      toolResults.push({ tool: fnName, result });

      // Add tool result to context
      allMessages.push({
        role: "tool",
        content: JSON.stringify(result),
        tool_call_id: tc.id,
      });
    }
  }

  // If we exhaust tool rounds, do a final call without tools
  try {
    const data = await llmCall(allMessages);
    const content = data.choices?.[0]?.message?.content || "";
    return { content: content || "Reached tool limit. Here are the results so far.", usage: data.usage, toolResults };
  } catch (err: any) {
    return { content: `Error in final response: ${err.message}`, toolResults };
  }
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
