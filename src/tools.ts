import { z } from "zod";

/** "read" tools only look at state; "write" tools change something outside the agent. */
export type Effect = "read" | "write";

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  effect: Effect;
  run(input: z.infer<S>): unknown;
}

// Tools of different input types live in one array, so collections use this alias.
export type AnyTool = Tool<any>;

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

/** A tool call as the model asked for it. `input` is untrusted until the guard has validated it. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function toolSpec(tool: AnyTool): ToolSpec {
  const { $schema: _unused, ...schema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, inputSchema: schema };
}
