import React from "react";
import { Box, Text } from "ink";
import type { Idea2RepoEvent } from "../runtime/events.js";
import { TracePanel } from "./TracePanel.js";
import type { TuiRuntimeSnapshot } from "./runtime-view.js";

export const INSPECTOR_TABS = ["evidence", "papers", "score", "artifacts", "approvals", "debug"] as const;
export type InspectorTab = (typeof INSPECTOR_TABS)[number];

const colors = {
  accent: "#38bdf8",
  success: "#86efac",
  warning: "#fbbf24",
  danger: "#f87171",
  text: "#e5e7eb",
  muted: "#94a3b8",
  dim: "#64748b",
  panel: "#334155"
} as const;

type ResearchThreadEntry = { kind: string; text: string; color: string };
type CockpitSummary = { completed: number; active: number; blocked: number; skipped: number; total: number };

export function nextInspectorTab(current: InspectorTab, direction: -1 | 1): InspectorTab {
  const index = INSPECTOR_TABS.indexOf(current);
  const next = (index + direction + INSPECTOR_TABS.length) % INSPECTOR_TABS.length;
  return INSPECTOR_TABS[next] ?? "evidence";
}

export function ResearchCockpit({
  snapshot,
  height,
  width,
  compact = false,
  activeInspectorTab = "evidence"
}: {
  snapshot: TuiRuntimeSnapshot;
  height: number;
  width: number;
  compact?: boolean;
  activeInspectorTab?: InspectorTab;
}): React.ReactElement {
  if (height < 3) {
    return (
      <Box height={height} flexShrink={0}>
        <Text color={statusColor(snapshot.status)}>{compactText(`Research cockpit ${snapshot.status}: ${snapshot.runId}`, width)}</Text>
      </Box>
    );
  }

  if (!compact && width >= 104 && height >= 10) {
    const planWidth = Math.max(24, Math.floor(width * 0.26));
    const inspectorWidth = Math.max(34, Math.floor(width * 0.32));
    const threadWidth = Math.max(30, width - planWidth - inspectorWidth - 2);
    return (
      <Box height={height} flexShrink={0} flexDirection="row">
        <Box width={planWidth} marginRight={1}>
          <CockpitPlanPanel snapshot={snapshot} height={height} width={planWidth} />
        </Box>
        <Box width={threadWidth} marginRight={1}>
          <ResearchThreadPanel snapshot={snapshot} height={height} width={threadWidth} />
        </Box>
        <Box width={inspectorWidth}>
          <InspectorPanel snapshot={snapshot} height={height} width={inspectorWidth} activeTab={activeInspectorTab} />
        </Box>
      </Box>
    );
  }

  const planRows = Math.min(height, Math.max(3, Math.min(7, Math.floor(height * 0.28))));
  const remainingAfterPlan = Math.max(0, height - planRows);
  const threadRows =
    remainingAfterPlan <= 3 ? remainingAfterPlan : Math.max(3, Math.min(remainingAfterPlan - 3, Math.floor(height * 0.38)));
  const inspectorRows = Math.max(0, height - planRows - threadRows);
  return (
    <Box height={height} flexShrink={0} flexDirection="column">
      <CockpitPlanPanel snapshot={snapshot} height={planRows} width={width} />
      {threadRows ? <ResearchThreadPanel snapshot={snapshot} height={threadRows} width={width} /> : null}
      {inspectorRows ? <InspectorPanel snapshot={snapshot} height={inspectorRows} width={width} activeTab={activeInspectorTab} /> : null}
    </Box>
  );
}

function CockpitPlanPanel({ snapshot, height, width }: { snapshot: TuiRuntimeSnapshot; height: number; width: number }): React.ReactElement {
  const innerRows = Math.max(0, height - 2);
  const lines: React.ReactElement[] = [];
  const push = (line: React.ReactElement): void => {
    if (lines.length < innerRows) lines.push(line);
  };
  push(<Title key="plan-title" label="PLAN" />);
  const summary = planSummary(snapshot);
  push(
    <Text key="plan-summary" color={colors.muted}>
      {compactText(`${summary.completed}/${summary.total} done  active ${summary.active}  blocked ${summary.blocked}  skipped ${summary.skipped}`, Math.max(8, width - 4))}
    </Text>
  );
  const remaining = Math.max(0, innerRows - lines.length);
  for (const item of snapshot.plan.items.slice(0, remaining)) {
    const suffix = item.blocker ? ` - ${item.blocker}` : item.next_actions[0] ? ` -> ${item.next_actions[0]}` : "";
    push(
      <Text key={item.id}>
        <Text color={markColor(item.status)}>{mark(item.status)} </Text>
        <Text>{compactText(`${item.step}${suffix}`, Math.max(8, width - 6))}</Text>
      </Text>
    );
  }
  if (snapshot.plan.items.length > remaining) {
    push(<Text key="plan-more" color={colors.dim}>{snapshot.plan.items.length - remaining} more stages</Text>);
  }
  return (
    <Box height={height} flexShrink={0} borderStyle="round" borderColor={colors.panel} paddingX={1} flexDirection="column">
      {lines}
    </Box>
  );
}

