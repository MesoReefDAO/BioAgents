/**
 * Pure highlight div renderer.
 *
 * Per the design (§7.8), each provenance type gets a distinct color:
 *   - table  → blue  (3b82f6)
 *   - figure → purple (a855f7)
 *   - chunk  → yellow (eab308)
 *   - text-only → no overlay (the badge is the signal)
 *
 * The component is a controlled renderer — it does not fetch or
 * compute bboxes; the parent passes them in. This keeps it pure
 * and trivially testable. Multiple bboxes render as one div each
 * (spec scenario "Multiple bboxes render as multiple highlights").
 */
import { BBox, bboxToPixels } from "../lib/bbox";
import { ProvenanceType } from "../hooks/useProvenance";

interface BboxOverlayProps {
  bbox: BBox | null;
  type: ProvenanceType;
  className?: string;
}

const TYPE_CLASS: Record<Exclude<ProvenanceType, "text-only">, string> = {
  table: "provenance-bbox--table",
  figure: "provenance-bbox--figure",
  chunk: "provenance-bbox--chunk",
};

export function BboxOverlay({ bbox, type, className }: BboxOverlayProps) {
  if (!bbox || type === "text-only") return null;
  const pixels = bboxToPixels(bbox);
  const klass = `provenance-bbox ${TYPE_CLASS[type]} ${className ?? ""}`.trim();
  return (
    <div
      className={klass}
      data-provenance-type={type}
      style={{
        position: "absolute",
        left: `${pixels.left}px`,
        top: `${pixels.top}px`,
        width: `${pixels.width}px`,
        height: `${pixels.height}px`,
        pointerEvents: "none",
      }}
      aria-hidden="true"
    />
  );
}
