import React, { useEffect, useMemo, useRef, useState } from "react";
import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Box, render, Text, useApp, useInput } from "ink";
import { generateResearchRepo, resumeResearchRepo, slugify } from "../generator.js";
import { loadCodexModelCatalog, type CodexModel, type ReasoningEffort } from "../models.js";
import { OFFLINE_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID } from "../providers.js";
import { ensureChild, readManifest, status as projectStatus, validate as validateProject } from "../state.js";
import { AuthStorage, CodexOAuthClient, openaiCodexOAuthProvider, type CodexUsageSnapshot, type CreditsSnapshot, type RateLimitWindow } from "../auth/codex-oauth.js";
import { buildGithubExportPlan } from "../github-export.js";
import { approvalPolicyForMode, formatApprovals, latestApprovalRecords, readApprovalRecords, resolveApprovalRecord, type ApprovalRecord, type RuntimeMode } from "../runtime/approvals.js";
import { formatDecisions, readDecisionRecords } from "../runtime/decisions.js";
import { readJsonlEvents, runtimeTimestamp, type EventSink, type Idea2RepoEvent } from "../runtime/events.js";
import { formatPlan, readPlanState } from "../runtime/plan.js";
import { retryRuntimeStage, skipRuntimeStage } from "../runtime/runs.js";
import type { ResearchStageId } from "../pipeline/stages.js";
import {
  activateWorkflowStep,
  completeWorkflowSteps,
  createWorkflowSteps,
  mergeActivity,
  presentProgressMessage,
  type TuiActivity,
  type TuiWorkflowStep,
  type WorkflowStepId
} from "./presentation.js";
import { completeSlashInput, getSlashHint, getSlashSuggestions, resolveSlashCommandInput, selectedSlashSuggestion, slashCommands } from "./slash-commands.js";
import { addHistoryEntry, readTuiInputHistory, writeTuiInputHistory } from "./history.js";
import type { RuntimeArtifactEntry } from "./ArtifactPanel.js";
import { ApprovalDialog, type ApprovalDialogDecision } from "./ApprovalDialog.js";
import { nextInspectorTab, ResearchCockpit, type InspectorTab } from "./ResearchCockpit.js";
import { applyTuiRuntimeEvent, createTuiRuntimeSnapshot, liveApprovalDetails, liveDecisionDetails, type TuiRuntimeSnapshot } from "./runtime-view.js";

type Message = {
  role: "system" | "user" | "assistant" | "error";
  title?: string;
  text: string;
  details?: string[];
};

type AppProps = {
  defaultOutput?: string;
};

type ActivePrompt = {
  message: string;
  submittedMessage?: string;
  cancelMessage?: string;
  historyEnabled?: boolean;
  initialValue?: string;
  resolve: (value: string) => void;
};

type SelectOption = {
  label: string;
  value: string;
  description?: string;
};

type ActiveSelect = {
  title: string;
  options: SelectOption[];
  selectedIndex: number;
  onSelect: (option: SelectOption) => Promise<void> | void;
};

type DirectoryPickerScope = "filesystem" | "drives";
export type DirectoryOptionKind = "select-current" | "parent" | "directory" | "drive";

type DirectoryOption = {
  kind: DirectoryOptionKind;
  label: string;
  path: string;
  description?: string;
};

type ActiveDirectoryPicker = {
  title: string;
  scope: DirectoryPickerScope;
  cwd: string;
  startLabel: string;
  options: DirectoryOption[];
  selectedIndex: number;
  loading: boolean;
  error?: string;
  resolve: (value: string) => void;
};

type ActiveApprovalDialog = {
  record: ApprovalRecord;
  outputRoot: string;
  selectedDecision: ApprovalDialogDecision;
};

type PinnedLimits = {
  accountId: string;
  fetchedAt: number;
  usage: CodexUsageSnapshot;
  refreshing?: boolean;
  error?: string;
};

type TerminalSize = {
  columns: number;
  rows: number;
};

export type TuiLayout = {
  columns: number;
  rows: number;
  compact: boolean;
  narrow: boolean;
  short: boolean;
  tiny: boolean;
  sideBySide: boolean;
  messageLimit: number;
  activityLimit: number;
  suggestionLimit: number;
  showMessageDetails: boolean;
  showOutputLine: boolean;
  quotaBarWidth: number;
  weekStyle: "full" | "compact" | "bar";
};

export type TuiPageMode = "normal" | "slash" | "prompt" | "select" | "directory" | "approval";

export type TuiPageBudget = {
  headerRows: number;
  limitsRows: number;
  conversationRows: number;
  insightRows: number;
  composerRows: number;
  totalRows: number;
};

const theme = {
  title: "#67e8f9",
  accent: "#38bdf8",
  command: "#a78bfa",
  success: "#86efac",
  warning: "#fbbf24",
  danger: "#f87171",
  text: "#e5e7eb",
  muted: "#94a3b8",
  dim: "#64748b",
  border: "#475569",
  panel: "#334155"
} as const;

