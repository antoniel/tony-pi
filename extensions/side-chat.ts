import {
  getDocsPath,
  RpcClient,
  SessionManager,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const SIDE_CHILD_ENV = "PI_SIDE_CHAT_CHILD";
const SIDE_WIDTH = "38%";
const MIN_TERMINAL_WIDTH = 80;
const MAX_MESSAGE_CHARS = 8_000;

type RpcEvent = Record<string, any>;

type SideController = {
  client: RpcClient;
  panel: SideChatPanel;
  handle?: OverlayHandle;
  done?: () => void;
  unsubscribe?: () => void;
  closing: boolean;
};

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("");
}

function preview(value: string, limit = MAX_MESSAGE_CHARS): string {
  const normalized = value.trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function formatStoredMessage(message: any): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  if (message.role === "user") {
    const text = preview(textContent(message.content));
    return text ? `You: ${text}` : undefined;
  }
  if (message.role === "assistant") {
    const text = preview(textContent(message.content));
    return text ? `Side: ${text}` : undefined;
  }
  if (message.role === "toolResult") {
    return `✓ ${message.toolName ?? "tool"}`;
  }
  if (message.role === "bashExecution") return `✓ ${message.command ?? "bash"}`;
  if (message.role === "custom" && message.display) {
    const text = preview(textContent(message.content));
    return text || undefined;
  }
  return undefined;
}

function entrySummary(entry: any, depth: number): string {
  const indent = "  ".repeat(Math.min(depth, 6));
  if (entry?.type === "message") {
    const role = entry.message?.role ?? "message";
    const text = preview(textContent(entry.message?.content), 70).replace(/\s+/g, " ");
    return `${indent}${role}: ${text || entry.id}`;
  }
  return `${indent}${entry?.type ?? "entry"}: ${entry?.id ?? "unknown"}`;
}

function flattenTree(nodes: any[], depth = 0, out: Array<{ id: string; label: string }> = []) {
  for (const node of nodes ?? []) {
    const entry = node?.entry;
    if (entry?.id) out.push({ id: entry.id, label: entrySummary(entry, depth) });
    flattenTree(node?.children ?? [], depth + 1, out);
  }
  return out;
}

function padLine(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

class SideChatPanel implements Component, Focusable {
  private readonly input = new Input();
  private readonly transcript: string[] = [];
  private streamingText = "";
  private status = "Starting…";
  private model = "";
  private _focused = true;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly submit: (value: string) => void,
    private readonly abort: () => void,
    private readonly releaseFocus: () => void,
  ) {
    this.input.focused = true;
    this.input.onSubmit = (value) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue("");
      this.submit(text);
      this.tui.requestRender();
    };
    this.input.onEscape = () => this.abort();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
    this.invalidate();
    this.tui.requestRender();
  }

  requestRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  isWorking(): boolean {
    return this.status === "Working…" || this.status === "Sending…";
  }

  setHydrated(messages: any[]): void {
    this.transcript.length = 0;
    for (const message of messages) {
      const line = formatStoredMessage(message);
      if (line) this.transcript.push(line);
    }
    this.requestRender();
  }

  setModel(model: any): void {
    this.model = model ? `${model.provider}/${model.id}` : "";
    this.requestRender();
  }

  setStatus(status: string): void {
    this.status = status;
    this.requestRender();
  }

  append(line: string): void {
    const value = preview(line);
    if (!value) return;
    this.transcript.push(value);
    if (this.transcript.length > 300) this.transcript.splice(0, this.transcript.length - 300);
    this.requestRender();
  }

  startAssistant(): void {
    this.streamingText = "";
    this.requestRender();
  }

  appendAssistantDelta(delta: string): void {
    this.streamingText += delta;
    if (this.streamingText.length > MAX_MESSAGE_CHARS) {
      this.streamingText = this.streamingText.slice(-MAX_MESSAGE_CHARS);
    }
    this.requestRender();
  }

  finishAssistant(message: any): void {
    const text = preview(textContent(message?.content));
    if (text) this.transcript.push(`Side: ${text}`);
    this.streamingText = "";
    this.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+/")) {
      this.releaseFocus();
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 4) return [];
    const inner = width - 2;
    const borderColor = this._focused ? "borderAccent" : "borderMuted";
    const border = (value: string) => this.theme.fg(borderColor, value);
    const lines: string[] = [];
    const push = (value = "") => lines.push(`${border("│")}${padLine(value, inner)}${border("│")}`);

    const title = this.theme.bold(this.theme.fg("accent", "SIDE"));
    const focus = this._focused ? this.theme.fg("success", " focused") : this.theme.fg("dim", " Ctrl+/ to focus");
    lines.push(border(`┌${"─".repeat(inner)}┐`));
    push(`${title}${focus}`);
    if (this.model) push(this.theme.fg("dim", this.model));
    push();

    const source = [...this.transcript];
    if (this.streamingText) source.push(`Side: ${this.streamingText}`);
    const visual: string[] = [];
    for (const message of source) {
      const color = message.startsWith("You:")
        ? "text"
        : message.startsWith("Side:")
          ? "accent"
          : "muted";
      visual.push(...wrapTextWithAnsi(this.theme.fg(color, message), inner));
      visual.push("");
    }
    const maxTranscriptRows = Math.max(4, this.tui.terminal.rows - 10 - (this.model ? 1 : 0));
    for (const line of visual.slice(-maxTranscriptRows)) push(line);
    while (lines.length < Math.min(this.tui.terminal.rows - 4, 8)) push();

    push(this.theme.fg("dim", this.status));
    const inputLines = this.input.render(Math.max(1, inner - 2));
    push(`${this.theme.fg("accent", "> ")}${inputLines[0] ?? ""}`);
    lines.push(border(`└${"─".repeat(inner)}┘`));
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

