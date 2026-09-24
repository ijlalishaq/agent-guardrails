import type { ToolCall, ToolSpec } from "../tools.js";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError: boolean;
}

/**
 * Provider-neutral conversation. Assistant turns keep the provider's own response in `raw`
 * so it can be sent back unchanged (Claude, for one, needs its thinking blocks back as-is).
 */
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: ToolResult[] };

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stop: "tool_calls" | "end" | "max_tokens" | "refusal";
  raw?: unknown;
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
}

export interface ChatModel {
  /** "provider:model", used for pricing and in reports. */
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelTurn>;
}
