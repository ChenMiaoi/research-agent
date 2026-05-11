import React from "react";
import { Box, Text } from "ink";
import type { PlanState } from "../runtime/plan.js";

export function PlanPanel({ plan, limit = 8 }: { plan: PlanState; limit?: number }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold>Plan</Text>
      {plan.items.slice(0, limit).map((item) => (
        <Text key={item.id}>
          {mark(item.status)} {item.step}
        </Text>
      ))}
    </Box>
  );
}

function mark(status: PlanState["items"][number]["status"]): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[>]";
  if (status === "blocked") return "[!]";
  if (status === "skipped") return "[-]";
  return "[ ]";
}
