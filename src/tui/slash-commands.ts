export type SlashCommand = {
  name: `/${string}`;
  usage: string;
  description: string;
  interactive?: "run" | "select" | "prompt";
  arguments?: string[];
  hidden?: boolean;
};

export type SlashSuggestion = SlashCommand & {
  completion: string;
  kind: "command" | "argument";
};

export const slashCommands: SlashCommand[] = [
  {
    name: "/help",
    usage: "/help",
    description: "Show available slash commands."
  },
  {
    name: "/login",
    usage: "/login",
    description: "Start Codex OAuth login in the TUI."
  },
  {
    name: "/logout",
    usage: "/logout",
    description: "Clear Idea2Repo Codex OAuth credentials."
  },
  {
    name: "/status",
    usage: "/status",
    description: "Show generated project manifest status."
  },
  {
    name: "/plan",
    usage: "/plan",
    description: "Show the current runtime live plan."
  },
  {
    name: "/trace",
    usage: "/trace",
    description: "Show recent runtime events."
  },
  {
    name: "/decisions",
    usage: "/decisions",
    description: "Show visible decision records."
  },
  {
    name: "/artifacts",
    usage: "/artifacts",
    description: "Show generated artifact paths."
  },
  {
    name: "/artifact",
    usage: "/artifact <path>",
    description: "Read one generated text artifact.",
    arguments: ["docs/diagnosis/ccf_a_readiness_report.md", "docs/relative_work/search_plan.json", "docs/proposal/revised_idea.md"]
  },
  {
    name: "/auth",
    usage: "/auth",
    description: "Choose Codex auth status, login, logout, or limits.",
    interactive: "select"
  },
  {
    name: "/limits",
    usage: "/limits",
    description: "Show Codex account rate-limit windows and credits when available."
  },
  {
    name: "/limit",
    usage: "/limit",
    description: "Refresh and pin Codex account limit windows."
  },
  {
    name: "/model",
    usage: "/model",
    description: "Choose a Codex model from the Codex CLI catalog.",
    interactive: "select"
  },
  {
    name: "/reasoning",
    usage: "/reasoning",
    description: "Choose reasoning effort for the current model.",
    interactive: "select"
  },
  {
    name: "/provider",
    usage: "/provider",
    description: "Choose the active provider.",
    interactive: "select"
  },
  {
    name: "/research",
    usage: "/research",
    description: "Research the current idea and generate repository artifacts.",
    interactive: "prompt"
  },
  {
    name: "/generate",
    usage: "/generate",
    description: "Legacy alias for /research.",
    interactive: "prompt",
    hidden: true
  },
  {
    name: "/resume",
    usage: "/resume",
    description: "Show resume guidance for generated artifacts."
  },
  {
    name: "/validate",
    usage: "/validate",
    description: "Validate generated artifacts against the manifest."
  },
  {
    name: "/doctor",
    usage: "/doctor",
    description: "Show current provider, auth, model, and output state."
  },
  {
    name: "/history",
    usage: "/history",
    description: "Show recent TUI input history."
  },
  {
    name: "/github",
    usage: "/github",
    description: "Choose a GitHub export action.",
    interactive: "select"
  },
  {
    name: "/retry",
    usage: "/retry <stage_id>",
    description: "Retry a runtime stage when recovery support is available."
  },
  {
    name: "/skip",
    usage: "/skip <stage_id>",
    description: "Skip a runtime stage with a decision when recovery support is available."
  },
  {
    name: "/cancel",
    usage: "/cancel",
    description: "Cancel the active runtime run when cancellation support is available."
  },
  {
    name: "/mode",
    usage: "/mode research|plan|generate|publish",
    description: "Show or change runtime mode when approval support is available.",
    arguments: ["research", "plan", "generate", "publish"]
  },
  {
    name: "/approvals",
    usage: "/approvals",
    description: "Show pending approvals when approval support is available."
  },
  {
    name: "/approve",
    usage: "/approve <approval_id>",
    description: "Approve a pending runtime request.",
    arguments: ["<approval_id>"]
  },
  {
    name: "/deny",
    usage: "/deny <approval_id>",
    description: "Deny a pending runtime request.",
    arguments: ["<approval_id>"]
  },
  {
    name: "/output",
    usage: "/output",
    description: "Prompt for the generated project output directory.",
    interactive: "prompt"
  },
  {
    name: "/exit",
    usage: "/exit",
    description: "Exit the TUI."
  }
];