const LIMITS_REFRESH_INTERVAL_MS = 60_000;
const WINDOWS_DRIVE_PICKER_CWD = "Windows drives";
const WINDOWS_DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export function App({ defaultOutput = "idea2repo-runs" }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const terminal = useTerminalSize();
  const layout = useMemo(() => layoutForTerminal(terminal.columns, terminal.rows), [terminal.columns, terminal.rows]);
  const [input, setInput] = useState("");
  const [inputVersion, setInputVersion] = useState(0);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [historyDraft, setHistoryDraft] = useState("");
  const [slashSelectionIndex, setSlashSelectionIndex] = useState(0);
  const [modelCatalog] = useState(() => loadCodexModelCatalog());
  const initialModel = modelCatalog.default_model;
  const initialReasoning = selectedModelReasoning(modelCatalog.models, initialModel);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "system",
      title: "Ready",
      text: "Type an idea, run /research, or use /help. Commands with choices open selectable menus."
    }
  ]);
  const [workflowSteps, setWorkflowSteps] = useState<TuiWorkflowStep[]>(() => createWorkflowSteps("intake"));
  const [activities, setActivities] = useState<TuiActivity[]>([]);
  const [provider, setProvider] = useState<string>(OPENAI_CODEX_PROVIDER_ID);
  const [model, setModel] = useState(initialModel);
  const [reasoning, setReasoning] = useState<ReasoningEffort>(initialReasoning);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("generate");
  const [output, setOutput] = useState(defaultOutput);
  const [outputBase, setOutputBase] = useState(defaultOutput);
  const [busy, setBusy] = useState(false);
  const [authStatus, setAuthStatus] = useState("checking");
  const [pinnedLimits, setPinnedLimits] = useState<PinnedLimits | null>(null);
  const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(null);
  const [activeSelect, setActiveSelect] = useState<ActiveSelect | null>(null);
  const [activeDirectoryPicker, setActiveDirectoryPicker] = useState<ActiveDirectoryPicker | null>(null);
  const [activeApprovalDialog, setActiveApprovalDialog] = useState<ActiveApprovalDialog | null>(null);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<TuiRuntimeSnapshot | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("evidence");
  const activeAbortController = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    openaiCodexOAuthProvider
      .status()
      .then((status) => {
        if (!cancelled) setAuthStatus(status.loggedIn ? `logged in${status.accountId ? `:${status.accountId}` : ""}` : "not logged in");
      })
      .catch((error: unknown) => {
        if (!cancelled) setAuthStatus(error instanceof Error ? error.message : "unknown");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    readTuiInputHistory()
      .then((history) => {
        if (!cancelled) setInputHistory(history);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const limitsPinned = Boolean(pinnedLimits);
  useEffect(() => {
    if (!limitsPinned) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      setPinnedLimits((current) => (current ? { ...current, refreshing: true, error: undefined } : current));
      try {
        const credentials = await new AuthStorage().get(OPENAI_CODEX_PROVIDER_ID);
        if (!credentials) throw new Error("Codex login required");
        const usage = await openaiCodexOAuthProvider.usage();
        if (!cancelled) {
          setPinnedLimits({
            accountId: credentials.accountId,
            fetchedAt: Date.now(),
            usage,
            refreshing: false
          });
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error || "unknown error");
          setPinnedLimits((current) =>
            current
              ? {
                  ...current,
                  refreshing: false,
                  error: compactText(message, 120)
                }
              : current
          );
        }
      } finally {
        inFlight = false;
      }
    };
    const interval = setInterval(() => void refresh(), LIMITS_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [limitsPinned]);

  const slashSuggestions = useMemo(() => getSlashSuggestions(input, layout.suggestionLimit), [input, layout.suggestionLimit]);
  const selectedSlashIndex = slashSuggestions.length ? Math.min(slashSelectionIndex, slashSuggestions.length - 1) : 0;
  const slashHint = useMemo(() => getSlashHint(input), [input]);
  const nextAction = useMemo(
    () => nextActionForState({ busy, authStatus, hasIdea: Boolean(lastUserIdea(messages)), activities }),
    [busy, authStatus, messages, activities]
  );
  const pageMode: TuiPageMode = activeDirectoryPicker ? "directory" : activeApprovalDialog ? "approval" : activeSelect ? "select" : activePrompt ? "prompt" : input.startsWith("/") ? "slash" : "normal";
  const showPinnedLimits = Boolean(pinnedLimits) && !activeDirectoryPicker;
  const pageBudget = useMemo(
    () =>
      pageBudgetForLayout(layout, {
        pinnedLimits: showPinnedLimits,
        mode: pageMode,
        optionCount: activeDirectoryPicker?.options.length ?? (activeApprovalDialog ? 2 : activeSelect?.options.length ?? slashSuggestions.length)
      }),
    [activeApprovalDialog, activeDirectoryPicker, activeSelect, layout, pageMode, showPinnedLimits, slashSuggestions.length]
  );
  const activityLineLimit = Math.max(1, Math.min(layout.activityLimit, pageBudget.insightRows - 5));
  const latestNotice = useMemo(() => latestNoticeForMessages(messages), [messages]);
  const visibleActivities = useMemo(() => activities.slice(-activityLineLimit), [activities, activityLineLimit]);

  useInput((_input, key) => {
    if (activeApprovalDialog) {
      if (key.escape) {
        setActiveApprovalDialog(null);
        append({ role: "assistant", title: "Approval left pending", text: activeApprovalDialog.record.action });
        return;
      }
      if (key.leftArrow || key.upArrow) {
        setActiveApprovalDialog((current) => (current ? { ...current, selectedDecision: "approved" } : current));
        return;
      }
      if (key.rightArrow || key.downArrow || key.tab) {
        setActiveApprovalDialog((current) => (current ? { ...current, selectedDecision: current.selectedDecision === "approved" ? "denied" : "approved" } : current));
        return;
      }
      const normalized = _input.toLowerCase();
      if (normalized === "a" || normalized === "y") {
        void resolveActiveApprovalDialog("approved");
        return;
      }
      if (normalized === "d" || normalized === "n") {
        void resolveActiveApprovalDialog("denied");
        return;
      }
      if (key.return) {
        void resolveActiveApprovalDialog(activeApprovalDialog.selectedDecision);
        return;
      }
      return;
    }
    if (activeDirectoryPicker) {
      if (key.escape) {
        activeDirectoryPicker.resolve("");
        setActiveDirectoryPicker(null);
        append({ role: "error", title: "Directory selection cancelled", text: "Output directory was not changed." });
        return;
      }
      if (key.upArrow) {
        setActiveDirectoryPicker((current) => (current ? { ...current, selectedIndex: wrapSelectIndex(current.selectedIndex - 1, current.options.length) } : current));
        return;
      }
      if (key.downArrow || key.tab) {
        setActiveDirectoryPicker((current) => (current ? { ...current, selectedIndex: wrapSelectIndex(current.selectedIndex + 1, current.options.length) } : current));
        return;
      }
      if (key.leftArrow) {
        if (activeDirectoryPicker.scope !== "drives") {
          if (process.platform === "win32" && isWindowsDriveRootPath(activeDirectoryPicker.cwd)) void loadWindowsDrivePicker(activeDirectoryPicker.resolve, activeDirectoryPicker.cwd);
          else void changeDirectory(dirname(activeDirectoryPicker.cwd));
        }
        return;
      }
      if (key.rightArrow) {
        const option = activeDirectoryPicker.options[activeDirectoryPicker.selectedIndex];
        if (option?.kind === "directory" || option?.kind === "parent" || option?.kind === "drive") void changeDirectory(option.path);
        return;
      }
      if (key.return) {
        const option = activeDirectoryPicker.options[activeDirectoryPicker.selectedIndex];
        if (!option) return;
        if (directoryEnterAction(option.kind) === "open") {
          void changeDirectory(option.path);
          return;
        }
        activeDirectoryPicker.resolve(option.path);
        setActiveDirectoryPicker(null);
        return;
      }
      return;
    }
    if (activeSelect) {
      if (key.escape) {
        setActiveSelect(null);
        append({ role: "error", title: "Selection cancelled", text: "No setting was changed." });
        return;
      }
      if (key.upArrow) {
        setActiveSelect((current) => (current ? { ...current, selectedIndex: wrapSelectIndex(current.selectedIndex - 1, current.options.length) } : current));
        return;
      }
      if (key.downArrow || key.tab) {
        setActiveSelect((current) => (current ? { ...current, selectedIndex: wrapSelectIndex(current.selectedIndex + 1, current.options.length) } : current));
        return;
      }
      if (key.return) {
        const option = activeSelect.options[activeSelect.selectedIndex];
        if (!option) return;
        const select = activeSelect;
        setActiveSelect(null);
        void Promise.resolve(select.onSelect(option)).catch((error: unknown) => appendError(error));
        return;
      }
      return;
    }
    if (!activePrompt && !input && currentRuntimeSnapshot(output) && (_input === "[" || _input === "]")) {
      setInspectorTab((current) => nextInspectorTab(current, _input === "[" ? -1 : 1));
      return;
    }
    if (!activePrompt && input.startsWith("/") && slashSuggestions.length && (key.upArrow || key.downArrow)) {
      setSlashSelectionIndex((current) => wrapSelectIndex(current + (key.upArrow ? -1 : 1), slashSuggestions.length));
      return;
    }
    if ((key.upArrow || key.downArrow) && (!activePrompt || activePrompt.historyEnabled)) {
      navigateHistory(key.upArrow ? -1 : 1);
      return;
    }
    if (key.escape) {
      if (activePrompt) {
        activePrompt.resolve("");
        setActivePrompt(null);
        replaceInput("");
        append({ role: "error", title: "Prompt cancelled", text: activePrompt.cancelMessage ?? "No value was submitted." });
        return;
      }
      if (input.startsWith("/") && input.length > 1) {
        replaceInput("");
        return;
      }
      exit();
      return;
    }
    if (key.tab && input.startsWith("/")) {
      const selected = selectedSlashSuggestion(input, selectedSlashIndex);
      const completed = selected?.completion ?? completeSlashInput(input);
      if (completed !== input) replaceInput(completed);
    }
  });

  async function submit(value: string): Promise<void> {
    const trimmed = value.trim();
    if (activeDirectoryPicker) return;
    if (activeApprovalDialog) return;
    if (activeSelect) return;
    if (activePrompt) {
      if (!trimmed) {
        append({ role: "error", title: "Input required", text: activePrompt.message });
        return;
      }
      const prompt = activePrompt;
      setActivePrompt(null);
      replaceInput("");
      append({ role: "user", text: prompt.submittedMessage ?? "submitted value" });
      if (prompt.historyEnabled) rememberInput(trimmed);
      prompt.resolve(trimmed);
      return;
    }
    const submitted = trimmed.startsWith("/") ? resolveSlashCommandInput(trimmed, selectedSlashIndex) : trimmed;
    if (!trimmed || (busy && submitted !== "/cancel")) return;
    replaceInput("");
    append({ role: "user", text: submitted });
    rememberInput(submitted);
    if (submitted.startsWith("/")) {
      await runCommand(submitted);
      return;
    }
    await startResearchWizard(submitted);
  }

  async function runCommand(commandLine: string): Promise<void> {
    const [command, ...parts] = commandLine.split(/\s+/);
    const rest = commandLine.slice(command?.length ?? 0).trim();
    switch (command) {
      case "/help":
        append({
          role: "assistant",
          title: "Command palette",
          text: "Type a slash command and press Enter. Commands with choices open an interactive selector.",
          details: slashCommands.filter((command) => !command.hidden).map((command) => `${command.usage} - ${command.description}`)
        });
        return;
      case "/exit":
        exit();
        return;
      case "/output":
        await chooseOutput(rest);
        return;
      case "/provider":
        chooseProvider(rest);
        return;
      case "/model":
        chooseModel(rest);
        return;
      case "/reasoning":
        chooseReasoning(rest);
        return;
      case "/login":
        await runLogin();
        return;
      case "/logout":
        setBusy(true);
        try {
          await openaiCodexOAuthProvider.logout();
          setAuthStatus("not logged in");
          setPinnedLimits(null);
          append({ role: "assistant", title: "Signed out", text: "Idea2Repo Codex OAuth credentials were removed from local storage." });
        } catch (error) {
          appendError(error);
        } finally {
          setBusy(false);
        }
        return;
      case "/status":
        await runBusy(async () => {
          const current = await projectStatus(output);
          append({
            role: "assistant",
            title: "Artifact status",
            text: `${current.present_artifacts}/${current.total_artifacts} expected artifacts are present.`,
            details: [`Missing: ${current.missing_artifacts.length}`, `Modified: ${current.modified_artifacts.length}`]
          });
        });
        return;
      case "/plan":
        await runBusy(async () => {
          const live = currentRuntimeSnapshot(output);
          if (live) {
            append({ role: "assistant", title: "Runtime plan", text: `Live plan has ${live.plan.items.length} stage items.`, details: formatPlan(live.plan).split("\n").slice(0, 8) });
            return;
          }
          const plan = await readPlanState(output);
          append({ role: "assistant", title: "Runtime plan", text: `Plan has ${plan.items.length} stage items.`, details: formatPlan(plan).split("\n").slice(0, 8) });
        });
        return;
      case "/trace":
        await runBusy(async () => {
          const live = currentRuntimeSnapshot(output);
          if (live) {
            append({ role: "assistant", title: "Runtime trace", text: `${live.events.length} live event${live.events.length === 1 ? "" : "s"} recorded.`, details: live.events.slice(-8).map((event) => `${event.timestamp} ${event.type}`) });
            return;
          }
          const events = await readJsonlEvents(resolve(output, ".idea2repo", "trace.jsonl"));
          append({ role: "assistant", title: "Runtime trace", text: `${events.length} event${events.length === 1 ? "" : "s"} recorded.`, details: events.slice(-8).map((event) => `${event.timestamp} ${event.type}`) });
        });
        return;
      case "/decisions":
        await runBusy(async () => {
          const live = currentRuntimeSnapshot(output);
          if (live) {
            append({
              role: "assistant",
              title: "Decision records",
              text: `${live.decisions.length} live decision${live.decisions.length === 1 ? "" : "s"} recorded.`,
              details: live.decisions.length ? liveDecisionDetails(live) : ["No live decisions recorded yet."]
            });
            return;
          }
          const records = await readDecisionRecords(output);
          append({ role: "assistant", title: "Decision records", text: `${records.length} visible decision${records.length === 1 ? "" : "s"} recorded.`, details: formatDecisions(records).split("\n").slice(0, 8) });
        });
        return;
      case "/artifacts":
        await runBusy(async () => {
          const live = currentRuntimeSnapshot(output);
          if (live) {
            append({
              role: "assistant",
              title: "Artifacts",
              text: `${live.artifacts.length} live artifact${live.artifacts.length === 1 ? "" : "s"} found.`,
              details: live.artifacts.length ? live.artifacts.slice(0, 8).map((artifact) => `${artifact.path} (${artifact.bytes} bytes)`) : ["No live artifacts recorded yet."]
            });
            return;
          }
          const artifacts = await runtimeArtifactEntries(output);
          append({ role: "assistant", title: "Artifacts", text: `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} found.`, details: artifacts.slice(0, 8).map((artifact) => `${artifact.path} (${artifact.bytes} bytes)`) });
        });
        return;
      case "/artifact":
        await runBusy(async () => {
          const artifactPath = rest.trim();
          if (!artifactPath) {
            append({ role: "error", title: "Artifact path required", text: "Use /artifact docs/diagnosis/ccf_a_readiness_report.md." });
            return;
          }
          const content = await readFile(ensureChild(output, artifactPath), "utf8");
          append({ role: "assistant", title: artifactPath, text: compactText(content, 160), details: content.split(/\r?\n/).filter(Boolean).slice(0, 8) });
        });
        return;
      case "/auth":
        chooseAuthAction(parts.join(" "));
        return;
      case "/limits":
        await showCodexLimits();
        return;
      case "/limit":
        await showCodexLimits();
        return;
      case "/resume":
        await runBusy(async () => {
          const result = await resumeResearchRepo(output);
          append({
            role: "assistant",
            title: "Resume completed",
            text: `Restored ${result.files.length} missing artifact${result.files.length === 1 ? "" : "s"}.`,
            details: [`Output: ${output}`]
          });
        });
        return;
      case "/validate":
        await runBusy(async () => {
          const errors = await validateProject(output);
          append(
            errors.length
              ? { role: "error", title: "Validation needs attention", text: `${errors.length} issue${errors.length === 1 ? "" : "s"} found.`, details: errors.slice(0, 6) }
              : { role: "assistant", title: "Validation passed", text: "Manifest and generated artifacts are consistent." }
          );
        });
        return;
      case "/doctor":
        append({
          role: "assistant",
          title: "Session diagnostics",
          text: "Current TUI route and provider state.",
          details: [`Provider: ${providerLabel(provider)}`, `Model: ${model}`, `Reasoning: ${reasoning}`, `Mode: ${runtimeMode}`, `Auth: ${authLabel(authStatus)}`, `Output: ${output}`]
        });
        return;
      case "/history":
        showHistory();
        return;
      case "/github":
        chooseGithubAction(parts.join(" "));
        return;
      case "/retry":
        await runBusy(async () => {
          const stageId = parts[0] as ResearchStageId | undefined;
          if (!stageId) {
            append({ role: "error", title: "Stage required", text: "Use /retry search_planning or another runtime stage id." });
            return;
          }
          const result = await retryRuntimeStage(output, stageId, { reason: parts.slice(1).join(" ") || undefined, execute: false });
          append({ role: "assistant", title: "Stage retry prepared", text: `${result.stage_id} and downstream stages were reset to pending.`, details: [`Snapshots: ${result.snapshots.length}`, `Run: ${result.run_id}`] });
        });
        return;
      case "/skip":
        await runBusy(async () => {
          const stageId = parts[0] as ResearchStageId | undefined;
          const reason = parts.slice(1).join(" ").trim();
          if (!stageId || !reason) {
            append({ role: "error", title: "Stage and reason required", text: "Use /skip pdf_reading No downloadable PDFs in offline mode." });
            return;
          }
          const result = await skipRuntimeStage(output, stageId, reason);
          append({ role: "assistant", title: "Stage skipped", text: `${result.stage_id} is blocked with a visible decision record.`, details: [`Run: ${result.run_id}`] });
        });
        return;
      case "/cancel":
        if (activeAbortController.current) {
          activeAbortController.current.abort("cancel requested from TUI");
          append({ role: "assistant", title: "Cancel requested", text: "The active generation run will stop at the next runtime checkpoint." });
        } else {
          append({ role: "assistant", title: "No active run", text: "There is no active generation run to cancel." });
        }
        return;
      case "/mode":
        chooseRuntimeMode(rest);
        return;
      case "/approve":
        await resolveApprovalFromCommand(parts[0], "approved");
        return;
      case "/deny":
        await resolveApprovalFromCommand(parts[0], "denied");
        return;
      case "/approvals":
        await runBusy(async () => {
          const live = currentRuntimeSnapshot(output);
          const pending = await pendingApprovalRecords(output);
          if (live) {
            append({
              role: "assistant",
              title: "Approval log",
              text: `${live.approvals.length} live approval entr${live.approvals.length === 1 ? "y" : "ies"} recorded.`,
              details: live.approvals.length ? liveApprovalDetails(live) : ["No live approvals recorded yet."]
            });
            if (pending[0]) openApprovalDialog(pending[0], output);
            return;
          }
          const records = await readApprovalRecords(output);
          append({
            role: "assistant",
            title: "Approval log",
            text: `${records.length} approval log entr${records.length === 1 ? "y" : "ies"} recorded.`,
            details: formatApprovals(records).split("\n").slice(0, 8)
          });
          if (pending[0]) openApprovalDialog(pending[0], output);
        });
        return;
      case "/research":
      case "/generate":
        await chooseGenerate(rest);
        return;
      default:
        append({ role: "error", title: "Unknown command", text: `${command} is not available. Use /help to open the command list.` });
    }
  }

  async function runGenerate(idea: string, outputOverride = output): Promise<void> {
    if (!idea.trim()) {
      append({ role: "error", title: "Missing idea", text: "Use /research, then enter an idea when prompted." });
      return;
    }
    const runId = randomUUID();
    const outputRoot = resolve(outputOverride);
    const policy = approvalPolicyForMode(runtimeMode);
    setRuntimeSnapshot(createTuiRuntimeSnapshot(runId, outputRoot));
    setInspectorTab("evidence");
    let terminalRuntimeEvent = false;
    const runtimeEvents: EventSink = {
      emit: (event) => {
        if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") terminalRuntimeEvent = true;
        recordRuntimeEvent(runId, outputRoot, event);
      }
    };
    startGenerationRoute(idea, outputOverride);
    await runBusy(async () => {
      const controller = new AbortController();
      activeAbortController.current = controller;
      const result = await generateResearchRepo(idea, outputOverride, {
        provider,
        offline: provider === OFFLINE_PROVIDER_ID,
        model,
        reasoningEffort: reasoning,
        progressCallback: recordProgress,
        runResearchPipeline: true,
        jsonlEvents: true,
        runId,
        eventSink: runtimeEvents,
        approvalMode: "block",
        allowNetwork: policy.allowNetwork,
        permissionPolicy: {
          allowWrite: policy.allowWrite,
          allowOverwrite: policy.allowOverwrite,
          allowNetwork: policy.allowNetwork,
          allowLogin: false,
          allowInstall: false,
          allowPublish: policy.allowPublish
        },
        signal: controller.signal
      }).catch((error: unknown) => {
        if (!terminalRuntimeEvent) {
          recordRuntimeEvent(runId, outputRoot, {
            type: "run.failed",
            run_id: runId,
            error: error instanceof Error ? error.message : String(error || "unknown error"),
            timestamp: runtimeTimestamp()
          });
        }
        throw error;
      });
      activeAbortController.current = null;
      setWorkflowSteps((current) => completeWorkflowSteps(current));
      setActivities((current) =>
        mergeActivity(current, {
          title: "Generation complete",
          detail: `${result.files.length} files prepared in ${result.project_name}.`,
          stage: "review",
          tone: "success"
        })
      );
      append({
        role: "assistant",
        title: `Generated ${result.project_name}`,
        text: "Repository scaffold is ready for review.",
        details: [
          `Scores: raw ${result.diagnosis.raw_score.total}/100, revised ${result.diagnosis.revised_score.total}/100`,
          `Provider: ${providerLabel(result.provider_id)} (${result.analysis_source === "codex" ? "Codex structured analysis" : "offline fallback"})`,
          `Artifacts: ${result.files.length}`,
          "Main report: docs/diagnosis/ccf_a_readiness_report.md",
          "Execution plan: docs/execution_plan/12_week_plan.md"
        ]
      });
    }).finally(() => {
      activeAbortController.current = null;
    });
  }

  async function chooseGenerate(value: string): Promise<void> {
    const idea = value || lastUserIdea(messages) || (await promptForInput("Research idea:", { submittedMessage: "submitted idea", historyEnabled: true }));
    await startResearchWizard(idea);
  }

  async function startResearchWizard(idea: string): Promise<void> {
    const trimmedIdea = idea.trim();
    if (!trimmedIdea) {
      append({ role: "error", title: "Missing idea", text: "Use /research, then enter an idea when prompted." });
      return;
    }
    captureIdea(trimmedIdea);
    const finalOutputPath = autoRunOutputForIdea(trimmedIdea, { baseDir: outputBase });
    setOutput(finalOutputPath);
    append({
      role: "assistant",
      title: "Research run started",
      text: `Output path selected: ${finalOutputPath}`,
      details: ["Project/output setup can be changed with /output before the next run."]
    });
    await runGenerate(trimmedIdea, finalOutputPath);
  }

  async function suggestProjectName(idea: string): Promise<string> {
    const fallback = slugify(idea);
    if (provider === OFFLINE_PROVIDER_ID) {
      append({ role: "assistant", title: "Project name suggested", text: fallback, details: ["Offline provider selected; using deterministic local naming."] });
      return fallback;
    }
    setBusy(true);
    try {
      const client = new CodexOAuthClient({
        model,
        reasoningEffort: reasoning
      });
      const suggestion = await client.suggestProjectName(idea, recordProgress);
      const name = slugify(suggestion.project_name);
      append({ role: "assistant", title: "Project name suggested", text: name, details: ["Edit the name if it does not fit."] });
      return name || fallback;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "unknown error");
      append({
        role: "error",
        title: "Codex naming unavailable",
        text: "Using a local fallback name. You can edit it before continuing.",
        details: [compactText(message, 120)]
      });
      return fallback;
    } finally {
      setBusy(false);
    }
  }

  async function chooseOutput(value: string): Promise<void> {
    const parent = value ? "" : await promptForDirectoryParent(output);
    if (!value && !parent) return;
    const initialValue = value || join(parent, outputDirectoryName(output));
    const nextOutput = value || (await promptForInput("Output directory:", { submittedMessage: "submitted output directory", historyEnabled: true, initialValue }));
    if (!nextOutput.trim()) return;
    setOutputBase(nextOutput);
    append({ role: "assistant", title: "Output updated", text: "New research runs will be written under this directory.", details: [nextOutput] });
  }

  function chooseProvider(value: string): void {
    const options = providerOptions();
    if (value) {
      const exact = options.find((option) => option.value === value);
      if (exact) {
        applyProvider(exact);
        return;
      }
      append({ role: "error", title: "Unknown provider", text: `${value} is not available in this TUI route.`, details: ["Choose a provider from the selector."] });
    }
    openSelect("Choose provider", options, applyProvider);
  }

  function chooseModel(value: string): void {
    const options = modelOptions(modelCatalog.models);
    if (value) {
      const exact = options.find((option) => option.value === value);
      if (exact) {
        applyModel(exact);
        return;
      }
      append({ role: "error", title: "Unknown Codex model", text: `${value} is not in the current Codex CLI catalog.`, details: ["Use /model and choose one from the selector."] });
    }
    openSelect(`Choose Codex model (${modelCatalog.source})`, options, applyModel);
  }

  function chooseReasoning(value: string): void {
    const currentModel = findModel(modelCatalog.models, model);
    const options = reasoningOptions(currentModel);
    if (value) {
      const exact = options.find((option) => option.value === value);
      if (exact) {
        applyReasoning(exact);
        return;
      }
      append({ role: "error", title: "Unsupported reasoning", text: `${value} is not supported by ${model}.`, details: ["Use /reasoning and choose a supported effort."] });
    }
    openSelect(`Choose reasoning for ${model}`, options, applyReasoning);
  }

  function chooseGithubAction(value: string): void {
    const normalized = value.trim();
    const dryRun = { label: "dry-run", value: "dry-run", description: "Preview GitHub issues and PR payloads without publishing." };
    if (normalized === "dry-run") {
      void runGithubDryRun();
      return;
    }
    if (normalized) append({ role: "error", title: "Unknown GitHub action", text: `${normalized} is not available yet.` });
    openSelect("Choose GitHub action", [dryRun], async () => runGithubDryRun());
  }

  function chooseRuntimeMode(value: string): void {
    const normalized = value.trim();
    const options = runtimeModeOptions();
    if (normalized) {
      const exact = options.find((option) => option.value === normalized);
      if (exact) {
        applyRuntimeMode(exact);
        return;
      }
      append({ role: "error", title: "Unknown runtime mode", text: `${normalized} is not available.`, details: options.map((option) => option.value) });
      return;
    }
    openSelect("Choose runtime mode", options, applyRuntimeMode);
  }

  function chooseAuthAction(value: string): void {
    const normalized = value.trim();
    const options: SelectOption[] = [
      { label: "status", value: "status", description: "Show token presence, account id, and expiry without revealing tokens." },
      { label: "limits", value: "limits", description: "Query Codex rate-limit windows and credits when the backend exposes them." },
      { label: "login", value: "login", description: "Start OpenAI Codex OAuth login." },
      { label: "logout", value: "logout", description: "Remove local Idea2Repo OAuth credentials." }
    ];
    const run = (action: string): Promise<void> | void => {
      if (action === "status") return showAuthStatus();
      if (action === "limits") return showCodexLimits();
      if (action === "login") return runLogin();
      if (action === "logout") return openaiCodexOAuthProvider.logout().then(() => {
        setAuthStatus("not logged in");
        setPinnedLimits(null);
        append({ role: "assistant", title: "Signed out", text: "Idea2Repo Codex OAuth credentials were removed from local storage." });
      });
    };
    if (normalized) {
      const exact = options.find((option) => option.value === normalized);
      if (exact) {
        void Promise.resolve(run(exact.value)).catch((error: unknown) => appendError(error));
        return;
      }
      append({ role: "error", title: "Unknown auth action", text: `${normalized} is not available.` });
    }
    openSelect("Choose auth action", options, (option) => run(option.value));
  }

  async function runGithubDryRun(): Promise<void> {
    await runBusy(async () => {
      const plan = await buildGithubExportPlan(output);
      append({
        role: "assistant",
        title: "GitHub dry-run",
        text: `${plan.would_create_issues} issue${plan.would_create_issues === 1 ? "" : "s"} would be created for ${plan.repo_name}.`,
        details: ["No network publish was performed.", `Pull request title: ${plan.pull_request.title}`]
      });
    });
  }

  function applyProvider(option: SelectOption): void {
    setProvider(option.value);
    setWorkflowSteps((current) => activateWorkflowStep(current, "route"));
    append({ role: "assistant", title: "Provider selected", text: providerLabel(option.value), details: [option.description ?? ""] });
  }

  function applyModel(option: SelectOption): void {
    const selected = findModel(modelCatalog.models, option.value);
    setModel(option.value);
    if (selected) setReasoning(selected.default_reasoning);
    append({
      role: "assistant",
      title: "Model selected",
      text: selected ? `${selected.id} with ${selected.default_reasoning} reasoning by default.` : option.value,
      details: selected ? [`Supported reasoning: ${selected.supported_reasoning.join(", ")}`] : undefined
    });
  }

  function applyReasoning(option: SelectOption): void {
    setReasoning(option.value as ReasoningEffort);
    append({ role: "assistant", title: "Reasoning updated", text: `${option.value} will be used for the current model.` });
  }

  function applyRuntimeMode(option: SelectOption): void {
    const next = option.value as RuntimeMode;
    const policy = approvalPolicyForMode(next);
    setRuntimeMode(next);
    append({
      role: "assistant",
      title: "Runtime mode updated",
      text: next,
      details: [
        `write=${policy.allowWrite}`,
        `overwrite=${policy.allowOverwrite}`,
        `network=${policy.allowNetwork}`,
        `publish=${policy.allowPublish}`,
        `shell=${policy.allowShell}`
      ]
    });
  }

  function showHistory(): void {
    const recent = inputHistory.slice(-8).reverse();
    append({
      role: "assistant",
      title: "Input history",
      text: recent.length ? "Use Up/Down in the composer to recall previous entries." : "No saved input history yet.",
      details: recent.map((entry) => compactText(entry, 110))
    });
  }

  async function showAuthStatus(): Promise<void> {
    await runBusy(async () => {
      const credentials = await new AuthStorage().get(OPENAI_CODEX_PROVIDER_ID);
      const status = await openaiCodexOAuthProvider.status();
      append({
        role: "assistant",
        title: "Codex auth status",
        text: credentials ? "OAuth tokens are available locally. Raw tokens are intentionally not printed." : "No Idea2Repo OAuth token is stored.",
        details: [
          `Status: ${status.statusText}`,
          `Account: ${credentials?.accountId ?? status.accountId ?? "not available"}`,
          `Access token: ${credentials?.access ? "stored" : "not stored"}`,
          `Refresh token: ${credentials?.refresh ? "stored" : "not stored"}`,
          `Expires: ${credentials ? formatTimestamp(credentials.expires) : "not available"}`
        ]
      });
    });
  }

  async function showCodexLimits(): Promise<void> {
    await runBusy(async () => {
      const credentials = await new AuthStorage().get(OPENAI_CODEX_PROVIDER_ID);
      if (!credentials) {
        append({
          role: "error",
          title: "Codex login required",
          text: "Rate limits require an Idea2Repo OAuth token.",
          details: ["Run /login first."]
        });
        return;
      }
      setPinnedLimits((current) => (current ? { ...current, refreshing: true, error: undefined } : current));
      let usage: CodexUsageSnapshot;
      try {
        usage = await openaiCodexOAuthProvider.usage();
      } catch (error) {
        setPinnedLimits((current) =>
          current
            ? {
                ...current,
                refreshing: false,
                error: compactText(error instanceof Error ? error.message : String(error || "unknown error"), 120)
              }
            : current
        );
        throw error;
      }
      setPinnedLimits({ accountId: credentials.accountId, fetchedAt: Date.now(), usage, refreshing: false });
      append({
        role: "assistant",
        title: "Codex limits pinned",
        text: "The rate-limit panel was refreshed and will stay visible on this page.",
        details: [`Auto refresh: every ${Math.round(LIMITS_REFRESH_INTERVAL_MS / 1000)}s`, usage.credits ? formatCredits(usage.credits) : ""].filter(Boolean)
      });
    });
  }

  function openSelect(title: string, options: SelectOption[], onSelect: ActiveSelect["onSelect"]): void {
    if (!options.length) {
      append({ role: "error", title: "No options available", text: title });
      return;
    }
    setActivePrompt(null);
    setActiveDirectoryPicker(null);
    setActiveApprovalDialog(null);
    replaceInput("");
    setActiveSelect({ title, options, selectedIndex: 0, onSelect });
  }

  async function promptForDirectoryParent(currentOutput: string): Promise<string> {
    const start = directoryPickerStartPath();
    setActivePrompt(null);
    setActiveSelect(null);
    setActiveApprovalDialog(null);
    replaceInput("");
    return new Promise((resolveDirectory) => {
      if (process.platform === "win32") {
        void loadWindowsDrivePicker(resolveDirectory, currentOutput);
        return;
      }
      void loadDirectoryPicker(start, resolveDirectory);
    });
  }

  async function loadWindowsDrivePicker(resolveDirectory: (value: string) => void, currentOutput: string): Promise<void> {
    const selectedDrive = windowsDriveRootForPath(resolve(currentOutput)) ?? windowsDriveRootForPath(homedir()) ?? windowsDriveRootForPath(process.cwd());
    setActiveDirectoryPicker({
      title: "Choose output drive",
      scope: "drives",
      cwd: WINDOWS_DRIVE_PICKER_CWD,
      startLabel: directoryPickerStartLabel(),
      options: [],
      selectedIndex: 0,
      loading: true,
      resolve: resolveDirectory
    });

    let options: DirectoryOption[] = [];
    let errorMessage: string | undefined;
    try {
      options = await windowsDriveOptions();
    } catch (error) {
      errorMessage = compactText(error instanceof Error ? error.message : String(error || "unknown error"), 100);
    }
    if (!options.length && selectedDrive) options = [driveOption(selectedDrive)];
    if (!options.length) {
      await loadDirectoryPicker(homedir(), resolveDirectory);
      return;
    }

    const selectedIndex = Math.max(0, options.findIndex((option) => option.path.toLowerCase() === selectedDrive?.toLowerCase()));
    setActiveDirectoryPicker((current) =>
      current?.resolve === resolveDirectory
        ? {
            ...current,
            options,
            selectedIndex,
            loading: false,
            error: errorMessage
          }
        : current
    );
  }

  async function loadDirectoryPicker(cwd: string, resolveDirectory: (value: string) => void, selectedIndex = 0): Promise<void> {
    const resolved = resolve(cwd);
    setActiveDirectoryPicker({
      title: "Choose output parent directory",
      scope: "filesystem",
      cwd: resolved,
      startLabel: directoryPickerStartLabel(),
      options: [],
      selectedIndex: 0,
      loading: true,
      resolve: resolveDirectory
    });
    try {
      const options = await directoryOptions(resolved);
      setActiveDirectoryPicker((current) =>
        current?.resolve === resolveDirectory
          ? {
              ...current,
              cwd: resolved,
              options,
              selectedIndex: Math.max(0, Math.min(selectedIndex, Math.max(0, options.length - 1))),
              loading: false,
              error: undefined
            }
          : current
      );
    } catch (error) {
      setActiveDirectoryPicker((current) =>
        current?.resolve === resolveDirectory
          ? {
              ...current,
              cwd: resolved,
              options: directoryFallbackOptions(resolved),
              selectedIndex: 0,
              loading: false,
              error: compactText(error instanceof Error ? error.message : String(error || "unknown error"), 100)
            }
          : current
      );
    }
  }

  async function changeDirectory(path: string): Promise<void> {
    const current = activeDirectoryPicker;
    if (!current) return;
    await loadDirectoryPicker(path, current.resolve);
  }

  async function runLogin(): Promise<void> {
    await runBusy(async () => {
      setWorkflowSteps((current) => activateWorkflowStep(current, "provider"));
      append({
        role: "assistant",
        title: "Codex login started",
        text: "A browser window should open for OpenAI Codex OAuth.",
        details: ["If the browser callback cannot reach the TUI, paste the redirect URL when prompted."]
      });
      const credentials = await openaiCodexOAuthProvider.login({
        openBrowser: true,
        onAuth: (info) => {
          append({
            role: "assistant",
            title: "Manual login link ready",
            text: "Use this URL only if the browser did not open automatically.",
            details: [info.url]
          });
        },
        onManualCodeInput: () =>
          promptForInput("Paste the redirect URL or authorization code:", {
            submittedMessage: "submitted OAuth redirect/code",
            cancelMessage: "Login prompt cancelled."
          }),
        onPrompt: (prompt) =>
          promptForInput(prompt.message, {
            submittedMessage: "submitted OAuth redirect/code",
            cancelMessage: "Login prompt cancelled."
          }),
        onProgress: recordProgress
      });
      await new AuthStorage().set(OPENAI_CODEX_PROVIDER_ID, credentials);
      setAuthStatus(`logged in:${credentials.accountId}`);
      setActivities((current) =>
        mergeActivity(current, {
          title: "Codex login complete",
          detail: `Account ${credentials.accountId}`,
          stage: "provider",
          tone: "success"
        })
      );
      append({ role: "assistant", title: "Codex login complete", text: "OAuth credentials were stored for Idea2Repo.", details: [`Account: ${credentials.accountId}`] });
    });
    setActivePrompt(null);
  }

  async function runBusy(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      appendError(error);
    } finally {
      setBusy(false);
    }
  }

  async function resolveApprovalFromCommand(approvalId: string | undefined, decision: ApprovalDialogDecision): Promise<void> {
    await runBusy(async () => {
      const selectedId = approvalId?.trim() || (await pendingApprovalRecords(output))[0]?.id;
      if (!selectedId) {
        append({ role: "error", title: "Approval id required", text: `Use /${decision === "approved" ? "approve" : "deny"} <approval_id>, or run /approvals to open a pending request.` });
        return;
      }
      await resolveApproval(output, selectedId, decision);
    });
  }

  async function resolveActiveApprovalDialog(decision: ApprovalDialogDecision): Promise<void> {
    const dialog = activeApprovalDialog;
    if (!dialog) return;
    setActiveApprovalDialog(null);
    await runBusy(async () => {
      await resolveApproval(dialog.outputRoot, dialog.record.id, decision);
    });
  }

  async function resolveApproval(root: string, approvalId: string, decision: ApprovalDialogDecision): Promise<void> {
    const outputRoot = resolve(root);
    const record = await resolveApprovalRecord(outputRoot, approvalId, decision, {
      reason: decision === "approved" ? "Approved from TUI." : "Denied from TUI.",
      events: {
        emit: (event) => {
          recordRuntimeEvent(event.run_id, outputRoot, event);
        }
      }
    });
    append({
      role: "assistant",
      title: decision === "approved" ? "Approval granted" : "Approval denied",
      text: record.action,
      details: [`Approval: ${record.id}`, `Risk: ${record.risk.join(", ")}`]
    });
  }

  async function pendingApprovalRecords(root: string): Promise<ApprovalRecord[]> {
    return latestApprovalRecords(await readApprovalRecords(root)).filter((record) => record.status === "pending");
  }

  function openApprovalDialog(record: ApprovalRecord, root: string): void {
    setActivePrompt(null);
    setActiveSelect(null);
    setActiveDirectoryPicker(null);
    setActiveApprovalDialog({ record, outputRoot: resolve(root), selectedDecision: "approved" });
  }

  function currentRuntimeSnapshot(root: string): TuiRuntimeSnapshot | null {
    if (!runtimeSnapshot) return null;
    return runtimeSnapshot.outputRoot === resolve(root) ? runtimeSnapshot : null;
  }

  function recordRuntimeEvent(runId: string, outputRoot: string, event: Idea2RepoEvent): void {
    setRuntimeSnapshot((current) => applyTuiRuntimeEvent(current?.runId === runId ? current : createTuiRuntimeSnapshot(runId, outputRoot), event));
    const activity = runtimeActivityForEvent(event);
    if (activity) {
      if (event.type === "run.completed") setWorkflowSteps((current) => completeWorkflowSteps(current));
      else setWorkflowSteps((current) => activateWorkflowStep(current, activity.stage));
      setActivities((current) => mergeActivity(current, activity));
    }
  }

  function append(message: Message): void {
    setMessages((current) => [...current, message].slice(-10));
  }

  function appendError(error: unknown): void {
    append(presentError(error));
  }

  function rememberInput(value: string): void {
    setInputHistory((current) => {
      const next = addHistoryEntry(current, value);
      if (next === current) return current;
      void writeTuiInputHistory(next).catch(() => undefined);
      return next;
    });
    setHistoryCursor(null);
    setHistoryDraft("");
  }

  function navigateHistory(direction: -1 | 1): void {
    if (!inputHistory.length) return;
    if (direction === -1) {
      const next = historyCursor === null ? inputHistory.length - 1 : Math.max(0, historyCursor - 1);
      if (historyCursor === null) setHistoryDraft(input);
      setHistoryCursor(next);
      replaceInput(inputHistory[next] ?? "", { keepHistoryCursor: true });
      return;
    }
    if (historyCursor === null) return;
    const next = historyCursor >= inputHistory.length - 1 ? null : historyCursor + 1;
    setHistoryCursor(next);
    replaceInput(next === null ? historyDraft : inputHistory[next] ?? "", { keepHistoryCursor: true });
  }

  function updateInput(value: string): void {
    setInput(value);
    setHistoryCursor(null);
    setHistoryDraft("");
    setSlashSelectionIndex(0);
  }

  function recordProgress(raw: string): void {
    const activity = presentProgressMessage(raw);
    setWorkflowSteps((current) => activateWorkflowStep(current, activity.stage));
    setActivities((current) => mergeActivity(current, activity));
  }

  function captureIdea(idea: string): void {
    setWorkflowSteps(activateWorkflowStep(createWorkflowSteps("intake"), "route"));
    setActivities((current) =>
      mergeActivity(current, {
        title: "Idea intake complete",
        detail: compactText(idea, 90),
        stage: "intake"
      })
    );
  }

  function startGenerationRoute(idea: string, outputPath = output): void {
    setWorkflowSteps(activateWorkflowStep(createWorkflowSteps("route"), "route"));
    setActivities([
      {
        title: "Generation plan prepared",
        detail: `Idea captured; writing to ${outputPath}`,
        stage: "route"
      },
      {
        title: "Research target",
        detail: compactText(idea, 90),
        stage: "intake",
        tone: "success"
      }
    ]);
  }

  function replaceInput(value: string, options: { keepHistoryCursor?: boolean } = {}): void {
    setInput(value);
    setInputVersion((version) => version + 1);
    setSlashSelectionIndex(0);
    if (!options.keepHistoryCursor) {
      setHistoryCursor(null);
      setHistoryDraft("");
    }
  }

  function promptForInput(message: string, options: Pick<ActivePrompt, "submittedMessage" | "cancelMessage" | "historyEnabled" | "initialValue"> = {}): Promise<string> {
    replaceInput(options.initialValue ?? "");
    setActiveSelect(null);
    setActiveDirectoryPicker(null);
    setActiveApprovalDialog(null);
    return new Promise((resolve) => {
      setActivePrompt({ message, resolve, ...options });
    });
  }

  return (
    <Box flexDirection="column" width={layout.columns} height={layout.rows}>
      <HeaderPanel
        height={pageBudget.headerRows}
        layout={layout}
        busy={busy}
        provider={provider}
        model={model}
        reasoning={reasoning}
      />
      {showPinnedLimits && pinnedLimits && pageBudget.limitsRows ? <LimitsPanel pinned={pinnedLimits} layout={layout} height={pageBudget.limitsRows} /> : null}
      {activeDirectoryPicker && pageBudget.insightRows ? (
        <DirectoryPickerPanel picker={activeDirectoryPicker} height={pageBudget.insightRows} layout={layout} />
      ) : activeApprovalDialog && pageBudget.insightRows ? (
        <ApprovalDialog
          approvalId={activeApprovalDialog.record.id}
          action={activeApprovalDialog.record.action}
          risk={activeApprovalDialog.record.risk.join(", ")}
          selectedDecision={activeApprovalDialog.selectedDecision}
          height={pageBudget.insightRows}
          width={layout.columns}
        />
      ) : pageBudget.insightRows ? (
        <MainPanels
          height={pageBudget.insightRows}
          layout={layout}
          workflowSteps={workflowSteps}
          activities={visibleActivities}
          nextAction={nextAction}
          notice={latestNotice}
          provider={provider}
          model={model}
          reasoning={reasoning}
          busy={busy}
          runtimeSnapshot={currentRuntimeSnapshot(output)}
          inspectorTab={inspectorTab}
        />
      ) : null}
      <ComposerPanel
        height={pageBudget.composerRows}
        layout={layout}
        activePrompt={activePrompt}
        activeSelect={activeSelect}
        activeDirectoryPicker={activeDirectoryPicker}
        busy={busy}
        input={input}
        inputVersion={inputVersion}
        selectedSlashIndex={selectedSlashIndex}
        slashHint={slashHint}
        slashSuggestions={slashSuggestions}
        onChange={updateInput}
        onSubmit={(value) => void submit(value)}
      />
    </Box>
  );
}

export async function runTui(options: AppProps = {}): Promise<void> {
  const instance = render(<App {...options} />);
  await instance.waitUntilExit();
}

function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>(() => readTerminalSize());
  useEffect(() => {
    const stdout = process.stdout;
    const update = () => setSize(readTerminalSize());
    stdout.on("resize", update);
    return () => {
      stdout.off("resize", update);
    };
  }, []);
  return size;
}

