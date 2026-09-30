/**
 * Grapher Semantic Design Tokens (TypeScript)
 * 用于 React Flow SVG 画布与 JS 计算的语义化设计令牌常量
 */

export const tokens = {
  /* 基础背景与画布 */
  bgCanvas: "#FFFFFF",

  /* 边框与分割线 */
  borderDefault: "#E2E8F0",

  /* 文本与图标 */
  textSecondary: "#64748B",

  /* 画布专用令牌 */
  graphGridDot: "#CBD5E1",
  graphEdgeDefault: "#94A3B8",
  graphEdgeFeedback: "#8B5CF6",
  graphEdgeFeedbackBg: "#F5F3FF",
  graphEdgeFeedbackText: "#7C3AED",
} as const;
