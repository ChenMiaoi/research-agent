import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runtimeTimestamp, type EventSink } from "./events.js";

export const APPROVALS_PATH = join(".idea2repo", "approvals.jsonl");

export type RuntimeMode = "plan" | "research" | "generate" | "publish" | "danger-full-access";

export type ApprovalRisk = "read" | "write" | "overwrite" | "network" | "pdf_download" | "publish" | "shell";

export type ApprovalDecision = "auto_approved" | "requires_approval" | "denied";

export type ApprovalPolicy = {
  mode: RuntimeMode;
  allowWrite: boolean;
  allowOverwrite: boolean;
  allowNetwork: boolean;
  allowPdfDownload: boolean;
  allowPublish: boolean;
  allowShell: boolean;
};

export type ApprovalRecordStatus = "pending" | "approved" | "denied" | "auto_approved";

export type ApprovalRecord = {
  id: string;
  run_id: string;
  stage_id?: string;
  action: string;
  risk: ApprovalRisk[];
  mode: RuntimeMode;
  status: ApprovalRecordStatus;
  reason?: string;
  created_at: string;
  resolved_at?: string;
};

export type ApprovalRequestInput = {
  run_id: string;
  stage_id?: string;
  action: string;
  risk: ApprovalRisk[];
  reason?: string;
};

export type ApprovalWaitOptions = {
  waitForResolution?: boolean;
  signal?: AbortSignal;
  onPending?: (record: ApprovalRecord) => Promise<void> | void;
  onResolved?: (record: ApprovalRecord) => Promise<void> | void;
};

type ApprovalWaiter = (record: ApprovalRecord) => void;

const approvalWaiters = new Map<string, Set<ApprovalWaiter>>();

export class ApprovalRequiredError extends Error {
  constructor(
    readonly decision: Exclude<ApprovalDecision, "auto_approved">,
    readonly action: string,
    readonly risk: ApprovalRisk[]
  ) {
    super(`${decision === "denied" ? "approval denied" : "approval required"} for ${action}: ${risk.join(", ")}`);
    this.name = "ApprovalRequiredError";
  }
}

export function approvalPolicyForMode(mode: RuntimeMode, overrides: Partial<Omit<ApprovalPolicy, "mode">> = {}): ApprovalPolicy {
  const base = (() => {
    switch (mode) {
      case "plan":
        return { allowWrite: false, allowOverwrite: false, allowNetwork: false, allowPdfDownload: false, allowPublish: false, allowShell: false };
      case "research":
        return { allowWrite: true, allowOverwrite: false, allowNetwork: true, allowPdfDownload: false, allowPublish: false, allowShell: false };
      case "generate":
        return { allowWrite: true, allowOverwrite: false, allowNetwork: false, allowPdfDownload: false, allowPublish: false, allowShell: false };
      case "publish":
        return { allowWrite: true, allowOverwrite: false, allowNetwork: false, allowPdfDownload: false, allowPublish: false, allowShell: false };
      case "danger-full-access":
        return { allowWrite: true, allowOverwrite: true, allowNetwork: true, allowPdfDownload: true, allowPublish: false, allowShell: false };
    }
  })();
  return { mode, ...base, ...overrides };
}

export function approvalPolicyFromPermissions(
  permissions: Partial<Omit<ApprovalPolicy, "mode">>,
  mode: RuntimeMode = "generate"
): ApprovalPolicy {
  return approvalPolicyForMode(mode, permissions);
}

export function approvalDecision(policy: ApprovalPolicy, risk: ApprovalRisk[]): ApprovalDecision {
  let requiresApproval = false;
  for (const item of risk) {
    const decision = riskDecision(policy, item);
    if (decision === "denied") return "denied";
    if (decision === "requires_approval") requiresApproval = true;
  }
  return requiresApproval ? "requires_approval" : "auto_approved";
}

export class ApprovalRecorder {
  private readonly resolvedRoot: string;

  constructor(
    private readonly root: string,
    private readonly policy: ApprovalPolicy,
    private readonly events?: EventSink
  ) {
    this.resolvedRoot = resolve(root);
  }