function ResearchThreadPanel({ snapshot, height, width }: { snapshot: TuiRuntimeSnapshot; height: number; width: number }): React.ReactElement {
  const innerRows = Math.max(0, height - 2);
  const lines: React.ReactElement[] = [];
  const push = (line: React.ReactElement): void => {
    if (lines.length < innerRows) lines.push(line);
  };
  push(<Title key="thread-title" label="RESEARCH THREAD" />);
  push(
    <Text key="thread-status">
      <Text color={statusColor(snapshot.status)}>{snapshot.status}</Text>
      <Text color={colors.dim}>  run {snapshot.runId.slice(0, 8)}</Text>
      <Text color={colors.dim}>  output {compactText(snapshot.outputRoot, Math.max(8, width - 28))}</Text>
    </Text>
  );
  if (snapshot.message) push(<Text key="thread-message" color={snapshot.status === "failed" ? colors.danger : colors.warning}>{compactText(snapshot.message, width)}</Text>);
  const entries = researchThreadEntries(snapshot.events);
  const remaining = Math.max(0, innerRows - lines.length);
  for (const [index, entry] of entries.slice(-remaining).entries()) {
    push(
      <Text key={`${entry.kind}-${index}-${entry.text}`}>
        <Text color={entry.color}>{entry.kind} </Text>
        <Text>{compactText(entry.text, Math.max(8, width - entry.kind.length - 1))}</Text>
      </Text>
    );
  }
  if (!entries.length) push(<Text key="thread-empty" color={colors.dim}>Waiting for research events.</Text>);
  return (
    <Box height={height} flexShrink={0} borderStyle="round" borderColor={colors.accent} paddingX={1} flexDirection="column">
      {lines}
    </Box>
  );
}

function InspectorPanel({
  snapshot,
  height,
  width,
  activeTab
}: {
  snapshot: TuiRuntimeSnapshot;
  height: number;
  width: number;
  activeTab: InspectorTab;
}): React.ReactElement {
  const innerRows = Math.max(0, height - 2);
  const lines: React.ReactElement[] = [];
  const push = (line: React.ReactElement): void => {
    if (lines.length < innerRows) lines.push(line);
  };
  push(<Title key="inspector-title" label="INSPECTOR" />);
  for (const line of tabBarLines(activeTab, width)) push(line);
  push(<Text key="inspector-action" color={colors.accent}>{compactText(cockpitActionLine(snapshot, activeTab), width)}</Text>);
  const remaining = Math.max(0, innerRows - lines.length);

  if (activeTab === "debug") {
    return (
      <Box height={height} flexShrink={0} borderStyle="round" borderColor={colors.panel} paddingX={1} flexDirection="column">
        {lines}
        {remaining ? <TracePanel events={snapshot.events} limit={remaining} title="Debug" width={width - 4} /> : null}
      </Box>
    );
  }

  for (const [index, line] of inspectorLines(snapshot, activeTab, remaining).entries()) {
    push(
      <Text key={`${activeTab}-${index}`} color={line.color}>
        {compactText(line.text, width)}
      </Text>
    );
  }
  return (
    <Box height={height} flexShrink={0} borderStyle="round" borderColor={colors.panel} paddingX={1} flexDirection="column">
      {lines}
    </Box>
  );
}

function Title({ label }: { label: string }): React.ReactElement {
  return (
    <Text>
      <Text color={colors.accent}>[</Text>
      <Text bold color={colors.text}>{label}</Text>
      <Text color={colors.accent}>]</Text>
    </Text>
  );
}

