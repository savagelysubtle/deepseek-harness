/**
 * Spawn-time cost guard: refuse to start a child whose final model id (or the name the model
 * catalog gives it) names the denied model family. The compiler and the tier table already check
 * the strings a workflow author writes; this check covers a model that is only named once the
 * final id is resolved, such as an inherited parent model or a catalog name. It is a cost guard,
 * not a security boundary: a custom provider can still route an innocuous id to any backend.
 * @module @deepseek-ai/dsh-workflow-worker-thread/model-guard
 */

/**
 * Whether text names the denied family in any spelling: NFKC and case folded, invisible format
 * characters removed, and separator-split forms squashed.
 * @param text - a model id or model name.
 * @returns true when the folded text contains the denied family.
 */
export function namesDeniedModel(text: string): boolean {
  const folded = text.normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase()
  return folded.includes('fable') || folded.replace(/[^a-z0-9]/g, '').includes('fable')
}
