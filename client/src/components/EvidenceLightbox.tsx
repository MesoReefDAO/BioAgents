/**
 * Inline evidence lightbox. The default affordance for fact
 * citations on the library and research brain pages. The dedicated
 * `/viewer/:sourceId` route is the "open in tab" escalation.
 *
 * Behavior contract (spec §Evidence Lightbox Component):
 *   - Modal overlay over the current page
 *   - Esc closes, focus returns to the triggering element
 *   - Custom focus trap (no third-party lib)
 *   - "Open in tab" button opens `/viewer/:sourceId#bbox=...`
 *   - Supports all 4 provenance types (table|figure|chunk|text-only)
 *
 * v1 is intentionally read-only — no inline editing, no char-level
 * offsets. The text-only badge is rendered in the toolbar when
 * `provenance.type === "text-only"` (no overlay is drawn for it).
 */
import { useCallback, useEffect, useRef } from "preact/hooks";

import { EvidenceViewer } from "./EvidenceViewer";
import { useProvenance, buildViewerHash, ProvenanceType } from "../hooks/useProvenance";
import { usePdfDocument } from "../hooks/usePdfDocument";
import { BBox } from "../lib/bbox";

interface EvidenceLightboxProps {
  factId: string | null;
  isOpen: boolean;
  onClose: () => void;
  // Element that triggered the lightbox — focus returns here on close.
  triggerRef?: { current: HTMLElement | null };
}

export function EvidenceLightbox({
  factId,
  isOpen,
  onClose,
  triggerRef,
}: EvidenceLightboxProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const openInTabRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const { data, isLoading: provLoading, error: provError } =
    useProvenance(factId);

  // The lightbox only needs the sourceId for the PDF doc; the bbox
  // and type come from the provenance payload.
  const sourceId = data?.sourceId ?? null;
  const { doc, isLoading: pdfLoading, error: pdfError, numPages } =
    usePdfDocument(isOpen && sourceId ? sourceId : null);

  // Remember the previously-focused element so we can restore on
  // close. The spec calls for "focus returns to the fact citation
  // that opened it" — the triggerRef is the canonical reference.
  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current =
      triggerRef?.current ?? (document.activeElement as HTMLElement | null);
    // Move focus into the dialog immediately so screen readers
    // announce it. The "Open in tab" button is the primary action.
    openInTabRef.current?.focus();
    return () => {
      // Restore focus on unmount/close.
      previousFocusRef.current?.focus?.();
    };
  }, [isOpen, triggerRef]);

  // Esc closes the lightbox. The handler is attached at the document
  // level so it fires regardless of which descendant has focus.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        // Focus trap: cycle Tab and Shift+Tab within the dialog's
        // focusable elements. ~20 lines, no third-party lib.
        const root = containerRef.current;
        if (!root) return;
        const focusables = root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Lock body scroll while the modal is open.
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  const handleOpenInTab = useCallback(() => {
    if (!data) return;
    const { sourceId, provenance } = data;
    if (!sourceId) return;
    const bbox = provenance.bbox ?? null;
    const type: ProvenanceType = provenance.type;
    const page = bbox?.page ?? provenance.chunk?.page ?? 1;
    const hash = buildViewerHash({ bbox, page, type });
    window.open(`/viewer/${sourceId}${hash}`, "_blank", "noopener,noreferrer");
    onClose();
  }, [data, onClose]);

  if (!isOpen) return null;

  const { provenance, sourceTitle } = data ?? {};
  const bbox: BBox | null = provenance?.bbox ?? null;
  const page: number = bbox?.page ?? provenance?.chunk?.page ?? 1;
  const type: ProvenanceType = provenance?.type ?? "chunk";

  return (
    <div
      className="evidence-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Source evidence for ${sourceTitle ?? "fact"}`}
    >
      <div
        className="evidence-lightbox__backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={containerRef}
        className="evidence-lightbox__dialog"
        data-provenance-lightbox
      >
        <header className="evidence-lightbox__header">
          <div className="evidence-lightbox__titlewrap">
            <h2 className="evidence-lightbox__title">
              {sourceTitle ?? "Source PDF"}
            </h2>
            <span className="evidence-lightbox__subtitle">
              Fact {factId ?? "—"}
            </span>
            {/*
              PR #3 of `bioprospecting-compound-authority` — show
              InChIKey + PubChem CID in the lightbox header when
              the fact has a resolved canonical. The compound object
              is populated by the server-side embed added in
              `getBioprospectingFact` (FK to `research_compounds`).
              The block is hidden entirely when the fact has no
              canonical (the resolve is still pending or was an
              extract). The user still gets the badge on the fact
              card outside the lightbox, so the absence of the
              block here is consistent with "nothing to show yet".
            */}
            {data?.compound?.canonicalName ? (
              <div className="evidence-lightbox__compound">
                <span className="evidence-lightbox__compound-name">
                  {data.compound.canonicalName}
                </span>
                {data.compound.inchiKey ? (
                  <span className="evidence-lightbox__compound-meta">
                    InChIKey: <code>{data.compound.inchiKey}</code>
                  </span>
                ) : null}
                {data.compound.pubchemCid != null ? (
                  <span className="evidence-lightbox__compound-meta">
                    PubChem CID: <code>{data.compound.pubchemCid}</code>
                  </span>
                ) : null}
                {data.compound.molecularFormula ? (
                  <span className="evidence-lightbox__compound-meta">
                    Formula: <code>{data.compound.molecularFormula}</code>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="evidence-lightbox__actions">
            <button
              ref={openInTabRef}
              type="button"
              className="evidence-lightbox__btn evidence-lightbox__btn--primary"
              onClick={handleOpenInTab}
              disabled={!data?.sourceId}
              aria-label="Open in dedicated viewer tab"
            >
              Open in tab
            </button>
            <button
              type="button"
              className="evidence-lightbox__btn"
              onClick={onClose}
              aria-label="Close evidence lightbox"
            >
              Close
            </button>
          </div>
        </header>
        {provError ? (
          <div className="evidence-lightbox__error">{provError}</div>
        ) : null}
        {provLoading || !data ? (
          <div className="evidence-lightbox__loading">Loading provenance…</div>
        ) : (
          <EvidenceViewer
            doc={doc}
            isLoading={pdfLoading}
            error={pdfError}
            numPages={numPages}
            bbox={bbox}
            type={type}
            page={page}
          />
        )}
      </div>
    </div>
  );
}
