/**
 * Shared type-like docs for runtime objects.
 *
 * Trajectory:
 * {
 *   id: string,
 *   model: string,
 *   prompt: string,
 *   success: boolean,
 *   userFeedback: number, // -1.0 .. 1.0
 *   latencyMs: number,
 *   costUsd: number,
 *   safetyIncidents: number,
 *   toolCalls: Array<{
 *     toolName: string,
 *     success: boolean,
 *     latencyMs: number,
 *     riskScore?: number
 *   }>
 * }
 *
 * PolicyGenome:
 * {
 *   id: string,
 *   baseModel: string,
 *   systemPrompt: string,
 *   responseStyle: "concise" | "balanced" | "detailed",
 *   toolPreferences: Record<string, number>, // 0..1
 *   toolRetryBudget: number,
 *   deliberationBudget: number,
 *   memoryDepth: number,
 *   safeguards: {
 *     maxRiskScore: number,
 *     disallowedTools: string[]
 *   },
 *   mutationTrace: string[]
 * }
 */

export const RESPONSE_STYLES = ["concise", "balanced", "detailed"];