export function cockpitActionLine(snapshot: TuiRuntimeSnapshot, tab: InspectorTab): string {
  const pending = snapshot.approvals.find((approval) => !approval.decision);
  const activeStage = snapshot.plan.items.find((item) => item.status === "blocked" || item.status === "in_progress");
  if (pending) return `Action: approve/deny ${pending.action}${pending.stage_id ? ` at ${pending.stage_id}` : ""}`;
  if (activeStage?.status === "blocked") return `Action: retry/skip ${activeStage.stage_id}`;
  if (tab === "artifacts" && snapshot.artifacts.length) return `Action: open ${snapshot.artifacts.at(-1)?.path}`;
  if (tab === "evidence" && snapshot.events.some((event) => event.type === "evidence.extracted")) return "Action: open latest evidence card";
  if (tab === "papers" && snapshot.events.some((event) => event.type === "paper.found" || event.type === "pdf.downloaded")) return "Action: open latest paper card";
  if (tab === "score" && snapshot.events.some((event) => event.type === "score.updated")) return "Action: open score card";
  if (tab === "debug") return "Action: inspect runtime event trace";
  return "Action: edit idea, switch inspector, or wait for the next research event";
}

function tabBarLines(active: InspectorTab, width: number): React.ReactElement[] {
  const labels = INSPECTOR_TABS.map((tab) => (tab === active ? `[${tabLabel(tab)}]` : tabLabel(tab)));
  if (width < 56) {
    return [
      <Text key="inspector-tabs-a" color={colors.muted}>{labels.slice(0, 3).join(" ")}</Text>,
      <Text key="inspector-tabs-b" color={colors.muted}>{labels.slice(3).join(" ")}</Text>
    ];
  }
  return [<Text key="inspector-tabs" color={colors.muted}>{labels.join(" ")}</Text>];
}

function inspectorLines(snapshot: TuiRuntimeSnapshot, tab: Exclude<InspectorTab, "debug">, limit: number): Array<{ text: string; color: string }> {
  if (limit <= 0) return [];
  if (tab === "evidence") {
    const events = snapshot.events.filter((event): event is Extract<Idea2RepoEvent, { type: "evidence.extracted" }> => event.type === "evidence.extracted");
    if (!events.length) return [{ text: "No extracted evidence yet.", color: colors.dim }];
    return events.slice(-limit).map((event) => ({
      text: `${event.claim_type} ${event.paper_id} p.${event.page}: ${event.claim}`,
      color: colors.text
    }));
  }
  if (tab === "papers") {
    const papers = snapshot.events.filter((event): event is Extract<Idea2RepoEvent, { type: "paper.found" }> => event.type === "paper.found");
    const downloads = snapshot.events.filter((event): event is Extract<Idea2RepoEvent, { type: "pdf.downloaded" }> => event.type === "pdf.downloaded");
    const lines = [
      ...papers.map((event) => `${event.title}${event.venue ? ` (${event.venue}${event.year ? ` ${event.year}` : ""})` : ""}${event.pdf_status ? ` - ${event.pdf_status}` : ""}`),
      ...downloads.map((event) => `${event.paper_id} PDF downloaded: ${event.path}`)
    ];
    if (!lines.length) return [{ text: "No paper candidates recorded yet.", color: colors.dim }];
    return lines.slice(-limit).map((text) => ({ text, color: colors.text }));
  }
  if (tab === "score") {
    const scores = snapshot.events.filter((event): event is Extract<Idea2RepoEvent, { type: "score.updated" }> => event.type === "score.updated");
    const latest = scores.at(-1);
    if (!latest) return [{ text: "No score snapshot yet.", color: colors.dim }];
    return [
      { text: `Score ${latest.score}/${latest.max_score} confidence ${latest.confidence}`, color: colors.text },
      ...latest.hard_blockers.slice(0, Math.max(0, limit - 1)).map((blocker) => ({ text: `Blocker: ${blocker}`, color: colors.warning }))
    ].slice(0, limit);
  }
  if (tab === "artifacts") {
    if (!snapshot.artifacts.length) return [{ text: "No artifacts written yet.", color: colors.dim }];
    return snapshot.artifacts.slice(0, limit).map((artifact) => ({
      text: `${artifact.text ? "[txt]" : "[bin]"} ${artifact.path} (${artifact.bytes} bytes)`,
      color: colors.text
    }));
  }
  if (tab === "approvals") {
    if (!snapshot.approvals.length) return [{ text: "No approvals requested yet.", color: colors.dim }];
    return snapshot.approvals.slice(-limit).map((approval) => {
      const suffix = approval.decision ? ` -> ${approval.decision}` : approval.risk ? ` [${approval.risk}]` : "";
      const stage = approval.stage_id ? ` (${approval.stage_id})` : "";
      return { text: `${approval.action}${stage}${suffix}`, color: approval.decision === "approved" ? colors.success : colors.warning };
    });
  }
  return [];
}

