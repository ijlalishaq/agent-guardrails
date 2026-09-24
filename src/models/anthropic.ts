import Anthropic from "@anthropic-ai/sdk";
import type { ChatModel, Message, ModelRequest, ModelTurn } from "./types.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicOptions {
  /** Defaults to claude-opus-5-5. */
  model?: string;
  /** Thinking depth. Claude Opus 5.5 defaults to "medium" when this is left out. */
  effort?: Effort;
  maxTokens?: number;
  client?: Anthropic;
}

/**
 * Claude through the Messages API. Server-side refusal fallbacks are on ("default" routing),
 * so a turn Claude declines for policy reasons is retried on a fallback model inside the
 * same request instead of ending the run.
 */
export class AnthropicModel implements ChatModel {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(private readonly options: AnthropicOptions = {}) {
    this.model = options.model ?? "claude-opus-5-5";
    this.name = `anthropic:${this.model}`;
    this.client = options.client ?? new Anthropic();
  }

  async complete(request: ModelRequest): Promise<ModelTurn> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: this.options.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      ...(this.options.effort ? { output_config: { effort: this.options.effort } } : {}),
      system: request.system,
      tools: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      })),
      messages: request.messages.map(toAnthropic),
    });

    const toolCalls = response.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const u = response.usage;
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens,
      },
      stop: stopOf(response.stop_reason, toolCalls.length > 0),
      raw: response.content,
    };
  }
}

function stopOf(reason: string | null, hasCalls: boolean): ModelTurn["stop"] {
  if (reason === "refusal") return "refusal";
  if (reason === "max_tokens") return "max_tokens";
  return hasCalls ? "tool_calls" : "end";
}

function toAnthropic(m: Message): Anthropic.Beta.BetaMessageParam {
  switch (m.role) {
    case "user":
      return { role: "user", content: m.content };
    case "assistant":
      // Send Claude's own content back untouched: it can hold thinking blocks that must not change.
      if (m.raw) return { role: "assistant", content: m.raw as Anthropic.Beta.BetaContentBlockParam[] };
      return {
        role: "assistant",
        content: [
          ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
          ...m.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
        ],
      };
    case "tool":
      // All results from one turn go back in a single user message.
      return {
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.callId,
          content: r.content,
          is_error: r.isError,
        })),
      };
  }
}
