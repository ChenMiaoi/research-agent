import type { EventSink } from "../runtime/events.js";

export type StructuredRequest<T> = {
  task: string;
  promptFile?: string;
  context: unknown;
  schemaName: string;
  outputSchema?: object;
  validate: (value: unknown) => T;
  model?: string;
  reasoningEffort?: string;
  events?: EventSink;
  progress?: (message: string) => void;
};

export interface ProviderAdapter {
  id: string;
  available(): Promise<boolean>;
  status(): Promise<Record<string, unknown>>;
  structured<T>(request: StructuredRequest<T>): Promise<T>;
}

export type ProviderAdapterStatus = {
  id: string;
  available: boolean;
  api_shape: string;
  capabilities: string[];
  auth_boundary: string;
};
