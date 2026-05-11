import React from "react";
import { Box, Text } from "ink";

export type ApprovalDialogDecision = "approved" | "denied";

export function ApprovalDialog({
  action,
  risk,
  approvalId,
  selectedDecision = "approved",
  height,
  width
}: {
  action: string;
  risk: string;
  approvalId?: string;
  selectedDecision?: ApprovalDialogDecision;
  height?: number;
  width?: number;
}): React.ReactElement {
  const approveSelected = selectedDecision === "approved";
  const contentWidth = Math.max(20, (width ?? 80) - 4);
  return (
    <Box height={height} flexShrink={0} borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text bold color="yellow">
        Approval Required
      </Text>
      {approvalId ? <Text color="gray">id {approvalId}</Text> : null}
      <Text wrap="truncate-end">{action.slice(0, contentWidth)}</Text>
      <Text color="gray" wrap="truncate-end">
        Risk: {risk.slice(0, contentWidth)}
      </Text>
      <Text>
        <Text color={approveSelected ? "green" : "gray"}>{approveSelected ? "> " : "  "}</Text>
        <Text bold={approveSelected} color={approveSelected ? "green" : "gray"}>
          approve
        </Text>
        <Text color="gray">   </Text>
        <Text color={!approveSelected ? "red" : "gray"}>{!approveSelected ? "> " : "  "}</Text>
        <Text bold={!approveSelected} color={!approveSelected ? "red" : "gray"}>
          deny
        </Text>
      </Text>
      <Text color="gray">a/y approve · d/n deny · Enter apply · Esc leave pending</Text>
    </Box>
  );
}
