import { TOOL_IDS, TOOL_INFO, type ToolId } from "../../core/types.ts";

export { TOOL_IDS, TOOL_INFO };
export type { ToolId };

export const toolLabel = (tool: ToolId) => TOOL_INFO[tool]?.label ?? tool;

/** Series colors. Codex uses the contrast ink like T3; the rest keep each tool's brand hue. */
export function toolColor(tool: ToolId): string {
  if (tool === "codex") return "var(--contrast-foreground)";
  if (tool === "grok") return "color-mix(in oklab, var(--contrast-foreground) 72%, var(--background))";
  return TOOL_INFO[tool]?.color ?? "#888";
}

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function platformLabel(platform: string): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform;
}