  async request(input: ApprovalRequestInput): Promise<ApprovalRecord> {
    const record = this.record(input, "pending");
    await this.append(record);
    await this.events?.emit({
      type: "approval.requested",
      run_id: record.run_id,
      approval_id: record.id,
      ...(record.stage_id ? { stage_id: record.stage_id } : {}),
      action: record.action,
      risk: record.risk.join(", "),
      timestamp: record.created_at
    });
    if (record.stage_id) {
      await this.events?.emit({
        type: "stage.blocked",
        run_id: record.run_id,
        stage_id: record.stage_id,
        reason: `Pending approval ${record.id} for ${record.action}: ${record.risk.join(", ")}`,
        timestamp: record.created_at
      });
    }
    return record;
  }

  async autoApprove(input: ApprovalRequestInput): Promise<ApprovalRecord> {
    const now = runtimeTimestamp();
    const record = this.record(input, "auto_approved", now);
    await this.append(record);
    await this.events?.emit({
      type: "approval.resolved",
      run_id: record.run_id,
      approval_id: record.id,
      decision: "approved",
      timestamp: record.resolved_at ?? now
    });
    notifyApprovalResolution(this.resolvedRoot, record);
    return record;
  }

  async deny(input: ApprovalRequestInput, reason: string): Promise<ApprovalRecord> {
    const now = runtimeTimestamp();
    const record = this.record({ ...input, reason }, "denied", now);
    await this.append(record);
    await this.events?.emit({
      type: "approval.resolved",
      run_id: record.run_id,
      approval_id: record.id,
      decision: "denied",
      timestamp: record.resolved_at ?? now
    });
    notifyApprovalResolution(this.resolvedRoot, record);
    return record;
  }

  async resolve(request: ApprovalRecord, status: "approved" | "denied", reason?: string): Promise<ApprovalRecord> {
    const now = runtimeTimestamp();
    const record: ApprovalRecord = {
      ...request,
      status,
      reason: reason ?? request.reason,
      resolved_at: now
    };
    await this.append(record);
    await this.events?.emit({
      type: "approval.resolved",
      run_id: record.run_id,
      approval_id: record.id,
      decision: status,
      timestamp: now
    });
    notifyApprovalResolution(this.resolvedRoot, record);
    return record;
  }