function readTerminalSize(): TerminalSize {
  return {
    columns: process.stdout.columns ?? 100,
    rows: process.stdout.rows ?? 36
  };
}

export function layoutForTerminal(columns: number, rows: number): TuiLayout {
  const safeColumns = Math.max(40, columns || 100);
  const safeRows = Math.max(12, rows || 36);
  const narrow = safeColumns < 92;
  const short = safeRows < 32;
  const tiny = safeColumns < 64 || safeRows < 22;
  const compact = narrow || short;
  return {
    columns: safeColumns,
    rows: safeRows,
    compact,
    narrow,
    short,
    tiny,
    sideBySide: safeColumns >= 104 && safeRows >= 28,
    messageLimit: tiny ? 2 : short ? 3 : 6,
    activityLimit: tiny ? 3 : short ? 6 : 12,
    suggestionLimit: tiny ? 3 : short ? 4 : 6,
    showMessageDetails: !tiny && safeRows >= 26,
    showOutputLine: !tiny,
    quotaBarWidth: safeColumns < 56 ? 10 : safeColumns < 80 ? 16 : 28,
    weekStyle: safeColumns >= 104 ? "full" : safeColumns >= 72 ? "compact" : "bar"
  };
}

export function autoRunOutputForIdea(
  idea: string,
  options: { baseDir?: string; now?: Date } = {}
): string {
  const baseDir = options.baseDir?.trim() || "idea2repo-runs";
  const stamp = formatRunStamp(options.now ?? new Date());
  const slug = slugify(idea).slice(0, 48) || "idea2repo-project";
  return join(baseDir, `${stamp}-${slug}`);
}

