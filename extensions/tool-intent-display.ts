import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/**
 * Compact transcript with a single rolling window ("ring") over thinking runs
 * and tool calls.
 *
 * - The window keeps at most `windowSize` items (default 8), counting thinking
 *   runs and tool calls together, in transcript order. Older items are omitted
 *   from the transcript, not deleted from the session.
 * - User messages and assistant text are never counted and stay visible.
 * - Detail levels cycle with ctrl+o: intent -> normal -> extended.
 * - ctrl+shift+e toggles the full trace (nothing omitted).
 * - /ring <n> | all | off changes the window size or the expansion.
 *
 * Tool rows are hidden through normal renderers (`renderShell: "self"` + empty
 * component). Collapsed thinking runs are plain Text inside pi's
 * AssistantMessageComponent, so they need the companion patch applied by
 * `~/.pi/agent/scripts/reapply-ring-patch.sh`, which makes that component
 * consult `globalThis.__piThinkingRing`. Without the patch this extension still
 * rings tool calls; thinking simply stays visible.
 */

type DetailLevel = 0 | 1 | 2;
type AnyRecord = Record<string, unknown>;
type RingItem =
  | { kind: "thinking"; key: string }
  | { kind: "tool"; key: string; toolId: string };

const LEVEL_LABELS = ["intent", "normal", "extended"] as const;
const CALL_COMPONENT = Symbol("intentCallComponent");
const RESULT_COMPONENT = Symbol("intentResultComponent");
const BODY_CONTAINER = Symbol("intentBodyContainer");
const DEFAULT_WINDOW = 8;
const INTENT_DESCRIPTION = `Write a terse activity label for this exact tool call.

Style:
- Start with a strong verb and name the concrete target.
- Prefer 3-9 words and at most 80 characters.
- Describe only the immediate action, not the broader plan or rationale.
- Do not write "I will", "Let me", "in order to", tool names, hidden reasoning, filler, or ending punctuation.

Good examples:
- Read the DSN rewrite function
- Add the container-to-host DSN rewrite
- Check Python and uv versions
- List Dagster Python files
- Inspect exit code conventions
- Check port 4200 availability
- Create Prefect configuration
- Verify Prefect flow parameters

Bad examples:
- I will read the function to understand how it works
- Use bash to check the versions because this is needed
- Investigating the project files and deciding what to do next`;

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : {};
}

function withoutIntent(value: unknown): AnyRecord {
  const { intent: _intent, ...args } = asRecord(value);
  return args;
}

// Models misspell the key ("inputent", "intnet", "Intent") and the call fails
// validation before it runs: 31 lost calls in 10 tonyseq sessions. The label
// is display only, so accept close variants and fall back to a generic label
// instead of rejecting the call.
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

// A key the tool itself declares is never an alias, however close it looks.
function isIntentAlias(key: string, toolKeys: Set<string>): boolean {
  if (key === "intent" || toolKeys.has(key)) return false;
  const k = key.toLowerCase();
  return k.includes("intent") || editDistance(k, "intent") <= 2 || /^in[a-z]{0,4}ent$/.test(k);
}

function normalizeIntent(value: unknown, label: string, toolKeys: Set<string>): AnyRecord {
  const input = asRecord(value);
  const out: AnyRecord = {};
  let alias: unknown;
  for (const [key, v] of Object.entries(input)) {
    if (isIntentAlias(key, toolKeys)) alias ??= v;
    else out[key] = v;
  }
  const raw = typeof input.intent === "string" && input.intent.trim() ? input.intent : alias;
  const intent = intentFrom({ intent: raw }, label);
  out.intent = intent.length > 80 ? intent.slice(0, 80) : intent;
  return out;
}

function intentFrom(value: unknown, label: string): string {
  const intent = asRecord(value).intent;
  if (typeof intent === "string" && intent.trim()) return intent.trim();

  const fallbacks: Record<string, string> = {
    read: "Read requested file",
    bash: "Run requested command",
    edit: "Edit requested file",
    write: "Write requested file",
    grep: "Search file contents",
    find: "Find matching files",
    ls: "List directory contents",
  };
  return fallbacks[label.toLowerCase()] ?? `Run ${label} operation`;
}