  async waitForResolution(approvalId: string, options: { signal?: AbortSignal } = {}): Promise<ApprovalRecord> {
    throwIfAborted(options.signal);
    const existing = latestApprovalRecords(await readApprovalRecords(this.resolvedRoot)).find((record) => record.id === approvalId);
    if (existing && isResolvedApproval(existing)) return existing;
    return new Promise<ApprovalRecord>((resolveWait, reject) => {
      const key = approvalWaiterKey(this.resolvedRoot, approvalId);
      const waiters = approvalWaiters.get(key) ?? new Set<ApprovalWaiter>();
      const cleanup = (): void => {
        waiters.delete(waiter);
        if (!waiters.size) approvalWaiters.delete(key);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const waiter = (record: ApprovalRecord): void => {
        cleanup();
        resolveWait(record);
      };
      const onAbort = (): void => {
        cleanup();
        reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error(options.signal?.reason ? String(options.signal.reason) : "approval wait cancelled"));
      };
      waiters.add(waiter);
      approvalWaiters.set(key, waiters);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private record(input: ApprovalRequestInput, status: ApprovalRecordStatus, resolvedAt?: string): ApprovalRecord {
    const now = runtimeTimestamp();
    return {
      id: randomUUID(),
      run_id: input.run_id,
      ...(input.stage_id ? { stage_id: input.stage_id } : {}),
      action: input.action,
      risk: [...input.risk],
      mode: this.policy.mode,
      status,
      reason: input.reason,
      created_at: now,
      ...(resolvedAt ? { resolved_at: resolvedAt } : {})
    };
  }

  private async append(record: ApprovalRecord): Promise<void> {
    const path = join(this.root, APPROVALS_PATH);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

export async function enforceApproval(
  policy: ApprovalPolicy,
  input: ApprovalRequestInput,
  recorder?: ApprovalRecorder,
  options: ApprovalWaitOptions = {}
): Promise<ApprovalRecord | null> {
  const decision = approvalDecision(policy, input.risk);
  if (decision === "auto_approved") return (await recorder?.autoApprove(input)) ?? null;
  if (decision === "requires_approval") {
    const request = await recorder?.request(input);
    if (options.waitForResolution && recorder && request) {
      await options.onPending?.(request);
      const resolved = await recorder.waitForResolution(request.id, { signal: options.signal });
      await options.onResolved?.(resolved);
      if (resolved.status === "approved") return resolved;
      throw new ApprovalRequiredError("denied", input.action, input.risk);
    }
    await recorder?.resolve(request!, "denied", "No approval grant was supplied to this non-interactive command.");
    throw new ApprovalRequiredError(decision, input.action, input.risk);
  }
  await recorder?.deny(input, "Runtime mode denies this action.");
  throw new ApprovalRequiredError(decision, input.action, input.risk);
}

export async function readApprovalRecords(root: string): Promise<ApprovalRecord[]> {
  let raw = "";
  try {
    raw = await readFile(join(root, APPROVALS_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ApprovalRecord);
}

export async function resolveApprovalRecord(
  root: string,
  approvalId: string,
  decision: "approved" | "denied",
  options: { reason?: string; events?: EventSink } = {}
): Promise<ApprovalRecord> {
  const records = await readApprovalRecords(root);
  const current = [...records].reverse().find((record) => record.id === approvalId);
  if (!current) throw new Error(`approval not found: ${approvalId}`);
  const now = runtimeTimestamp();
  const record: ApprovalRecord = {
    ...current,
    status: decision,
    reason: options.reason ?? current.reason,
    resolved_at: now
  };
  const path = join(root, APPROVALS_PATH);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  await options.events?.emit({
    type: "approval.resolved",
    run_id: record.run_id,
    approval_id: record.id,
    decision,
    timestamp: now
  });
  notifyApprovalResolution(resolve(root), record);
  return record;
}

export function latestApprovalRecords(records: ApprovalRecord[]): ApprovalRecord[] {
  const byId = new Map<string, ApprovalRecord>();
  for (const record of records) byId.set(record.id, record);
  return [...byId.values()].sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export function formatApprovals(records: ApprovalRecord[]): string {
  const latest = latestApprovalRecords(records);
  if (!latest.length) return "No approvals recorded.";
  return latest.map((record) => `- ${record.status}: ${record.action} [${record.risk.join(", ")}] (${record.mode})`).join("\n");
}

function riskDecision(policy: ApprovalPolicy, risk: ApprovalRisk): ApprovalDecision {
  switch (risk) {
    case "read":
      return "auto_approved";
    case "write":
      return policy.allowWrite ? "auto_approved" : "denied";
    case "overwrite":
      if (!policy.allowWrite) return "denied";
      return policy.allowOverwrite ? "auto_approved" : "requires_approval";
    case "network":
      return policy.allowNetwork ? "auto_approved" : "requires_approval";
    case "pdf_download":
      if (!policy.allowWrite) return "denied";
      return policy.allowPdfDownload ? "auto_approved" : "requires_approval";
    case "publish":
      if (policy.allowPublish) return "auto_approved";
      return policy.mode === "publish" || policy.mode === "danger-full-access" ? "requires_approval" : "denied";
    case "shell":
      return policy.allowShell ? "auto_approved" : "denied";
  }
}

function notifyApprovalResolution(root: string, record: ApprovalRecord): void {
  if (!isResolvedApproval(record)) return;
  const key = approvalWaiterKey(root, record.id);
  const waiters = approvalWaiters.get(key);
  if (!waiters) return;
  for (const waiter of [...waiters]) waiter(record);
  approvalWaiters.delete(key);
}

function approvalWaiterKey(root: string, approvalId: string): string {
  return `${resolve(root)}\0${approvalId}`;
}

function isResolvedApproval(record: ApprovalRecord): boolean {
  return record.status === "approved" || record.status === "denied";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(signal.reason ? String(signal.reason) : "approval wait cancelled");
}
