import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from '../icons.js';

/**
 * Full-screen image viewer for plan screenshots.
 *
 * A before/after screenshot is unreadable at the reading column's width, so
 * clicking any rendered image opens it here at native size. Closes on Escape,
 * on the backdrop, and on the close button.
 */
export function ImageLightbox({
  src,
  alt,
  line,
  onClose,
}: {
  src: string;
  alt: string;
  /** Source line the image sits on, shown as context in the caption. */
  line?: number | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal
      aria-label={alt || 'Image'}
      onClick={onClose}
      className="fixed inset-0 z-[90] flex animate-fade-in flex-col items-center justify-center gap-3 bg-black/80 p-6 backdrop-blur-sm"
    >
      <button
        onClick={onClose}
        aria-label="Close image"
        className="absolute right-4 top-4 rounded-lg bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
      >
        <IconX className="h-4 w-4" />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-h-[82vh] max-w-full rounded-xl border border-white/15 bg-surface-1 object-contain shadow-pop"
      />
      <div className="flex flex-col items-center gap-1">
        {alt && <p className="max-w-2xl text-center text-[13px] font-medium text-white/90">{alt}</p>}
        <p className="text-[11px] text-white/45">
          {line != null ? `line ${line} · ` : ''}click anywhere or press Esc to close
        </p>
      </div>
    </div>,
    document.body,
  );
}
