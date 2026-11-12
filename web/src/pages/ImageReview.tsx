import { useEffect, useRef, useState } from "react";

/**
 * Look at one picture properly. A review, not an editor: the image at the size the window allows, what it is called,
 * and a way out. Escape and a click outside both close it, because a dialog nobody can dismiss is a trap.
 *
 * The backdrop is a real button, so a pointer and a keyboard reach the same dismissal without a handler on a div.
 */
export function ImageReview({
  src,
  alt,
  caption,
  onClose,
}: {
  src: string;
  alt: string;
  caption?: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus lands on the way out, and Escape is listened for on the document: nothing inside the dialog should have to
  // capture the key for it to work.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section
      aria-label="Image review"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.82)",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
        zIndex: 50,
      }}
    >
      {/* Behind the panel and the full size of the window: clicking anywhere outside the picture closes the review. */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close the image review by clicking outside it"
        style={{
          position: "absolute",
          inset: 0,
          background: "transparent",
          border: "none",
          cursor: "zoom-out",
        }}
      />
      <figure
        style={{
          position: "relative",
          margin: 0,
          maxWidth: "min(1200px, 92vw)",
          maxHeight: "92vh",
          textAlign: "center",
        }}
      >
        <img
          src={src}
          alt={alt}
          aria-label={alt}
          style={{
            maxWidth: "100%",
            maxHeight: "82vh",
            // max-* never enlarges, so without a floor a one-pixel asset would be invisible rather than small.
            minWidth: 240,
            minHeight: 240,
            objectFit: "contain",
            borderRadius: 8,
            boxShadow: "0 12px 40px rgba(0, 0, 0, 0.6)",
            background: "#000",
          }}
        />
        <figcaption className="row" style={{ gap: "0.6rem", justifyContent: "center", marginTop: "0.6rem" }}>
          <span className="muted" style={{ fontSize: 13 }}>
            {caption ?? alt}
          </span>
          <button type="button" ref={closeRef} onClick={onClose} aria-label="Close the image review">
            Close
          </button>
        </figcaption>
      </figure>
    </section>
  );
}

/**
 * A picture that opens itself. The review is per thumbnail rather than per page, so a table of frames needs no state
 * threaded through its rows to get the same behaviour the library has.
 */
export function Thumb({
  src,
  alt,
  caption,
  width,
  height,
  radius = 4,
}: {
  src: string;
  alt: string;
  caption?: string;
  width: number;
  height: number;
  radius?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="thumb"
        aria-label={`Review ${alt}`}
        title={alt}
        onClick={() => setOpen(true)}
      >
        <img
          src={src}
          alt={alt}
          style={{ width, height, objectFit: "cover", borderRadius: radius, background: "#000" }}
        />
      </button>
      {open ? <ImageReview src={src} alt={alt} caption={caption} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
