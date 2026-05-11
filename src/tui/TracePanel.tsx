import React from "react";
import { Box, Text } from "ink";
import type { Idea2RepoEvent } from "../runtime/events.js";

export function TracePanel({
  events,
  limit = 8,
  title = "Trace",
  width
}: {
  events: Idea2RepoEvent[];
  limit?: number;
  title?: string;
  width?: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {events.slice(-limit).map((event, index) => (
        <Text key={`${event.type}-${event.timestamp}-${index}`}>
          {compactText(`${event.timestamp} ${event.type}`, width)}
        </Text>
      ))}
    </Box>
  );
}

function compactText(value: string, width?: number): string {
  if (!width || value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 3))}...`;
}
