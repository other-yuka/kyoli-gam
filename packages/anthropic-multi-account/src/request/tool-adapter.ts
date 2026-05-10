export type ToolDefinition = Record<string, unknown>;

export interface OpenCodeNativeToolSelection {
  reason: "incoming-tools" | "template-tools" | "no-tools";
  tools: ToolDefinition[];
}

export function selectOpenCodeNativeTools(input: {
  incomingTools: ToolDefinition[];
  templateTools: ToolDefinition[];
}): OpenCodeNativeToolSelection {
  if (input.incomingTools.length > 0) {
    return {
      reason: "incoming-tools",
      tools: enrichIncomingToolsWithTemplateSchemas(input.incomingTools, input.templateTools),
    };
  }

  if (!hasCompleteToolSchemas(input.templateTools)) {
    return {
      reason: "no-tools",
      tools: [],
    };
  }

  return {
    reason: "template-tools",
    tools: input.templateTools.map((tool) => ({ ...tool })),
  };
}

function hasCompleteToolSchemas(tools: ToolDefinition[]): boolean {
  return tools.length > 0
    && tools.every((tool) => typeof tool === "object" && tool !== null && "input_schema" in tool);
}

function enrichIncomingToolsWithTemplateSchemas(
  incomingTools: ToolDefinition[],
  templateTools: ToolDefinition[],
): ToolDefinition[] {
  if (!hasCompleteToolSchemas(templateTools) || incomingTools.length !== templateTools.length) {
    return incomingTools;
  }

  return incomingTools.map((tool, index) => {
    if ("input_schema" in tool) {
      return tool;
    }

    const templateTool = templateTools[index];
    return templateTool && "input_schema" in templateTool
      ? { ...tool, input_schema: templateTool.input_schema }
      : tool;
  });
}