export function getSlashSuggestions(input: string, limit = 6): SlashSuggestion[] {
  const parsed = parseSlashInput(input);
  if (!parsed) return [];
  if (!parsed.hasArgument) {
    return slashCommands
      .filter((command) => !command.hidden && command.name.startsWith(parsed.commandPrefix))
      .slice(0, limit)
      .map((command) => ({
        ...command,
        completion: command.name,
        kind: "command"
      }));
  }
  const command = slashCommands.find((candidate) => candidate.name === parsed.commandPrefix);
  if (!command?.arguments?.length) return command ? [{ ...command, completion: input, kind: "command" }] : [];
  return command.arguments
    .filter((argument) => argument.startsWith(parsed.argumentPrefix))
    .slice(0, limit)
    .map((argument) => ({
      ...command,
      completion: `${command.name} ${argument}`,
      kind: "argument"
    }));
}

export function completeSlashInput(input: string): string {
  const suggestions = getSlashSuggestions(input, slashCommands.length);
  if (!suggestions.length) return input;
  const parsed = parseSlashInput(input);
  if (!parsed) return input;
  if (suggestions.length === 1) return suffixCompletion(suggestions[0]!.completion, parsed);
  const common = longestCommonPrefix(suggestions.map((suggestion) => suggestion.completion));
  if (common.length > input.length) return common;
  return input;
}

export function selectedSlashSuggestion(input: string, index: number, limit = 6): SlashSuggestion | null {
  const suggestions = getSlashSuggestions(input, limit);
  if (!suggestions.length) return null;
  return suggestions[clampIndex(index, suggestions.length)] ?? null;
}

export function resolveSlashCommandInput(input: string, selectedIndex = 0): string {
  const parsed = parseSlashInput(input);
  if (!parsed) return input;
  const exact = slashCommands.find((command) => command.name === parsed.commandPrefix);
  if (exact) return input;
  const selected = selectedSlashSuggestion(input, selectedIndex, slashCommands.length);
  return selected ? suffixCompletion(selected.completion, parsed) : input;
}

export function getSlashHint(input: string): string {
  const parsed = parseSlashInput(input);
  if (!parsed) return "Type / for commands.";
  const exact = slashCommands.find((command) => command.name === parsed.commandPrefix);
  if (!parsed.hasArgument) {
    if (exact) {
      const argumentHint =
        exact.interactive === "select"
          ? " Press Enter to choose."
          : exact.interactive === "prompt"
            ? " Press Enter to enter a value."
            : exact.arguments?.length
              ? ` Args: ${exact.arguments.join(" | ")}.`
              : " Press Enter to run.";
      return `${exact.usage} - ${exact.description}${argumentHint}`;
    }
    const suggestions = getSlashSuggestions(input, slashCommands.length);
    if (!suggestions.length) return "No matching command. Use /help.";
    return `${suggestions.length} command match${suggestions.length === 1 ? "" : "es"}. Press Tab to complete.`;
  }
  if (!exact) return "No matching command. Use /help.";
  if (!exact.arguments?.length) return `${exact.usage} - ${exact.description}`;
  const suggestions = getSlashSuggestions(input, slashCommands.length);
  if (!suggestions.length) return `No matching argument for ${exact.name}. Options: ${exact.arguments.join(" | ")}.`;
  if (suggestions.length === 1) return `Press Tab to complete: ${suggestions[0]!.completion}`;
  return `${suggestions.length} argument matches for ${exact.name}. Options: ${suggestions.map((suggestion) => suggestion.completion.split(/\s+/).at(-1)).join(" | ")}.`;
}

function parseSlashInput(input: string): { commandPrefix: string; argumentPrefix: string; hasArgument: boolean } | null {
  if (!input.startsWith("/")) return null;
  const commandMatch = input.match(/^(\S+)(?:\s+(.*))?$/);
  if (!commandMatch) return { commandPrefix: input, argumentPrefix: "", hasArgument: false };
  const commandPrefix = commandMatch[1] ?? "/";
  const hasArgument = /\s/.test(input);
  const argumentPrefix = commandMatch[2] ?? "";
  return { commandPrefix, argumentPrefix, hasArgument };
}

function suffixCompletion(completion: string, parsed: { commandPrefix: string; hasArgument: boolean }): string {
  const command = slashCommands.find((candidate) => candidate.name === completion);
  if (!command) return completion;
  return command.arguments?.length || command.usage.includes("<") ? `${completion} ` : completion;
}

function longestCommonPrefix(values: string[]): string {
  if (!values.length) return "";
  let prefix = values[0]!;
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix) && prefix) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}
