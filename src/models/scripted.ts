import type { ChatModel, Message, ModelRequest, ModelTurn, ToolResult } from "./types.js";

export interface ScriptStep {
  say?: string;
  call?: { name: string; input: unknown }[];
}

/** A step can depend on what the last tool calls returned, e.g. to act on a ticket it just read. */
export type ScriptEntry = ScriptStep | ((lastResults: ToolResult[]) => ScriptStep);

const approxTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Plays a fixed script instead of calling a model, so tests and evals run offline and give
 * the same answer every time. Scripts can misbehave on purpose: ask for tools outside the
 * task, pass bad arguments, follow an injected instruction, or loop forever.
 */
export class ScriptedModel implements ChatModel {
  readonly name = "scripted";
  private calls = 0;

  constructor(
    private readonly script: ScriptEntry[],
    private readonly options: { loopLast?: boolean } = {},
  ) {}

  async complete(request: ModelRequest): Promise<ModelTurn> {
    const i = this.options.loopLast ? Math.min(this.calls, this.script.length - 1) : this.calls;
    const entry = this.script[i];
    const turn = this.calls++;
    const lastTool = [...request.messages].reverse().find((m): m is Extract<Message, { role: "tool" }> => m.role === "tool");
    const step = typeof entry === "function" ? entry(lastTool?.results ?? []) : (entry ?? { say: "Done." });

    const toolCalls = (step.call ?? []).map((c, j) => ({ id: `call_${turn}_${j}`, name: c.name, input: c.input }));
    const prompt = request.system + JSON.stringify(request.messages);
    const text = step.say ?? "";
    return {
      text,
      toolCalls,
      usage: { inputTokens: approxTokens(prompt), outputTokens: approxTokens(text + JSON.stringify(step.call ?? [])) },
      stop: toolCalls.length ? "tool_calls" : "end",
    };
  }
}