function formatRunStamp(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}`;
}

export function pageBudgetForLayout(
  layout: TuiLayout,
  options: { pinnedLimits?: boolean; mode?: TuiPageMode; optionCount?: number } = {}
): TuiPageBudget {
  const headerRows = layout.tiny ? 3 : 4;
  const limitsRows = options.pinnedLimits ? (layout.tiny ? 3 : layout.compact ? 5 : 8) : 0;
  const optionCount = Math.max(0, options.optionCount ?? 0);
  const optionRows = Math.min(optionCount, layout.tiny ? 2 : layout.short ? 3 : 5);
  const requestedComposerRows =
    options.mode === "directory"
      ? layout.tiny
        ? 3
        : 4
      : options.mode === "select" || options.mode === "slash" || options.mode === "approval"
      ? 5 + optionRows
      : options.mode === "prompt"
        ? layout.tiny
          ? 4
          : 5
        : 4;
  const composerRows = Math.max(3, Math.min(requestedComposerRows, layout.rows - headerRows - limitsRows));
  const remainingRows = Math.max(0, layout.rows - headerRows - limitsRows - composerRows);
  const conversationRows = 0;
  const insightRows = remainingRows;

  return {
    headerRows,
    limitsRows,
    conversationRows,
    insightRows,
    composerRows,
    totalRows: headerRows + limitsRows + conversationRows + insightRows + composerRows
  };
}

function SectionTitle({ label }: { label: string }): React.ReactElement {
  return (
    <Text>
      <Text color={theme.accent}>[</Text>
      <Text bold color={theme.text}>
        {label}
      </Text>
      <Text color={theme.accent}>]</Text>
    </Text>
  );
}

function StatusPill({ label, color }: { label: string; color: string }): React.ReactElement {
  return (
    <Text>
      <Text color={color}>[</Text>
      <Text bold color={color}>
        {label}
      </Text>
      <Text color={color}>]</Text>
    </Text>
  );
}

function StatusItem({ label, value, color }: { label: string; value: string; color: string }): React.ReactElement {
  return (
    <Box marginRight={2}>
      <Text>
        <Text color={theme.dim}>{label} </Text>
        <Text color={color}>{value}</Text>
      </Text>
    </Box>
  );
}

function HeaderPanel({
  height,
  layout,
  busy,
  provider,
  model,
  reasoning
}: {
  height: number;
  layout: TuiLayout;
  busy: boolean;
  provider: string;
  model: string;
  reasoning: ReasoningEffort;
}): React.ReactElement {
  const width = Math.max(20, layout.columns - 4);
  const providerText = layout.tiny ? providerShortLabel(provider) : providerLabel(provider);
  const statusText = compactText(
    [
      `Provider ${providerText}`,
      `Model ${model}`,
      `Thinking ${reasoning}`
    ]
      .filter(Boolean)
      .join("  "),
    width
  );
  if (height <= 3) {
    return (
      <Box height={height} flexShrink={0} borderStyle="round" borderColor={theme.accent} paddingX={1} paddingY={0}>
        <Text wrap="truncate-end">
          <Text bold color={theme.title}>Idea2Repo</Text>
          <Text color={theme.dim}>  {statusText}</Text>
          <Text color={busy ? theme.warning : theme.success}>  {busy ? "working" : "ready"}</Text>
        </Text>
      </Box>
    );
  }
  return (
    <Box height={height} flexShrink={0} borderStyle="round" borderColor={theme.accent} paddingX={1} paddingY={0} flexDirection="column">
      <Box justifyContent="space-between" alignItems="center">
        <Text>
          <Text bold color={theme.title}>
            Idea2Repo
          </Text>
          <Text color={theme.muted}>  research scaffold agent</Text>
        </Text>
        <StatusPill label={busy ? "working" : "ready"} color={busy ? theme.warning : theme.success} />
      </Box>
      {height >= 4 ? <Text color={theme.muted}>{statusText}</Text> : null}
    </Box>
  );
}

function ConversationPanel({
  height,
  layout,
  messages,
  hiddenCount
}: {
  height: number;
  layout: TuiLayout;
  messages: Message[];
  hiddenCount: number;
}): React.ReactElement {
  if (height < 3) {
    return (
      <Box height={height} flexShrink={0}>
        <Text color={theme.dim}>{compactText("Conversation hidden because the terminal is very short.", layout.columns)}</Text>
      </Box>
    );
  }
  const width = Math.max(20, layout.columns - 4);
  const rowBudget = Math.max(0, height - 3);
  const rendered = messages.slice(-rowBudget);
  const omitted = Math.max(0, hiddenCount + messages.length - rendered.length);
  return (
    <Box height={height} flexShrink={0} borderStyle="round" borderColor={theme.border} paddingX={1} flexDirection="column">
      <Text>
        <Text color={theme.accent}>[</Text>
        <Text bold color={theme.text}>
          Conversation
        </Text>
        <Text color={theme.accent}>]</Text>
        {omitted ? <Text color={theme.dim}>  {omitted} older hidden</Text> : null}
      </Text>
      {rendered.length ? (
        rendered.map((message, index) => <MessageLine key={`${message.role}-${index}-${message.text}`} message={message} width={width} />)
      ) : rowBudget ? (
        <Text color={theme.dim}>No visible messages yet.</Text>
      ) : null}
    </Box>
  );
}

function MessageLine({ message, width }: { message: Message; width: number }): React.ReactElement {
  const label = labelFor(message.role);
  const details = (message.details ?? []).filter(Boolean);
  const body = message.title ? `${message.title}: ${message.text}` : message.text;
  const detail = details[0] ? ` (${details[0]})` : "";
  const contentWidth = Math.max(8, width - label.length - 4);
  return (
    <Text>
      <Text color={colorFor(message.role)}>{label}</Text>
      <Text color={theme.dim}> | </Text>
      <Text bold={message.role === "error"} color={message.role === "error" ? theme.danger : theme.text}>
        {compactText(`${body}${detail}`, contentWidth)}
      </Text>
    </Text>
  );
}

function noticeLine(message: Message, width: number): React.ReactElement {
  const details = (message.details ?? []).filter(Boolean);
  const body = message.title ? `${message.title}: ${message.text}` : message.text;
  const detail = details[0] ? ` (${details[0]})` : "";
  const label = message.role === "error" ? "Error" : "Notice";
  const color = message.role === "error" ? theme.danger : theme.accent;
  return (
    <Text key={`notice-${message.role}-${message.title ?? message.text}`}>
      <Text color={color}>{label} </Text>
      <Text color={message.role === "error" ? theme.danger : theme.muted}>{compactText(`${body}${detail}`, Math.max(8, width - label.length - 1))}</Text>
    </Text>
  );
}

function DirectoryPickerPanel({ picker, height, layout }: { picker: ActiveDirectoryPicker; height: number; layout: TuiLayout }): React.ReactElement {
  if (height < 3) {
    return (
      <Box height={height} flexShrink={0}>
        <Text color={theme.dim}>{compactText(`Choose parent: ${picker.cwd}`, layout.columns)}</Text>
      </Box>
    );
  }
  const innerRows = Math.max(0, height - 2);
  const width = Math.max(20, layout.columns - 4);
  const lines: React.ReactElement[] = [];
  const push = (line: React.ReactElement): void => {
    if (lines.length < innerRows) lines.push(line);
  };
  push(<SectionTitle key="directory-title" label={picker.title} />);
  push(
    <Text key="directory-root" color={theme.muted}>
      {compactText(picker.startLabel, width)}
    </Text>
  );
  push(
    <Text key="directory-cwd" color={theme.dim}>
      {compactText(`Current: ${picker.cwd}`, width)}
    </Text>
  );
  if (picker.loading) push(<Text key="directory-loading" color={theme.warning}>Loading directories...</Text>);
  if (picker.error) push(<Text key="directory-error" color={theme.warning}>{compactText(picker.error, width)}</Text>);
  const optionRows = Math.max(0, innerRows - lines.length);
  const windowed = visibleWindow(picker.options, picker.selectedIndex, optionRows);
  windowed.items.forEach((option, localIndex) => {
    const index = windowed.offset + localIndex;
    const selected = index === picker.selectedIndex;
    push(directoryOptionLine(option, selected, width, index));
  });
  return (
    <Box height={height} flexShrink={0} borderStyle="round" borderColor={theme.command} paddingX={1} flexDirection="column">
      {lines}
    </Box>
  );
}

function MainPanels({
  height,
  layout,
  workflowSteps,
  activities,
  nextAction,
  notice,
  provider,
  model,
  reasoning,
  busy,
  runtimeSnapshot,
  inspectorTab
}: {
  height: number;
  layout: TuiLayout;
  workflowSteps: TuiWorkflowStep[];
  activities: TuiActivity[];
  nextAction: { command: string; reason: string };
  notice?: Message;
  provider: string;
  model: string;
  reasoning: ReasoningEffort;
  busy: boolean;
  runtimeSnapshot: TuiRuntimeSnapshot | null;
  inspectorTab: InspectorTab;
}): React.ReactElement {
  if (height < 3) {
    return (
      <Box height={height} flexShrink={0}>
        <Text color={theme.dim}>{compactText(`Next ${nextAction.command}: ${nextAction.reason}`, layout.columns)}</Text>
      </Box>
    );
  }

  if (runtimeSnapshot) {
    return <ResearchCockpit height={height} width={layout.columns} compact={!layout.sideBySide} snapshot={runtimeSnapshot} activeInspectorTab={inspectorTab} />;
  }

  if (layout.sideBySide) {
    const columnWidth = Math.max(20, Math.floor((layout.columns - 5) / 2));
    return (
      <Box height={height} flexShrink={0} flexDirection="row">
        <Box width="50%" marginRight={1}>
          <ThinkingPanel height={height} width={columnWidth} workflowSteps={workflowSteps} activities={activities} nextAction={nextAction} provider={provider} model={model} reasoning={reasoning} busy={busy} />
        </Box>
        <Box flexGrow={1}>
          <ExecutionPanel height={height} width={columnWidth} layout={layout} workflowSteps={workflowSteps} activities={activities} notice={notice} busy={busy} />
        </Box>
      </Box>
    );
  }

  const thinkingRows = height < 6 ? Math.min(3, height) : Math.max(3, Math.min(layout.tiny ? 4 : layout.short ? 5 : 7, Math.floor(height * 0.42)));
  const executionRows = Math.max(0, height - thinkingRows);
  const width = Math.max(20, layout.columns - 4);
  return (
    <Box height={height} flexShrink={0} flexDirection="column">
      <ThinkingPanel height={thinkingRows} width={width} workflowSteps={workflowSteps} activities={activities} nextAction={nextAction} provider={provider} model={model} reasoning={reasoning} busy={busy} />
      {executionRows ? (
        <ExecutionPanel height={executionRows} width={width} layout={layout} workflowSteps={workflowSteps} activities={activities} notice={notice} busy={busy} />
      ) : null}
    </Box>
  );
}

function ThinkingPanel({
  height,
  width,
  workflowSteps,
  activities,
  nextAction,
  provider,
  model,
  reasoning,
  busy
}: {
  height: number;
  width: number;
  workflowSteps: TuiWorkflowStep[];
  activities: TuiActivity[];
  nextAction: { command: string; reason: string };
  provider: string;
  model: string;
  reasoning: ReasoningEffort;
  busy: boolean;
}): React.ReactElement {
  if (height < 3) {
    return (
      <Box height={height} flexShrink={0}>
        <Text color={theme.warning}>{compactText(thinkingFallbackText(workflowSteps, busy), width)}</Text>
      </Box>
    );
  }
  const innerRows = Math.max(0, height - 2);
  const activeStep = activeWorkflowStep(workflowSteps);
  const recentSignal = recentActivityForStep(activities, activeStep);
  const lines: React.ReactElement[] = [];
  const push = (line: React.ReactElement): void => {
    if (lines.length < innerRows) lines.push(line);
  };
  push(<SectionTitle key="thinking-title" label="Agent Thinking" />);
  push(
    <Text key="thinking-current">
      <Text color={busy ? theme.warning : workflowColor(activeStep?.status ?? "pending")}>{busy ? "[~]" : workflowMark(activeStep?.status ?? "pending")} </Text>
      <Text bold color={theme.text}>{compactText(activeStep ? activeStep.label : "Idle", Math.max(8, Math.floor(width * 0.35)))}</Text>
      <Text color={theme.muted}> {compactText(thinkingStatus(activeStep, busy), Math.max(8, width - 18))}</Text>
    </Text>
  );
  push(<Text key="thinking-focus" color={theme.muted}>{compactText(thinkingFocus(activeStep, recentSignal), width)}</Text>);
  push(
    <Text key="thinking-model" color={theme.dim}>
      {compactText(`${thinkingActorLabel(provider)} / ${model} / ${reasoning}`, width)}
    </Text>
  );
  for (const step of visibleWorkflowSteps(workflowSteps, Math.max(0, innerRows - lines.length - 2))) push(thinkingStepLine(step, width));
  push(
    <Text key="thinking-next">
      <Text color={theme.warning}>Next </Text>
      <Text bold color={theme.command}>{compactText(nextAction.command, Math.max(8, width - 5))}</Text>
    </Text>
  );
  push(<Text key="thinking-next-reason" color={theme.muted}>{compactText(nextAction.reason, width)}</Text>);
  return (
    <Box height={height} flexShrink={0} borderStyle="round" borderColor={theme.command} paddingX={1} flexDirection="column">
      {lines}
    </Box>
  );
}

function ExecutionPanel({
  height,
  width,
  layout,
  workflowSteps,
  activities,
  notice,
  busy
}: {
  height: number;
  width: number;
  layout: TuiLayout;
  workflowSteps: TuiWorkflowStep[];
  activities: TuiActivity[];
  notice?: Message;
  busy: boolean;
}): React.ReactElement {
  if (height < 3) {
    const fallback = executionPlaceholder(activeWorkflowStep(workflowSteps), busy);
    return (
      <Box height={height} flexShrink={0}>
        <Text color={theme.dim}>{compactText(`${fallback.title}: ${fallback.detail ?? ""}`, width)}</Text>
      </Box>
    );
  }
  const innerRows = Math.max(0, height - 2);
  const activeStep = activeWorkflowStep(workflowSteps);
  const displayActivities = activitiesForExecution(activities, workflowSteps, busy);
  const lines: React.ReactElement[] = [];
  const push = (line: React.ReactElement): void => {
    if (lines.length < innerRows) lines.push(line);
  };
  push(<SectionTitle key="execution-title" label="Execution" />);
  if (notice) push(noticeLine(notice, width));
  const stepLimit = Math.max(0, Math.min(layout.tiny ? 1 : 3, innerRows - lines.length - 2));
  for (const step of visibleWorkflowSteps(workflowSteps, stepLimit)) push(workflowLine(step, width));
  const remaining = Math.max(0, innerRows - lines.length);
  const shownActivities = displayActivities.slice(-remaining);
  for (const [index, activity] of shownActivities.entries()) push(activityLine(activity, index, width));
  if (!shownActivities.length) push(activityLine(executionPlaceholder(activeStep, busy), 0, width));
  return (
    <Box height={height} flexShrink={0} borderStyle="round" borderColor={theme.panel} paddingX={1} flexDirection="column">
      {lines}
    </Box>
  );
}

function ComposerPanel({
  height,
  layout,
  activePrompt,
  activeSelect,
  activeDirectoryPicker,
  busy,
  input,
  inputVersion,
  selectedSlashIndex,
  slashHint,
  slashSuggestions,
  onChange,
  onSubmit
}: {
  height: number;
  layout: TuiLayout;
  activePrompt: ActivePrompt | null;
  activeSelect: ActiveSelect | null;
  activeDirectoryPicker: ActiveDirectoryPicker | null;
  busy: boolean;
  input: string;
  inputVersion: number;
  selectedSlashIndex: number;
  slashHint: string;
  slashSuggestions: ReturnType<typeof getSlashSuggestions>;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}): React.ReactElement {
  const width = Math.max(20, layout.columns - 4);
  const innerRows = Math.max(0, height - 2);
  const infoRows = Math.max(0, innerRows - 1);
  const lines: React.ReactElement[] = [];
  const push = (line: React.ReactElement): void => {
    if (lines.length < infoRows) lines.push(line);
  };

  if (activeDirectoryPicker) {
    const help =
      activeDirectoryPicker.scope === "drives"
        ? "Choose a drive. Enter or Right opens it; Esc cancels."
        : "Enter or Right opens folders; choose . to select the current folder; Left goes up; Esc cancels.";
    push(<Text key="directory-help" color={theme.muted}>{compactText(help, width)}</Text>);
  } else if (activePrompt) {
    push(<Text key="prompt" bold color={theme.warning}>{compactText(activePrompt.message, width)}</Text>);
    push(
      <Text key="prompt-help" color={theme.muted}>
        {compactText(`Enter submits. ${activePrompt.historyEnabled ? "Up/Down recalls history. " : ""}Esc cancels.`, width)}
      </Text>
    );
  } else if (activeSelect) {
    push(<Text key="select-title" bold color={theme.accent}>{compactText(activeSelect.title, width)}</Text>);
    const optionRows = Math.max(0, infoRows - 2);
    const windowed = visibleWindow(activeSelect.options, activeSelect.selectedIndex, optionRows);
    windowed.items.forEach((option, localIndex) => {
      const index = windowed.offset + localIndex;
      const selected = index === activeSelect.selectedIndex;
      push(optionLine(option, selected, width, index));
    });
    push(<Text key="select-help" color={theme.muted}>{compactText("Up/Down or Tab chooses. Enter confirms. Esc cancels.", width)}</Text>);
  } else if (input.startsWith("/")) {
    push(<Text key="slash-hint" color={theme.muted}>{compactText(slashHint, width)}</Text>);
    const suggestionRows = Math.max(0, infoRows - 2);
    const windowed = visibleWindow(slashSuggestions, selectedSlashIndex, suggestionRows);
    windowed.items.forEach((suggestion, localIndex) => {
      const index = windowed.offset + localIndex;
      const selected = index === selectedSlashIndex;
      push(slashSuggestionLine(suggestion, selected, width, index));
    });
    push(<Text key="slash-help" color={theme.dim}>{compactText("Up/Down selects. Tab completes. Enter runs or opens a selector.", width)}</Text>);
  } else {
    push(<Text key="normal-help" color={theme.muted}>{compactText("Type / for commands. Up/Down recalls history. Enter captures an idea.", width)}</Text>);
  }

  return (
    <Box height={height} flexShrink={0} borderStyle="round" borderColor={composerBorderColor(activeSelect, activePrompt)} paddingX={1} flexDirection="column">
      {lines}
      {innerRows ? (
        <Box height={1} flexShrink={0}>
          {activeDirectoryPicker ? (
            <Text color={theme.dim}>{compactText(activeDirectoryPicker.cwd, width)}</Text>
          ) : (
            <>
              <Text bold color={busy ? theme.warning : theme.success}>{busy ? "..." : ">"} </Text>
              <SingleLineTextInput
                key={inputVersion}
                value={input}
                placeholder={activePrompt ? "paste redirect URL or code" : ""}
                focus={!activeSelect}
                onChange={onChange}
                onSubmit={onSubmit}
              />
            </>
          )}
        </Box>
      ) : null}
    </Box>
  );
}

function SingleLineTextInput({
  value,
  placeholder = "",
  focus = true,
  onChange,
  onSubmit
}: {
  value: string;
  placeholder?: string;
  focus?: boolean;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
}): React.ReactElement {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  useEffect(() => {
    if (!focus) return;
    setCursorOffset((current) => Math.max(0, Math.min(current, value.length)));
  }, [focus, value]);

  useInput(
    (input, key) => {
      if (key.upArrow || key.downArrow || key.tab || (key.shift && key.tab) || key.escape || (key.ctrl && input === "c")) return;
      const offset = Math.max(0, Math.min(cursorOffset, value.length));
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.leftArrow) {
        setCursorOffset(Math.max(0, offset - 1));
        return;
      }
      if (key.rightArrow) {
        setCursorOffset(Math.min(value.length, offset + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (offset <= 0) return;
        const nextValue = value.slice(0, offset - 1) + value.slice(offset);
        setCursorOffset(offset - 1);
        onChange(nextValue);
        return;
      }
      if (!input) return;
      const nextValue = value.slice(0, offset) + input + value.slice(offset);
      setCursorOffset(offset + input.length);
      onChange(nextValue);
    },
    { isActive: focus }
  );

  return <Text wrap="truncate-start">{renderSingleLineInput(value, placeholder, cursorOffset, focus)}</Text>;
}

function renderSingleLineInput(value: string, placeholder: string, cursorOffset: number, focus: boolean): string {
  if (!focus) return value;
  if (!value) {
    if (!placeholder) return chalk.inverse(" ");
    return `${chalk.inverse(placeholder[0] ?? " ")}${chalk.grey(placeholder.slice(1))}`;
  }
  const offset = Math.max(0, Math.min(cursorOffset, value.length));
  if (offset === value.length) return `${value}${chalk.inverse(" ")}`;
  return `${value.slice(0, offset)}${chalk.inverse(value[offset] ?? " ")}${value.slice(offset + 1)}`;
}

function LimitsPanel({ pinned, layout, height }: { pinned: PinnedLimits; layout: TuiLayout; height: number }): React.ReactElement {
  const usage = pinned.usage;
  const innerRows = Math.max(0, height - 2);
  if (height < 3) {
    return (
      <Box height={height} flexShrink={0}>
        <Text color={theme.command}>{compactText("Codex limits pinned", layout.columns)}</Text>
      </Box>
    );
  }
  return (
    <Box height={height} flexShrink={0} borderStyle="round" borderColor={theme.command} paddingX={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text>
          <Text bold color={theme.command}>
            Codex Limits
          </Text>
          {layout.tiny ? <Text color={theme.dim}>  {compactLimitsSummary(usage)}</Text> : <Text color={theme.dim}>  auto {Math.round(LIMITS_REFRESH_INTERVAL_MS / 1000)}s</Text>}
        </Text>
        <Text color={pinned.refreshing ? theme.warning : theme.dim}>{pinned.refreshing ? "refreshing" : formatShortTimestamp(pinned.fetchedAt)}</Text>
      </Box>
      {innerRows >= 2 && !layout.compact ? <Text color={theme.dim}>Account {compactText(pinned.accountId, Math.max(16, layout.columns - 12))}</Text> : null}
      {innerRows >= 2 && layout.compact
        ? usage.primary
          ? <LimitWindowView label="5h window" window={usage.primary} width={layout.quotaBarWidth} compact={true} />
          : <Text color={theme.dim}>5h unavailable</Text>
        : null}
      {innerRows >= 3 && !layout.compact
        ? usage.primary
          ? <LimitWindowView label="5h window" window={usage.primary} width={layout.quotaBarWidth} compact={layout.compact} />
          : <Text color={theme.dim}>5h unavailable</Text>
        : null}
      {innerRows >= (layout.compact ? 3 : 4)
        ? usage.secondary
          ? <WeeklyLimitView window={usage.secondary} layout={layout} singleLine={innerRows < 6} />
          : <Text color={theme.dim}>Week unavailable</Text>
        : null}
      {innerRows >= 5 && !layout.tiny ? (
        <Text color={theme.muted}>
          {usage.credits ? formatCredits(usage.credits) : "Credits: not reported"}
          {usage.planType ? `  Plan: ${usage.planType}` : ""}
        </Text>
      ) : null}
      {innerRows >= 6 && pinned.error ? <Text color={theme.warning}>{compactText(`Last refresh failed: ${pinned.error}`, Math.max(20, layout.columns - 4))}</Text> : null}
    </Box>
  );
}

function workflowLine(step: TuiWorkflowStep, width: number): React.ReactElement {
  const label = step.label.padEnd(9);
  const detailWidth = Math.max(8, width - label.length - 5);
  return (
    <Text key={step.id}>
      <Text color={workflowColor(step.status)}>{workflowMark(step.status)} </Text>
      <Text bold={step.status === "active"} color={step.status === "pending" ? theme.muted : theme.text}>
        {label}
      </Text>
      <Text color={theme.dim}>{compactText(step.detail, detailWidth)}</Text>
    </Text>
  );
}

function activityLine(activity: TuiActivity, index: number, width: number): React.ReactElement {
  const count = activity.count && activity.count > 1 ? ` x${activity.count}` : "";
  const detail = activity.detail ? ` - ${activity.detail}` : "";
  const body = compactText(`${activity.title}${count}${detail}`, Math.max(8, width - 4));
  return (
    <Text key={`${activity.title}-${index}`}>
      <Text color={activityColor(activity)}>{activityMark(activity)} </Text>
      <Text color={theme.text}>{body}</Text>
    </Text>
  );
}

function optionLine(option: SelectOption, selected: boolean, width: number, index: number): React.ReactElement {
  const label = compactText(option.label, Math.min(24, Math.max(8, Math.floor(width * 0.35))));
  const description = option.description ? compactText(option.description, Math.max(8, width - label.length - 6)) : "";
  return (
    <Text key={`${option.value}-${index}`}>
      <Text color={selected ? theme.accent : theme.dim}>{selected ? "> " : "  "}</Text>
      <Text bold={selected} color={selected ? theme.text : theme.muted}>
        {label}
      </Text>
      {description ? <Text color={theme.dim}>  {description}</Text> : null}
    </Text>
  );
}

function directoryOptionLine(option: DirectoryOption, selected: boolean, width: number, index: number): React.ReactElement {
  const marker = option.kind === "select-current" ? "[.]" : option.kind === "parent" ? "[..]" : option.kind === "drive" ? "[drv]" : "[dir]";
  const labelWidth = Math.max(8, width - marker.length - 6);
  const label = option.description ? `${option.label} - ${option.description}` : option.label;
  return (
    <Text key={`${option.kind}-${option.path}-${index}`}>
      <Text color={selected ? theme.accent : theme.dim}>{selected ? "> " : "  "}</Text>
      <Text color={selected ? theme.command : theme.dim}>{marker} </Text>
      <Text bold={selected} color={selected ? theme.text : theme.muted}>
        {compactText(label, labelWidth)}
      </Text>
    </Text>
  );
}

function slashSuggestionLine(suggestion: ReturnType<typeof getSlashSuggestions>[number], selected: boolean, width: number, index: number): React.ReactElement {
  const command = compactText(suggestion.completion, Math.min(18, Math.max(8, Math.floor(width * 0.35))));
  const description = compactText(suggestion.description, Math.max(8, width - command.length - 6));
  return (
    <Text key={`${suggestion.name}-${suggestion.completion}-${index}`}>
      <Text color={selected ? theme.command : theme.dim}>{selected ? "> " : "  "}</Text>
      <Text bold={selected} color={selected ? theme.command : theme.muted}>
        {command}
      </Text>
      <Text color={theme.muted}>  {description}</Text>
    </Text>
  );
}

export function directoryPickerStartPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? WINDOWS_DRIVE_PICKER_CWD : homedir();
}

export function directoryPickerStartLabel(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `Drive start: ${WINDOWS_DRIVE_PICKER_CWD}` : `Home start: ${homedir()}`;
}

export function windowsDriveRootForPath(path: string | undefined): string | null {
  if (!path) return null;
  const drive = /^([a-zA-Z]):/.exec(path)?.[1];
  return drive ? `${drive.toUpperCase()}:\\` : null;
}

export function isWindowsDriveRootPath(path: string): boolean {
  const root = windowsDriveRootForPath(path);
  return Boolean(root && trimWindowsTrailingSeparators(path).toLowerCase() === trimWindowsTrailingSeparators(root).toLowerCase());
}

export function directoryEnterAction(kind: DirectoryOptionKind): "open" | "select" {
  return kind === "select-current" ? "select" : "open";
}

async function windowsDriveOptions(): Promise<DirectoryOption[]> {
  const checks = await Promise.all(
    windowsDriveCandidates().map(async (root) => {
      const pathStat = await stat(root).catch(() => null);
      return pathStat?.isDirectory() ? driveOption(root) : null;
    })
  );
  return checks.filter((option): option is DirectoryOption => Boolean(option));
}

function windowsDriveCandidates(): string[] {
  const candidates = new Set<string>();
  for (const letter of WINDOWS_DRIVE_LETTERS) candidates.add(`${letter}:\\`);
  for (const value of [process.env.SystemDrive, homedir(), process.cwd()]) {
    const drive = windowsDriveRootForPath(value);
    if (drive) candidates.add(drive);
  }
  return [...candidates].sort((left, right) => left.localeCompare(right));
}

function driveOption(root: string): DirectoryOption {
  return { kind: "drive", label: root, path: root, description: "drive root" };
}

function trimWindowsTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

async function directoryOptions(cwd: string): Promise<DirectoryOption[]> {
  const resolved = resolve(cwd);
  const parent = dirname(resolved);
  const entries = await readdir(resolved, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => {
      const leftHidden = left.startsWith(".");
      const rightHidden = right.startsWith(".");
      if (leftHidden !== rightHidden) return leftHidden ? 1 : -1;
      return left.localeCompare(right);
    })
    .slice(0, 200);
  return [
    { kind: "select-current", label: ".", path: resolved, description: "select current folder" },
    ...(parent !== resolved ? [{ kind: "parent" as const, label: "..", path: parent, description: "parent folder" }] : []),
    ...directories.map((name) => ({ kind: "directory" as const, label: name, path: join(resolved, name) }))
  ];
}

function directoryFallbackOptions(cwd: string): DirectoryOption[] {
  const resolved = resolve(cwd);
  const parent = dirname(resolved);
  return [
    { kind: "select-current", label: ".", path: resolved, description: "select current folder" },
    ...(parent !== resolved ? [{ kind: "parent" as const, label: "..", path: parent, description: "parent folder" }] : [])
  ];
}

function outputDirectoryName(output: string): string {
  const name = basename(output.replace(/[\\/]+$/, ""));
  return name || "idea2repo-project";
}

function visibleWindow<T>(items: readonly T[], selectedIndex: number, limit: number): { items: T[]; offset: number } {
  const safeLimit = Math.max(0, Math.min(items.length, limit));
  if (!safeLimit) return { items: [], offset: 0 };
  const selected = Math.max(0, Math.min(selectedIndex, items.length - 1));
  const before = Math.floor(safeLimit / 2);
  const offset = Math.max(0, Math.min(items.length - safeLimit, selected - before));
  return { items: items.slice(offset, offset + safeLimit), offset };
}

function visibleWorkflowSteps(steps: TuiWorkflowStep[], limit: number): TuiWorkflowStep[] {
  const safeLimit = Math.max(0, Math.min(steps.length, limit));
  if (!safeLimit) return [];
  if (steps.length <= safeLimit) return steps;
  const activeIndex = steps.findIndex((step) => step.status === "active");
  if (activeIndex < 0) return steps.slice(0, safeLimit);
  const before = Math.floor(safeLimit / 2);
  const offset = Math.max(0, Math.min(steps.length - safeLimit, activeIndex - before));
  return steps.slice(offset, offset + safeLimit);
}

function compactLimitsSummary(usage: CodexUsageSnapshot): string {
  const fiveHour = usage.primary?.usedPercent == null ? "5h ?" : `5h ${Math.round(usage.primary.usedPercent)}%`;
  const week = usage.secondary?.usedPercent == null ? "wk ?" : `wk ${Math.round(usage.secondary.usedPercent)}%`;
  return `${fiveHour} ${week}`;
}

function compactLimitLabel(label: string): string {
  if (/week/i.test(label)) return "wk";
  if (/5h|5-hour|five/i.test(label)) return "5h";
  return compactText(label, 3);
}

function activeWorkflowStep(steps: TuiWorkflowStep[]): TuiWorkflowStep | undefined {
  return steps.find((step) => step.status === "active") ?? [...steps].reverse().find((step) => step.status === "done") ?? steps[0];
}

function recentActivityForStep(activities: TuiActivity[], step?: TuiWorkflowStep): TuiActivity | undefined {
  if (!step) return activities.at(-1);
  return [...activities].reverse().find((activity) => visibleStageId(activity.stage) === step.id) ?? activities.at(-1);
}

function thinkingFallbackText(steps: TuiWorkflowStep[], busy: boolean): string {
  const step = activeWorkflowStep(steps);
  return `${step?.label ?? "Agent"} ${busy ? "thinking..." : "waiting for the next command."}`;
}

function thinkingStatus(step: TuiWorkflowStep | undefined, busy: boolean): string {
  if (!step) return busy ? "thinking..." : "waiting.";
  if (step.status === "done") return "complete.";
  if (busy) return "thinking through this stage...";
  return "ready for the next action.";
}

function thinkingFocus(step: TuiWorkflowStep | undefined, recent?: TuiActivity): string {
  if (recent?.detail) return recent.detail;
  if (!step) return "Waiting for an idea or slash command.";
  switch (step.id) {
    case "intake":
      return "Reading the idea and looking for missing research context.";
    case "plan":
      return "Choosing provider, model, permissions, and the next safe command.";
    case "analysis":
      return "Preparing structured scores, risks, evidence needs, and revision guidance.";
    case "artifacts":
      return "Mapping analysis into reports, manifests, plans, and project files.";
    case "review":
      return "Checking what changed and deciding the next validation or publish action.";
    default:
      return "Preparing the next visible operation.";
  }
}

function thinkingActorLabel(provider: string): string {
  if (provider === OPENAI_CODEX_PROVIDER_ID) return "Codex reasoning";
  if (provider === OFFLINE_PROVIDER_ID) return "Offline planner";
  return `${provider} reasoning`;
}

function thinkingStepLine(step: TuiWorkflowStep, width: number): React.ReactElement {
  const suffix = step.status === "active" ? "thinking..." : step.status === "done" ? "resolved" : "pending";
  return (
    <Text key={`thinking-${step.id}`}>
      <Text color={workflowColor(step.status)}>{workflowMark(step.status)} </Text>
      <Text color={step.status === "active" ? theme.text : theme.muted}>{compactText(step.label, 12)}</Text>
      <Text color={theme.dim}> {compactText(suffix, Math.max(8, width - 18))}</Text>
    </Text>
  );
}

function activitiesForExecution(activities: TuiActivity[], steps: TuiWorkflowStep[], busy: boolean): TuiActivity[] {
  const active = activeWorkflowStep(steps);
  if (!active) return activities;
  const hasActiveSignal = activities.some((activity) => visibleStageId(activity.stage) === active.id);
  if (hasActiveSignal) return activities;
  return [...activities, executionPlaceholder(active, busy)];
}

function executionPlaceholder(step: TuiWorkflowStep | undefined, busy: boolean): TuiActivity {
  const label = step?.label ?? "Agent";
  const suffix = busy ? "in progress" : "waiting";
  return {
    title: `${label} ${suffix}`,
    detail: placeholderDetail(step, busy),
    stage: (step?.id ?? "plan") as WorkflowStepId
  };
}

function placeholderDetail(step: TuiWorkflowStep | undefined, busy: boolean): string {
  if (!step) return busy ? "Preparing the next visible operation." : "Waiting for an idea or slash command.";
  if (busy) return `${step.label} stage thinking; waiting for provider or file-operation events.`;
  if (step.status === "active") return `${step.label} stage is ready; run the next command when appropriate.`;
  if (step.status === "done") return `${step.label} stage is complete.`;
  return `${step.label} stage is queued.`;
}

function runtimeActivityForEvent(event: Idea2RepoEvent): TuiActivity | null {
  switch (event.type) {
    case "run.started":
      return {
        title: "Runtime run started",
        detail: compactText(event.output_root, 90),
        stage: "plan"
      };
    case "run.completed":
      return {
        title: "Runtime run completed",
        detail: "Trace, plan, decisions, tools, and artifacts were recorded.",
        stage: "review",
        tone: "success"
      };
    case "run.failed":
      return {
        title: "Runtime run failed",
        detail: compactText(event.error, 90),
        stage: "review",
        tone: "warning"
      };
    case "run.cancelled":
      return {
        title: "Runtime run cancelled",
        detail: compactText(event.reason ?? "cancel requested", 90),
        stage: "review",
        tone: "warning"
      };
    case "stage.started":
      return {
        title: event.label,
        detail: "started",
        stage: workflowStepForRuntimeStage(event.stage_id)
      };
    case "stage.completed":
      return {
        title: `${humanRuntimeStage(event.stage_id)} completed`,
        detail: `${event.artifacts.length} artifact${event.artifacts.length === 1 ? "" : "s"}`,
        stage: workflowStepForRuntimeStage(event.stage_id),
        tone: "success"
      };
    case "stage.skipped":
      return {
        title: `${humanRuntimeStage(event.stage_id)} skipped`,
        detail: compactText(event.reason, 90),
        stage: workflowStepForRuntimeStage(event.stage_id),
        tone: "warning"
      };
    case "stage.failed":
      return {
        title: `${humanRuntimeStage(event.stage_id)} failed`,
        detail: compactText(event.error, 90),
        stage: workflowStepForRuntimeStage(event.stage_id),
        tone: "warning"
      };
    case "stage.blocked":
      return {
        title: `${humanRuntimeStage(event.stage_id)} blocked`,
        detail: compactText(event.reason, 90),
        stage: workflowStepForRuntimeStage(event.stage_id),
        tone: "warning"
      };
    case "paper.found":
      return {
        title: "Paper candidate found",
        detail: compactText(`${event.title}${event.venue ? ` (${event.venue})` : ""}`, 90),
        stage: "analysis"
      };
    case "pdf.downloaded":
      return {
        title: "PDF downloaded",
        detail: compactText(`${event.paper_id} -> ${event.path}`, 90),
        stage: "analysis",
        tone: "success"
      };
    case "evidence.extracted":
      return {
        title: "Evidence extracted",
        detail: compactText(`${event.paper_id} p.${event.page}: ${event.claim}`, 90),
        stage: "analysis",
        tone: "success"
      };
    case "question.asked":
      return {
        title: "Clarification question",
        detail: compactText(event.question, 90),
        stage: "analysis",
        tone: "warning"
      };
    case "score.updated":
      return {
        title: "Score updated",
        detail: `${event.score}/${event.max_score} confidence ${event.confidence}`,
        stage: "analysis"
      };
    case "decision.recorded":
      return {
        title: "Decision recorded",
        detail: compactText(event.title, 90),
        stage: workflowStepForRuntimeStage(event.stage_id)
      };
    case "artifact.written":
      return {
        title: "Artifact written",
        detail: compactText(`${event.path} (${event.bytes} bytes)`, 90),
        stage: "artifacts",
        tone: "success"
      };
    case "approval.requested":
      return {
        title: "Approval requested",
        detail: compactText(`${event.action} [${event.risk}]`, 90),
        stage: "review",
        tone: "warning"
      };
    case "approval.resolved":
      return {
        title: "Approval resolved",
        detail: `${event.approval_id} -> ${event.decision}`,
        stage: "review",
        tone: event.decision === "approved" ? "success" : "warning"
      };
    case "tool.started":
    case "tool.completed":
    case "plan.updated":
    case "artifact.snapshot":
    case "artifact.restored":
      return null;
  }
}

function workflowStepForRuntimeStage(stageId?: string): WorkflowStepId {
  if (stageId === "idea_intake") return "intake";
  if (stageId === "search_planning") return "plan";
  if (stageId === "artifact_writing" || stageId === "venue_template_packaging" || stageId === "better_idea_synthesis") return "artifacts";
  return "analysis";
}

function humanRuntimeStage(stageId: string): string {
  return stageId
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function visibleStageId(stage: WorkflowStepId): Exclude<WorkflowStepId, "route" | "provider"> {
  if (stage === "route" || stage === "provider") return "plan";
  return stage;
}

function LimitWindowView({ label, window, width, compact }: { label: string; window: RateLimitWindow; width: number; compact: boolean }): React.ReactElement {
  const percent = window.usedPercent ?? 0;
  return (
    <Text>
      <Text color={theme.muted}>{compact ? compactLimitLabel(label).padEnd(4) : label.padEnd(12)} </Text>
      <QuotaBar percent={percent} width={width} />
      <Text color={usageColor(percent)}> {formatPercent(window.usedPercent)}</Text>
      {!compact ? <Text color={theme.dim}>  {formatReset(window)}</Text> : null}
    </Text>
  );
}

function WeeklyLimitView({ window, layout, singleLine = false }: { window: RateLimitWindow; layout: TuiLayout; singleLine?: boolean }): React.ReactElement {
  return <LimitWindowView label="week window" window={window} width={layout.quotaBarWidth} compact={singleLine || layout.compact} />;
}

function WeekSegment({ index, percent }: { index: number; percent: number }): React.ReactElement {
  const consumed = Math.max(0, Math.min(7, (percent / 100) * 7));
  const fill = Math.max(0, Math.min(1, consumed - index));
  const text = fill >= 0.99 ? "###" : fill >= 0.66 ? "## " : fill >= 0.33 ? "#  " : fill > 0 ? ".  " : "   ";
  return <Text color={fill > 0 ? usageColor(percent) : theme.dim}>[{text}]</Text>;
}

function QuotaBar({ percent, width }: { percent: number; width: number }): React.ReactElement {
  const used = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return (
    <Text>
      <Text color={theme.dim}>[</Text>
      <Text color={usageColor(percent)}>{"#".repeat(used)}</Text>
      <Text color={theme.dim}>{"-".repeat(width - used)}]</Text>
    </Text>
  );
}

function MessageView({ message, compact }: { message: Message; compact: boolean }): React.ReactElement {
  const details = (message.details ?? []).filter(Boolean);
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={messageBorderColor(message.role)} paddingX={1}>
      <Text>
        <Text color={colorFor(message.role)}>{labelFor(message.role)}</Text>
        <Text color={theme.dim}> / </Text>
        <Text bold color={message.role === "error" ? theme.danger : theme.text}>
          {message.title ?? message.text}
        </Text>
      </Text>
      {message.title && !compact ? <Text color={message.role === "error" ? theme.danger : theme.muted}>{message.text}</Text> : null}
      {(!compact ? details : details.slice(0, 1)).map((detail, index) => (
        <Text key={`${detail}-${index}`} color={theme.dim}>
          - {detail}
        </Text>
      ))}
    </Box>
  );
}

function colorFor(role: Message["role"]): string {
  if (role === "error") return theme.danger;
  if (role === "user") return theme.success;
  if (role === "system") return theme.muted;
  return theme.accent;
}

function messageBorderColor(role: Message["role"]): string {
  if (role === "error") return theme.danger;
  if (role === "user") return theme.success;
  if (role === "assistant") return theme.panel;
  return theme.border;
}

function labelFor(role: Message["role"]): string {
  if (role === "user") return "You";
  if (role === "assistant") return "Idea2Repo";
  if (role === "error") return "Needs attention";
  return "System";
}

function workflowMark(status: TuiWorkflowStep["status"]): string {
  if (status === "done") return "[x]";
  if (status === "active") return "[>]";
  return "[ ]";
}

function workflowColor(status: TuiWorkflowStep["status"]): string {
  if (status === "done") return theme.success;
  if (status === "active") return theme.accent;
  return theme.dim;
}

function activityMark(activity: TuiActivity): string {
  if (activity.tone === "success") return "[x]";
  if (activity.tone === "warning") return "[!]";
  return "[ ]";
}

function activityColor(activity: TuiActivity): string {
  if (activity.tone === "success") return theme.success;
  if (activity.tone === "warning") return theme.warning;
  return theme.accent;
}

function composerBorderColor(activeSelect: ActiveSelect | null, activePrompt: ActivePrompt | null): string {
  if (activeSelect) return theme.command;
  if (activePrompt) return theme.warning;
  return theme.border;
}

function nextActionForState(state: { busy: boolean; authStatus: string; hasIdea: boolean; activities: TuiActivity[] }): { command: string; reason: string } {
  if (state.busy) return { command: "wait", reason: "A run is already in progress; the visible plan will advance as events arrive." };
  if (!state.hasIdea) return { command: "type idea", reason: "Start with a research idea, or run /research and enter one when prompted." };
  const completed = state.activities.some((activity) => activity.title === "Generation complete");
  if (completed) return { command: "/validate", reason: "Check the manifest and generated artifacts, then use /status or /github as needed." };
  if (!state.authStatus.startsWith("logged in")) return { command: "/login", reason: "Codex OAuth is not signed in. Use /provider if you want offline mode instead." };
  return { command: "/research", reason: "The idea is captured. Research and generate the repository scaffold when the settings look right." };
}

function lastUserIdea(messages: Message[]): string {
  return [...messages]
    .reverse()
    .find((message) => message.role === "user" && !message.text.startsWith("/"))
    ?.text ?? "";
}

function latestNoticeForMessages(messages: Message[]): Message | undefined {
  return [...messages].reverse().find((message) => message.role !== "user");
}

function wrapSelectIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return (index + length) % length;
}

function selectedModelReasoning(models: CodexModel[], modelId: string): ReasoningEffort {
  return findModel(models, modelId)?.default_reasoning ?? "medium";
}

function findModel(models: CodexModel[], modelId: string): CodexModel | undefined {
  return models.find((candidate) => candidate.id === modelId);
}

function modelOptions(models: CodexModel[]): SelectOption[] {
  return models.map((model) => ({
    label: model.id,
    value: model.id,
    description: `${model.label}; default ${model.default_reasoning}; reasoning ${model.supported_reasoning.join("/")}`
  }));
}

function reasoningOptions(model?: CodexModel): SelectOption[] {
  const efforts = model?.supported_reasoning.length ? model.supported_reasoning : (["low", "medium", "high", "xhigh"] as ReasoningEffort[]);
  return efforts.map((effort) => ({
    label: effort,
    value: effort,
    description: model?.default_reasoning === effort ? "model default" : undefined
  }));
}

function providerOptions(): SelectOption[] {
  return [
    {
      label: OPENAI_CODEX_PROVIDER_ID,
      value: OPENAI_CODEX_PROVIDER_ID,
      description: "Use Idea2Repo-managed Codex OAuth credentials."
    },
    {
      label: OFFLINE_PROVIDER_ID,
      value: OFFLINE_PROVIDER_ID,
      description: "Generate deterministic offline artifacts without network calls."
    }
  ];
}

function runtimeModeOptions(): SelectOption[] {
  return [
    { label: "generate", value: "generate", description: "Write generated artifacts; network and publish require approval." },
    { label: "plan", value: "plan", description: "Read and plan only; writing and publishing are denied." },
    { label: "publish", value: "publish", description: "Prepare publish actions; publish still requires explicit approval." },
    { label: "danger-full-access", value: "danger-full-access", description: "Allow write and network operations; publish and shell remain gated." }
  ];
}

function providerLabel(provider: string): string {
  if (provider === OPENAI_CODEX_PROVIDER_ID) return "OpenAI Codex OAuth";
  if (provider === OFFLINE_PROVIDER_ID) return "Offline";
  return provider;
}

function providerShortLabel(provider: string): string {
  if (provider === OPENAI_CODEX_PROVIDER_ID) return "Codex";
  if (provider === OFFLINE_PROVIDER_ID) return "Offline";
  return provider;
}

function authLabel(status: string): string {
  if (status.startsWith("logged in")) return status.replace(/^logged in:?/, "logged in ");
  if (status === "checking") return "checking auth";
  return status;
}

function compactAuthLabel(status: string): string {
  if (status.startsWith("logged in")) return "logged in";
  if (status === "checking") return "checking";
  return status;
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function runtimeArtifactEntries(root: string): Promise<RuntimeArtifactEntry[]> {
  const manifest = await readManifest(root);
  const entries: RuntimeArtifactEntry[] = [];
  for (const artifact of manifest.artifacts) {
    const artifactPath = ensureChild(root, artifact.path);
    try {
      const info = await stat(artifactPath);
      if (!info.isFile()) continue;
      entries.push({
        path: artifact.path,
        bytes: info.size,
        text: isTextArtifact(artifact.path)
      });
    } catch {
      // The manifest may include stale paths while a run is in progress.
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function isTextArtifact(path: string): boolean {
  return /\.(?:csv|json|jsonl|md|py|ts|tsx|txt|ya?ml)$/i.test(path);
}

function formatLimitWindow(label: string, window: RateLimitWindow): string {
  const name = limitWindowName(label, window.windowMinutes);
  const used = window.usedPercent == null ? "unknown used" : `${Math.round(window.usedPercent)}% used`;
  const reset = window.resetsAt == null ? "reset unknown" : `resets ${formatTimestamp(window.resetsAt)}`;
  return `${name}: ${used}, ${reset}`;
}

function formatPercent(value: number | null): string {
  return value == null ? "unknown used" : `${Math.round(value)}% used`;
}

function formatReset(window: RateLimitWindow): string {
  return window.resetsAt == null ? "reset unknown" : `resets ${formatShortTimestamp(window.resetsAt)}`;
}

function usageColor(percent: number): string {
  if (percent >= 85) return theme.danger;
  if (percent >= 60) return theme.warning;
  return theme.success;
}

function limitWindowName(label: string, minutes: number | null): string {
  if (minutes === 300) return "5-hour limit";
  if (minutes === 10_080) return "weekly limit";
  if (minutes && minutes % 60 === 0) return `${label} ${minutes / 60}h limit`;
  if (minutes) return `${label} ${minutes}m limit`;
  return `${label} limit`;
}

function formatCredits(credits: CreditsSnapshot): string {
  if (credits.unlimited) return "Credits: unlimited";
  if (credits.balance != null) return `Credits: ${credits.balance}${credits.hasCredits === false ? " (depleted)" : ""}`;
  if (credits.hasCredits != null) return `Credits: ${credits.hasCredits ? "available" : "depleted"}`;
  return "Credits: not reported";
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function formatShortTimestamp(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function presentError(error: unknown): Message {
  const message = error instanceof Error ? error.message : String(error || "unknown error");
  if (/HTTP 403|403/i.test(message) && /Codex OAuth|OAuth|codex/i.test(message)) {
    return {
      role: "error",
      title: "Codex request rejected",
      text: "Browser OAuth can succeed while the Codex backend rejects the actual model request.",
      details: [
        "Use /model to choose a Codex-supported model from the local codex-cli catalog.",
        "Use /login to refresh the Idea2Repo OAuth session if the account changed.",
        "If your network needs a local proxy, start the TUI after macOS proxy settings are enabled."
      ]
    };
  }
  if (/output directory already exists/i.test(message)) {
    return {
      role: "error",
      title: "Output directory is not empty",
      text: "Idea2Repo will not overwrite an existing generated repository from the TUI.",
      details: [message]
    };
  }
  if (/not logged in|Missing authorization/i.test(message)) {
    return {
      role: "error",
      title: "Codex login required",
      text: "Sign in before running the OpenAI Codex provider.",
      details: ["Run /login in the TUI, or run idea2repo auth login in a normal shell."]
    };
  }
  return {
    role: "error",
    title: "Action failed",
    text: compactText(message, 180)
  };
}
