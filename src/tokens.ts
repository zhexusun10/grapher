/**
 * Grapher Semantic Design Tokens (TypeScript)
 * 用于 React Flow SVG 画布与 JS 计算的语义化设计令牌常量
 */

export const tokens = {
  /* 基础背景与画布 */
  bgCanvas: "#FFFFFF",
  bgDefault: "#FFFFFF",

  /* 容器与表面 */
  bgSurface: "#F8FAFC",
  bgSurfaceHover: "#F1F5F9",
  bgSurfaceActive: "#E2E8F0",

  /* 边框与分割线 */
  borderDefault: "#E2E8F0",
  borderSubtle: "#F1F5F9",
  borderFocus: "#2563EB",

  /* 文本与图标 */
  textPrimary: "#0F172A",
  textSecondary: "#64748B",
  textInverse: "#FFFFFF",

  /* 品牌色体系 */
  brandDefault: "#2563EB",
  brandHover: "#1D4ED8",
  brandActive: "#1E40AF",
  brandSubtle: "#EFF6FF",
  brandBorder: "#BFDBFE",

  /* 危险与警告状态 */
  statusDanger: "#EF4444",
  statusDangerSubtle: "#FEF2F2",
  statusDangerBorder: "#FECACA",
  statusDangerText: "#991B1B",

  /* 成功与告警扩展状态 */
  statusSuccess: "#10B981",
  statusSuccessSubtle: "#ECFDF5",
  statusSuccessBorder: "#A7F3D0",
  statusWarning: "#F59E0B",
  statusWarningSubtle: "#FFFBEB",

  /* 遮罩与画布专用令牌 */
  bgOverlay: "rgba(15, 23, 42, 0.45)",
  graphGridDot: "#CBD5E1",
  graphEdgeDefault: "#94A3B8",
  graphEdgeFeedback: "#8B5CF6",
  graphEdgeFeedbackBg: "#F5F3FF",
  graphEdgeFeedbackText: "#7C3AED",
} as const;

export type DesignTokens = typeof tokens;
