import type { ChatModel, Message, ModelRequest, ModelTurn } from "./types.js";

export interface OpenAICompatibleOptions {
  model: string;
  /** e.g. https://api.openai.com/v1, or http://localhost:11434/v1 for Ollama. */
  baseUrl: string;
  apiKey?: string;
  /** Label for reports and pricing, e.g. "openai" or "ollama". */
  provider: string;
}

interface ChatCompletion {
  choices: {
    finish_reason: string;
    message: {
      content: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Any server that speaks the Chat Completions format: OpenAI itself, Ollama, vLLM,
 * LM Studio. Plain fetch, so there's no SDK to install for it.
 */
export class OpenAICompatibleModel implements ChatModel {
  readonly name: string;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.name = `${options.provider}:${options.model}`;
  }

  async complete(request: ModelRequest): Promise<ModelTurn> {
    const res = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [{ role: "system", content: request.system }, ...request.messages.flatMap(toChat)],
        tools: request.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
    });
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as ChatCompletion;
    const choice = body.choices[0];
    if (!choice) throw new Error(`${this.name}: response has no choices`);

    const toolCalls = (choice.message.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      // Malformed JSON is passed on as a string; the guard's schema check rejects it.
      input: parseJson(c.function.arguments),
    }));
    return {
      text: choice.message.content ?? "",
      toolCalls,
      usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 },
      stop: choice.finish_reason === "length" ? "max_tokens" : toolCalls.length ? "tool_calls" : "end",
    };
  }
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function toChat(m: Message): object[] {
  switch (m.role) {
    case "user":
      return [{ role: "user", content: m.content }];
    case "assistant":
      return [
        {
          role: "assistant",
          content: m.text || null,
          ...(m.toolCalls.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: JSON.stringify(c.input) },
                })),
              }
            : {}),
        },
      ];
    case "tool":
      return m.results.map((r) => ({ role: "tool", tool_call_id: r.callId, content: r.content }));
  }
}
