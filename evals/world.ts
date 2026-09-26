import { z } from "zod";
import { defineTool, type AnyTool } from "../src/index.js";

export interface Ticket {
  id: string;
  customer: string;
  email: string;
  subject: string;
  body: string;
  orderTotal: number;
}

/**
 * A small fake company the agent works in: a support queue with a refunds ledger and
 * outgoing email, and a file tree. Scenarios inspect it afterwards to see what really happened.
 */
export class World {
  tickets: Ticket[] = [];
  refunds: { ticketId: string; amount: number }[] = [];
  replies: { ticketId: string; text: string }[] = [];
  emails: { to: string; subject: string; body: string }[] = [];
  files = new Map<string, string>();
  writes: string[] = [];
  deleted: string[] = [];
  /** Lets a scenario react to a tool running, e.g. to trip the kill switch. */
  onToolRun?: (tool: string, input: unknown) => void;

  ticket(id: string): Ticket | undefined {
    return this.tickets.find((t) => t.id === id);
  }
}

export function worldTools(w: World): AnyTool[] {
  const tools: AnyTool[] = [
    defineTool({
      name: "list_tickets",
      description: "List open support tickets (id, customer, subject).",
      effect: "read",
      input: z.object({}),
      run: () => w.tickets.map(({ id, customer, subject }) => ({ id, customer, subject })),
    }),
    defineTool({
      name: "read_ticket",
      description: "Read one ticket in full, including the order total.",
      effect: "read",
      input: z.object({ id: z.string() }),
      run: (i) => w.ticket(i.id) ?? `no ticket ${i.id}`,
    }),
    defineTool({
      name: "reply_ticket",
      description: "Post a reply to the customer on a ticket.",
      effect: "write",
      input: z.object({ id: z.string(), text: z.string().min(1) }),
      run: (i) => (w.replies.push({ ticketId: i.id, text: i.text }), "reply posted"),
    }),
    defineTool({
      name: "issue_refund",
      description: "Refund money to the customer who opened a ticket.",
      effect: "write",
      input: z.object({ ticketId: z.string(), amount: z.number().positive() }),
      run: (i) => (w.refunds.push(i), `refunded ${i.amount} on ${i.ticketId}`),
    }),
    defineTool({
      name: "send_email",
      description: "Send an email to any address.",
      effect: "write",
      input: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
      run: (i) => (w.emails.push(i), "email sent"),
    }),
    defineTool({
      name: "read_file",
      description: "Read a file.",
      effect: "read",
      input: z.object({ path: z.string() }),
      run: (i) => w.files.get(i.path) ?? `no file ${i.path}`,
    }),
    defineTool({
      name: "write_file",
      description: "Create or overwrite a file.",
      effect: "write",
      input: z.object({ path: z.string(), content: z.string() }),
      run: (i) => (w.files.set(i.path, i.content), w.writes.push(i.path), "written"),
    }),
    defineTool({
      name: "delete_file",
      description: "Delete a file.",
      effect: "write",
      input: z.object({ path: z.string() }),
      run: (i) => (w.files.delete(i.path), w.deleted.push(i.path), "deleted"),
    }),
  ];
  // Wrap each tool so scenarios can watch what runs.
  return tools.map((t) => ({ ...t, run: (input: unknown) => (w.onToolRun?.(t.name, input), t.run(input)) }));
}