export default function sideChatExtension(pi: ExtensionAPI): void {
  if (process.env[SIDE_CHILD_ENV] === "1") return;

  let active: SideController | undefined;

  const requestRender = () => active?.panel.requestRender();

  const stopSide = async (): Promise<void> => {
    const controller = active;
    if (!controller || controller.closing) return;
    controller.closing = true;
    active = undefined;
    controller.unsubscribe?.();
    try {
      await controller.client.abort();
    } catch {}
    try {
      await controller.client.stop();
    } catch {}
    controller.done?.();
  };

  const handleRpcEvent = (event: RpcEvent, controller: SideController): void => {
    if (active !== controller) return;
    const panel = controller.panel;
    switch (event.type) {
      case "agent_start":
        panel.setStatus("Working…");
        break;
      case "agent_settled":
        panel.setStatus("Ready");
        break;
      case "message_start":
        if (event.message?.role === "assistant") panel.startAssistant();
        if (event.message?.role === "user") {
          const line = formatStoredMessage(event.message);
          if (line) panel.append(line);
        }
        break;
      case "message_update":
        if (event.assistantMessageEvent?.type === "text_delta") {
          panel.appendAssistantDelta(String(event.assistantMessageEvent.delta ?? ""));
        }
        break;
      case "message_end":
        if (event.message?.role === "assistant") panel.finishAssistant(event.message);
        break;
      case "tool_execution_start": {
        const intent = event.args?.intent;
        panel.append(`› ${typeof intent === "string" && intent.trim() ? intent.trim() : event.toolName}`);
        break;
      }
      case "tool_execution_end":
        panel.append(`${event.isError ? "✗" : "✓"} ${event.toolName}`);
        break;
      case "extension_error":
        panel.append("✗ Side extension error");
        break;
    }
    requestRender();
  };

  const selectTreeEntry = async (ctx: any): Promise<string | undefined> => {
    const choices = flattenTree(ctx.sessionManager.getTree());
    if (choices.length === 0) {
      ctx.ui.notify("The current session tree is empty", "warning");
      return undefined;
    }
    const labels = choices.map((choice, index) => `${index + 1}. ${choice.label}`);
    const selected = await ctx.ui.select("Open side chat from:", labels);
    if (!selected) return undefined;
    const index = labels.indexOf(selected);
    return index >= 0 ? choices[index]?.id : undefined;
  };

  const openSide = async (ctx: any, entryId: string): Promise<void> => {
    if (active) {
      active.handle?.focus();
      ctx.ui.notify("Side chat is already open", "info");
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/side requires interactive mode", "error");
      return;
    }
    if ((process.stdout.columns ?? 0) < MIN_TERMINAL_WIDTH) {
      ctx.ui.notify(`Side chat requires at least ${MIN_TERMINAL_WIDTH} columns`, "warning");
      return;
    }

    const currentFile = ctx.sessionManager.getSessionFile();
    if (!currentFile || !existsSync(currentFile)) {
      ctx.ui.notify("Wait for the current session to be persisted before opening /side", "warning");
      return;
    }

    let forkPath: string | undefined;
    try {
      const copy = SessionManager.open(currentFile, ctx.sessionManager.getSessionDir());
      forkPath = copy.createBranchedSession(entryId);
    } catch (error) {
      ctx.ui.notify(`Could not create side fork: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    if (!forkPath || !existsSync(forkPath)) {
      ctx.ui.notify("The side fork could not be persisted", "error");
      return;
    }

    const cliPath = resolve(getDocsPath(), "../dist/cli.js");
    const client = new RpcClient({
      cliPath,
      cwd: ctx.cwd,
      env: { [SIDE_CHILD_ENV]: "1" },
      args: ["--session", forkPath],
    });

    let controller: SideController;
    let panel!: SideChatPanel;
    try {
      await client.start();
      const overlayPromise = ctx.ui.custom<void>(
        (tui: TUI, theme: Theme, _keybindings: unknown, done: () => void) => {
          const releaseFocus = () => controller.handle?.unfocus();
          panel = new SideChatPanel(
            tui,
            theme,
            (value) => {
              const send = panel.isWorking() ? client.steer(value) : client.prompt(value);
              panel.setStatus(panel.isWorking() ? "Working…" : "Sending…");
              void send.catch((error) => {
                panel.append(`✗ ${error instanceof Error ? error.message : String(error)}`);
                panel.setStatus("Unavailable");
              });
            },
            () => {
              void client.abort().catch(() => {});
              panel.setStatus("Aborting…");
              tui.requestRender();
            },
            releaseFocus,
          );
          controller = { client, panel, done, closing: false };
          active = controller;
          return panel;
        },
        {
          overlay: true,
          overlayOptions: {
            width: SIDE_WIDTH,
            minWidth: 36,
            maxHeight: "100%",
            anchor: "right-center",
            margin: 0,
            visible: (width: number) => width >= MIN_TERMINAL_WIDTH,
          },
          onHandle: (handle: OverlayHandle) => {
            if (!active) return;
            active.handle = handle;
          },
        },
      );

      controller = active!;
      controller.unsubscribe = client.onEvent((event) => handleRpcEvent(event as RpcEvent, controller));
      const childProcess = (client as any).process;
      childProcess?.once?.("exit", () => {
        if (active !== controller || controller.closing) return;
        panel.append("✗ Side agent exited");
        panel.setStatus("Unavailable");
      });
      const [messages, state] = await Promise.all([client.getMessages(), client.getState()]);
      if (active !== controller) return;
      panel.setHydrated(messages);
      panel.setModel(state.model);
      panel.setStatus(state.isStreaming ? "Working…" : "Ready");
      controller.handle?.focus();
      void overlayPromise.finally(() => {
        if (active === controller) void stopSide();
      });
    } catch (error) {
      try {
        await client.stop();
      } catch {}
      if (active?.client === client) active = undefined;
      ctx.ui.notify(`Could not start side chat: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  pi.registerCommand("side", {
    description: "Open a forked side chat; use /side tree or /side close",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "close") {
        if (!active) {
          ctx.ui.notify("No side chat is open", "info");
          return;
        }
        await stopSide();
        ctx.ui.notify("Side chat closed", "info");
        return;
      }
      if (action && action !== "tree") {
        ctx.ui.notify("Usage: /side, /side tree, or /side close", "warning");
        return;
      }
      if (active) {
        active.handle?.focus();
        ctx.ui.notify("Side chat is already open", "info");
        return;
      }

      await ctx.waitForIdle();
      const entryId = action === "tree" ? await selectTreeEntry(ctx) : ctx.sessionManager.getLeafId();
      if (!entryId) {
        ctx.ui.notify("The current session has no fork point", "warning");
        return;
      }
      await openSide(ctx, entryId);
    },
  });

  pi.registerShortcut("ctrl+/", {
    description: "Toggle focus between main and side chat",
    handler(ctx) {
      if (!active?.handle) {
        ctx.ui.notify("Open /side first", "info");
        return;
      }
      if (active.handle.isFocused()) active.handle.unfocus();
      else active.handle.focus();
    },
  });

  for (const event of ["session_before_switch", "session_before_fork", "session_shutdown"] as const) {
    pi.on(event, () => {
      void stopSide();
    });
  }
}

// Extension overlays cannot reflow Pi's main transcript. This MVP intentionally
// covers the right 38%; a true split requires a core InteractiveMode layout API.
