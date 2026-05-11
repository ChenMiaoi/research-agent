import { randomUUID } from "node:crypto";
import { EventBus, runtimeTimestamp, type EventSink, type EventListener, type Idea2RepoEvent } from "./events.js";

export type RuntimeRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type RuntimeRunSnapshot = {
  id: string;
  idea: string;
  output_root: string;
  status: RuntimeRunStatus;
  created_at: string;
  updated_at: string;
  event_count: number;
  result?: unknown;
  error?: string;
};

export type RunJobContext = {
  runId: string;
  events: EventSink;
  signal: AbortSignal;
};

export type RuntimeRunRecord = RuntimeRunSnapshot & {
  events: Idea2RepoEvent[];
};

type ManagedRun = RuntimeRunRecord & {
  bus: EventBus;
  controller: AbortController;
  finalEventSeen: boolean;
  promise: Promise<void>;
};

export class RunManager {
  private readonly runs = new Map<string, ManagedRun>();

  start(
    input: { idea: string; outputRoot: string; runId?: string },
    job: (ctx: RunJobContext) => Promise<unknown>
  ): RuntimeRunSnapshot {
    const now = runtimeTimestamp();
    const runId = input.runId ?? randomUUID();
    const bus = new EventBus();
    const controller = new AbortController();
    const run: ManagedRun = {
      id: runId,
      idea: input.idea,
      output_root: input.outputRoot,
      status: "queued",
      created_at: now,
      updated_at: now,
      event_count: 0,
      events: [],
      bus,
      controller,
      finalEventSeen: false,
      promise: Promise.resolve()
    };
    bus.subscribe((event) => this.recordEvent(run, event));
    run.promise = Promise.resolve()
      .then(async () => {
        const result = await job({ runId, events: bus, signal: controller.signal });
        run.result = result;
        if (!run.finalEventSeen) {
          await run.bus.emit({ type: "run.completed", run_id: runId, timestamp: runtimeTimestamp() });
        }
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        run.error = message;
        if (!run.finalEventSeen) {
          const event: Idea2RepoEvent = controller.signal.aborted
            ? { type: "run.cancelled", run_id: runId, reason: controller.signal.reason ? String(controller.signal.reason) : message, timestamp: runtimeTimestamp() }
            : { type: "run.failed", run_id: runId, error: message, timestamp: runtimeTimestamp() };
          await run.bus.emit(event);
        }
      });
    this.runs.set(runId, run);
    return this.snapshot(run);
  }

  get(runId: string): RuntimeRunRecord | undefined {
    const run = this.runs.get(runId);
    return run ? { ...this.snapshot(run), events: [...run.events] } : undefined;
  }

  list(): RuntimeRunSnapshot[] {
    return [...this.runs.values()].map((run) => this.snapshot(run));
  }

  subscribe(runId: string, listener: EventListener): (() => void) | null {
    return this.runs.get(runId)?.bus.subscribe(listener) ?? null;
  }

  async cancel(runId: string, reason = "cancel requested"): Promise<RuntimeRunSnapshot | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (isFinalStatus(run.status)) return this.snapshot(run);
    run.controller.abort(reason);
    if (!run.finalEventSeen) {
      await run.bus.emit({ type: "run.cancelled", run_id: runId, reason, timestamp: runtimeTimestamp() });
    }
    return this.snapshot(run);
  }

  private recordEvent(run: ManagedRun, event: Idea2RepoEvent): void {
    run.events.push(event);
    run.event_count = run.events.length;
    run.updated_at = event.timestamp;
    if (event.type === "run.started") run.status = "running";
    if (event.type === "run.completed") {
      run.status = "completed";
      run.finalEventSeen = true;
    }
    if (event.type === "run.failed") {
      run.status = "failed";
      run.error = event.error;
      run.finalEventSeen = true;
    }
    if (event.type === "run.cancelled") {
      run.status = "cancelled";
      run.finalEventSeen = true;
    }
  }

  private snapshot(run: ManagedRun): RuntimeRunSnapshot {
    return {
      id: run.id,
      idea: run.idea,
      output_root: run.output_root,
      status: run.status,
      created_at: run.created_at,
      updated_at: run.updated_at,
      event_count: run.event_count,
      ...(run.result ? { result: run.result } : {}),
      ...(run.error ? { error: run.error } : {})
    };
  }
}

export function isFinalStatus(status: RuntimeRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
