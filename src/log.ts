import * as vscode from 'vscode';
import type { Logger } from './core/logger';

/** Logger backed by a VS Code LogOutputChannel ("HyperJest" in the Output panel). */
export class OutputLogger implements Logger {
  readonly channel: vscode.LogOutputChannel;

  constructor(name = 'HyperJest') {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  trace(msg: string, ...args: unknown[]): void { this.channel.trace(msg, ...args); }
  debug(msg: string, ...args: unknown[]): void { this.channel.debug(msg, ...args); }
  info(msg: string, ...args: unknown[]): void { this.channel.info(msg, ...args); }
  warn(msg: string, ...args: unknown[]): void { this.channel.warn(msg, ...args); }
  error(msg: string | Error, ...args: unknown[]): void { this.channel.error(msg, ...args); }

  show(): void { this.channel.show(true); }
  dispose(): void { this.channel.dispose(); }
}