function rawResultText(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export default function (pi: ExtensionAPI): void {
  let detailLevel: DetailLevel = 0;
  let windowSize = DEFAULT_WINDOW;
  let ringExpanded = false;

  // Ordered ring items (thinking runs + tool calls) and their positions.
  let ringItems: RingItem[] = [];
  const positionByKey = new Map<string, number>();
  // Latest invalidate callback and last rendered visibility for each tool row.
  const toolRows = new Map<string, { invalidate: () => void; visible: boolean }>();
  let sessionManager: any;

  function thinkingKey(message: any, runIndex: number): string {
    const stamp = message && typeof message.timestamp === "number" ? message.timestamp : "?";
    return `th:${stamp}:${runIndex}`;
  }

  function toolKey(toolCallId: string): string {
    return `tool:${toolCallId}`;
  }

  // Registry consumed by the patched AssistantMessageComponent.
  const registry = {
    rev: 1,
    isHidden(message: any, runIndex: number): boolean {
      if (ringExpanded) return false;
      const position = positionByKey.get(thinkingKey(message, runIndex));
      if (position === undefined) return false;
      return ringItems.length - position > windowSize;
    },
    hasVisibleThinking(message: any): boolean {
      if (!message || !Array.isArray(message.content)) return false;
      const content = message.content;
      let runIndex = 0;
      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (!block || block.type !== "thinking") continue;
        let nonEmpty = false;
        for (; i < content.length; i++) {
          const thinking = content[i];
          if (!thinking || thinking.type !== "thinking") break;
          if (typeof thinking.thinking === "string" && thinking.thinking.trim()) nonEmpty = true;
        }
        i--;
        if (!nonEmpty) continue;
        if (!registry.isHidden(message, runIndex)) return true;
        runIndex++;
      }
      return false;
    },
  };
  (globalThis as any).__piThinkingRing = registry;

  function resetRing(): void {
    ringItems = [];
    positionByKey.clear();
    toolRows.clear();
    registry.rev++;
  }

  function pushItem(item: RingItem): void {
    if (positionByKey.has(item.key)) return;
    positionByKey.set(item.key, ringItems.length);
    ringItems.push(item);
  }

  function appendAssistantItems(message: any): void {
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
    const content = message.content;

    // Thinking runs render inside the assistant message component, before the
    // tool rows of the same message. Group consecutive thinking blocks exactly
    // like the component does: one run per sequence of non-empty blocks.
    let runIndex = 0;
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (!block || block.type !== "thinking") continue;
      let nonEmpty = false;
      for (; i < content.length; i++) {
        const thinking = content[i];
        if (!thinking || thinking.type !== "thinking") break;
        if (typeof thinking.thinking === "string" && thinking.thinking.trim()) nonEmpty = true;
      }
      i--;
      if (!nonEmpty) continue;
      pushItem({ kind: "thinking", key: thinkingKey(message, runIndex) });
      runIndex++;
    }

    for (const block of content) {
      if (block && block.type === "toolCall" && typeof block.id === "string") {
        pushItem({ kind: "tool", key: toolKey(block.id), toolId: block.id });
      }
    }
  }

  function rebuildOrder(): void {
    ringItems = [];
    positionByKey.clear();
    let entries: any[] = [];
    try {
      entries = sessionManager?.buildContextEntries?.() ?? [];
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry && entry.type === "message" && entry.message?.role === "assistant") {
        appendAssistantItems(entry.message);
      }
    }
  }

  function isToolVisible(toolCallId: string): boolean {
    if (ringExpanded) return true;
    const position = positionByKey.get(toolKey(toolCallId));
    if (position === undefined) return true;
    return ringItems.length - position <= windowSize;
  }

  function trackTool(toolCallId: string, invalidate: () => void): boolean {
    const visible = isToolVisible(toolCallId);
    toolRows.set(toolCallId, { invalidate, visible });
    return visible;
  }

  function syncToolVisibility(): void {
    for (const [toolCallId, row] of [...toolRows]) {
      if (row.visible !== isToolVisible(toolCallId)) row.invalidate();
    }
  }

  function refresh(): void {
    // Bumping rev makes the patched AssistantMessageComponent re-evaluate
    // thinking visibility on its next render.
    registry.rev++;
    syncToolVisibility();
  }

  function invalidateAllTools(): void {
    for (const row of [...toolRows.values()]) row.invalidate();
  }

  pi.on("session_start", (_event, ctx) => {
    sessionManager = ctx.sessionManager;
    resetRing();
    rebuildOrder();
    refresh();
  });
  pi.on("session_tree", (_event, ctx) => {
    sessionManager = ctx.sessionManager;
    resetRing();
    rebuildOrder();
    refresh();
  });
  pi.on("session_before_tree", () => resetRing());
  pi.on("session_compact", (_event, ctx) => {
    sessionManager = ctx.sessionManager;
    resetRing();
    rebuildOrder();
    refresh();
  });
  pi.on("message_end", (event, ctx) => {
    sessionManager = ctx.sessionManager;
    const message = event.message as any;
    if (message?.role === "assistant") {
      appendAssistantItems(message);
      refresh();
    }
  });
  pi.on("session_shutdown", () => {
    resetRing();
    (globalThis as any).__piThinkingRing = undefined;
  });

  pi.registerShortcut("ctrl+o", {
    description: "Cycle tool display: intent, normal, extended",
    handler(ctx) {
      detailLevel = ((detailLevel + 1) % 3) as DetailLevel;

      // Keep Pi's canonical expansion state aligned so headers, summaries,
      // third-party tools, and renderer key hints continue to behave normally.
      const targetExpanded = detailLevel === 2;
      const wasExpanded = ctx.ui.getToolsExpanded();
      ctx.ui.setToolsExpanded(targetExpanded);

      // setToolsExpanded redraws only when its boolean changes. intent ->
      // normal keeps it collapsed, so redraw our wrapped rows explicitly.
      if (wasExpanded === targetExpanded) invalidateAllTools();

      ctx.ui.notify(`Tool display: ${LEVEL_LABELS[detailLevel]}`, "info");
    },
  });

  pi.registerShortcut("ctrl+shift+e", {
    description: "Toggle full transcript (thinking + tool calls) instead of the ring",
    handler(ctx) {
      ringExpanded = !ringExpanded;
      refresh();
      ctx.ui.notify(
        ringExpanded
          ? "Transcript: full (nothing omitted)"
          : `Transcript: last ${windowSize} item${windowSize === 1 ? "" : "s"} (thinking + tools)`,
        "info",
      );
    },
  });

  pi.registerCommand("ring", {
    description: "Set the transcript ring size: /ring <n>, /ring all, /ring off",
    getArgumentCompletions(prefix) {
      const options = ["all", "off", "2", "3", "4", "5", "6", "8", "10"];
      const filtered = options.filter((option) => option.startsWith(prefix));
      return filtered.map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      const arg = args.trim().toLowerCase();

      if (!arg) {
        ctx.ui.notify(
          `Transcript ring: last ${windowSize} visible${ringExpanded ? " (full transcript)" : ""}`,
          "info",
        );
        return;
      }

      if (arg === "all" || arg === "expand") {
        ringExpanded = true;
      } else if (arg === "off" || arg === "collapse") {
        ringExpanded = false;
      } else {
        const next = Number.parseInt(arg, 10);
        if (!Number.isFinite(next) || next < 0) {
          ctx.ui.notify("Usage: /ring <n> | all | off", "error");
          return;
        }
        windowSize = next;
        ringExpanded = false;
      }

      refresh();
      ctx.ui.notify(
        ringExpanded
          ? "Transcript: full (nothing omitted)"
          : `Transcript: last ${windowSize} item${windowSize === 1 ? "" : "s"} (thinking + tools)`,
        "info",
      );
    },
  });

  function registerWithIntent(base: ToolDefinition<any, any, any>): void {
    const basePrepare = base.prepareArguments;
    const baseRenderCall = base.renderCall;
    const baseRenderResult = base.renderResult;
    const baseProperties = asRecord(base.parameters).properties as AnyRecord | undefined;
    const baseSelfShell = base.renderShell === "self";
    const toolKeys = new Set(Object.keys(baseProperties ?? {}));

    if (!baseProperties) {
      throw new Error(`Cannot add intent to non-object tool schema: ${base.name}`);
    }

    pi.registerTool({
      ...base,
      renderShell: "self",
      description: `${base.description}\n\nThe intent parameter is required. Write it as a terse verb-first activity label naming the concrete target; do not explain why.`,
      parameters: Type.Object({
        intent: Type.String({
          description: INTENT_DESCRIPTION,
          minLength: 1,
          maxLength: 80,
        }),
        ...baseProperties,
      }),

      prepareArguments(args: unknown) {
        const input = normalizeIntent(args, base.name, toolKeys);
        const prepared = basePrepare ? basePrepare(withoutIntent(input)) : withoutIntent(input);
        return { ...asRecord(prepared), intent: input.intent } as any;
      },

      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return base.execute(toolCallId, withoutIntent(params) as any, signal, onUpdate, ctx);
      },

      renderCall(args, theme, context) {
        const visible = trackTool(context.toolCallId, context.invalidate);

        const intentText = new Text(
          theme.fg("accent", "● ") + theme.fg("muted", intentFrom(args, base.label)),
          0,
          0,
        );

        const cleanArgs = withoutIntent(args);
        const expanded = detailLevel === 2 || context.expanded;
        const rendererState = context.state as AnyRecord & {
          [CALL_COMPONENT]?: unknown;
          [BODY_CONTAINER]?: Container;
        };
        const childContext = {
          ...context,
          args: cleanArgs,
          expanded,
          // Preserve the built-in renderer's own child separately so streaming
          // state is updated in place.
          lastComponent: rendererState[CALL_COMPONENT],
        } as any;

        let details;
        try {
          details = baseRenderCall
            ? baseRenderCall(cleanArgs as any, theme, childContext)
            : new Text(
                theme.fg("toolTitle", theme.bold(base.label)) +
                  (expanded ? `\n${theme.fg("dim", JSON.stringify(cleanArgs, null, 2))}` : ""),
                0,
                0,
              );
          rendererState[CALL_COMPONENT] = details;
        } catch {
          details = new Text(theme.fg("toolTitle", theme.bold(base.label)), 0, 0);
        }

        // Always invoke the base renderer above: Bash timing and Edit preview
        // lifecycle live there even when their visual component is hidden.
        if (!visible) return new Container();

        if (baseSelfShell) {
          // The base tool already renders its own framed shell (e.g. Edit).
          const container = new Container();
          container.addChild(intentText);
          if (detailLevel > 0 && details) container.addChild(details);
          return container;
        }

        // Non-self tools rely on the execution shell for padding/background.
        // Since we now use "self", reproduce that framing so the row keeps the
        // pending/success/error background it had before.
        const bgFn = context.isPartial
          ? (text: string) => theme.bg("toolPendingBg", text)
          : context.isError
            ? (text: string) => theme.bg("toolErrorBg", text)
            : (text: string) => theme.bg("toolSuccessBg", text);

        const box = new Box(1, 1, bgFn);
        box.addChild(intentText);
        const body = new Container();
        if (detailLevel > 0 && details) body.addChild(details);
        box.addChild(body);
        rendererState[BODY_CONTAINER] = body;
        return box;
      },

      renderResult(result, options, theme, context) {
        const visible = trackTool(context.toolCallId, context.invalidate);

        const expanded = detailLevel === 2 || context.expanded;
        const cleanArgs = withoutIntent(context.args);
        const rendererState = context.state as AnyRecord & {
          [RESULT_COMPONENT]?: unknown;
          [BODY_CONTAINER]?: Container;
        };
        const childContext = {
          ...context,
          args: cleanArgs,
          expanded,
          lastComponent: rendererState[RESULT_COMPONENT],
        } as any;
        const childOptions = { ...options, expanded };

        let details;
        try {
          if (baseRenderResult) {
            details = baseRenderResult(result, childOptions, theme, childContext);
          } else {
            const output = rawResultText(result);
            const shown = expanded ? output : output.split("\n").slice(0, 5).join("\n");
            details = new Text(theme.fg("toolOutput", shown), 0, 0);
          }
          rendererState[RESULT_COMPONENT] = details;
        } catch {
          details = new Text(theme.fg("toolOutput", rawResultText(result)), 0, 0);
        }

        // The base result renderer must observe completion even in intent mode;
        // Bash clears its elapsed-time interval only on this code path.
        if (!visible) return new Container();

        // Intent level shows only the label; normal/extended show details.
        if (detailLevel === 0) return new Container();

        if (baseSelfShell) return details ?? new Container();

        const body = rendererState[BODY_CONTAINER];
        if (!body) return details ?? new Container();
        if (details) body.addChild(details);
        return new Container();
      },
    });
  }

  // Use Pi's own implementations and renderers; this extension only adds
  // model-authored intent plus the rolling window display.
  const cwd = process.cwd();
  registerWithIntent(createReadToolDefinition(cwd));
  registerWithIntent(createBashToolDefinition(cwd));
  registerWithIntent(createEditToolDefinition(cwd));
  registerWithIntent(createWriteToolDefinition(cwd));
  registerWithIntent(createGrepToolDefinition(cwd));
  registerWithIntent(createFindToolDefinition(cwd));
  registerWithIntent(createLsToolDefinition(cwd));
}
