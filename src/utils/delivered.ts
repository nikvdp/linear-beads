/**
 * Delivery evidence markers (MG-1207).
 *
 * A bead that was delivered via a merged PR but never transitioned in the
 * tracker is indistinguishable from unclaimed work in `lb ready` — the
 * status alone carries no delivery signal. Rather than hiding such beads,
 * `lb deliver` records explicit evidence as a canonical marker comment
 * (`<!-- lb-delivered:v1 -->`). Ready views reclassify (exclude) issues
 * with that marker; `lb ready --delivered` surfaces them so curation can
 * advance status.
 *
 * The HTML-comment form mirrors lb-mail envelope markers
 * (`<!-- lb-mail-envelope:v1`) — invisible in the Linear UI, robust to
 * prose, machine-parseable.
 */

export const DELIVERED_MARKER = "<!-- lb-delivered:v1 -->";

export function buildDeliveredCommentBody(params: { prUrl?: string; note?: string }): string {
  const lines = [DELIVERED_MARKER];
  const pr = params.prUrl?.trim();
  if (pr) {
    lines.push(`pr=${pr}`);
  }
  const note = params.note?.trim();
  if (note) {
    lines.push(note);
  }
  return lines.join("\n");
}

export function isDeliveredCommentBody(body: string): boolean {
  return body.includes(DELIVERED_MARKER);
}