function planSummary(snapshot: TuiRuntimeSnapshot): CockpitSummary {
  const summary: CockpitSummary = { completed: 0, active: 0, blocked: 0, skipped: 0, total: snapshot.plan.items.length };
  for (const item of snapshot.plan.items) {
    if (item.status === "completed") summary.completed += 1;
    else if (item.status === "in_progress") summary.active += 1;
    else if (item.status === "blocked") summary.blocked += 1;
    else if (item.status === "skipped") summary.skipped += 1;
  }
  return summary;
}

function researchThreadEntries(events: Idea2RepoEvent[]): ResearchThreadEntry[] {
  const entries: ResearchThreadEntry[] = [];
  for (const event of events) {
    switch (event.type) {
      case "run.started":
        entries.push({ kind: "Run", text: `Idea submitted; writing to ${event.output_root}`, color: colors.accent });
        break;
      case "run.completed":
        entries.push({ kind: "Run", text: "Completed", color: colors.success });
        break;
      case "run.failed":
        entries.push({ kind: "Run", text: event.error, color: colors.danger });
        break;
      case "run.cancelled":
        entries.push({ kind: "Run", text: event.reason ?? "Cancelled", color: colors.warning });
        break;
      case "stage.started":
        entries.push({ kind: "Stage", text: `${event.label} started`, color: colors.accent });
        break;
      case "stage.completed":
        entries.push({ kind: "Stage", text: `${humanize(event.stage_id)} completed with ${event.artifacts.length} artifact refs`, color: colors.success });
        break;
      case "stage.skipped":
        entries.push({ kind: "Stage", text: `${humanize(event.stage_id)} skipped: ${event.reason}`, color: colors.warning });
        break;
      case "stage.failed":
        entries.push({ kind: "Stage", text: `${humanize(event.stage_id)} failed: ${event.error}`, color: colors.danger });
        break;
      case "stage.blocked":
        entries.push({ kind: "Stage", text: `${humanize(event.stage_id)} blocked: ${event.reason}`, color: colors.warning });
        break;
      case "paper.found":
        entries.push({ kind: "Paper", text: `${event.title}${event.venue ? ` (${event.venue})` : ""}`, color: colors.text });
        break;
      case "pdf.downloaded":
        entries.push({ kind: "PDF", text: `${event.paper_id} downloaded to ${event.path}`, color: colors.success });
        break;
      case "evidence.extracted":
        entries.push({ kind: "Evidence", text: `${event.paper_id} p.${event.page}: ${event.claim}`, color: colors.success });
        break;
      case "question.asked":
        entries.push({ kind: "Question", text: `${event.question} Why: ${event.why_it_matters}`, color: colors.warning });
        break;
      case "score.updated":
        entries.push({ kind: "Score", text: `${event.score}/${event.max_score} confidence ${event.confidence}`, color: colors.accent });
        break;
      case "decision.recorded":
        entries.push({ kind: "Decision", text: event.title, color: colors.text });
        break;
      case "artifact.written":
        entries.push({ kind: "Artifact", text: `${event.path} (${event.bytes} bytes)`, color: colors.success });
        break;
      case "approval.requested":
        entries.push({ kind: "Approval", text: `${event.action} requested [${event.risk}]`, color: colors.warning });
        break;
      case "approval.resolved":
        entries.push({ kind: "Approval", text: `${event.approval_id} ${event.decision}`, color: event.decision === "approved" ? colors.success : colors.warning });
        break;
      case "tool.started":
      case "tool.completed":
      case "plan.updated":
      case "artifact.snapshot":
      case "artifact.restored":
        break;
    }
  }
  return entries;
}

function tabLabel(tab: InspectorTab): string {
  if (tab === "evidence") return "Evidence";
  if (tab === "papers") return "Papers";
  if (tab === "score") return "Score";
  if (tab === "artifacts") return "Artifacts";
  if (tab === "approvals") return "Approvals";
  return "Debug";
}

function mark(status: TuiRuntimeSnapshot["plan"]["items"][number]["status"]): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[>]";
  if (status === "blocked") return "[!]";
  if (status === "skipped") return "[-]";
  return "[ ]";
}

function markColor(status: TuiRuntimeSnapshot["plan"]["items"][number]["status"]): string {
  if (status === "completed") return colors.success;
  if (status === "in_progress") return colors.accent;
  if (status === "blocked" || status === "skipped") return colors.warning;
  return colors.dim;
}

function statusColor(status: TuiRuntimeSnapshot["status"]): string {
  if (status === "completed") return colors.success;
  if (status === "failed" || status === "cancelled") return colors.danger;
  if (status === "blocked") return colors.warning;
  return colors.accent;
}

function humanize(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.split(/\s+/).filter(Boolean).join(" ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
