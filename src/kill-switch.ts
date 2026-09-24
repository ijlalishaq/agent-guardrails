import { existsSync } from "node:fs";

/**
 * Stops a run before its next model or tool call. Trip it from code, or point it at a file
 * so anyone with shell access can stop every agent watching it with `touch STOP`.
 */
export class KillSwitch {
  private reason: string | null = null;

  constructor(private readonly stopFile?: string) {}

  trip(reason: string): void {
    this.reason = reason;
  }

  /** The reason the switch was tripped, or null while runs may continue. */
  check(): string | null {
    if (this.reason) return this.reason;
    if (this.stopFile && existsSync(this.stopFile)) return `stop file ${this.stopFile} exists`;
    return null;
  }
}
