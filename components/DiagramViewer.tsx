'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

// A drawn diagram that can be zoomed and moved around: the buttons, Ctrl or Cmd with the scroll
// wheel (a trackpad pinch arrives the same way), a pinch on a touch screen, and a double click
// zoom; dragging moves the drawing. On the page a plain scroll still scrolls the page, and one
// finger only moves the drawing once it is zoomed in, so the page stays easy to read past it.
// Full screen gives the drawing the whole window, where the plain scroll wheel zooms too.

type View = { scale: number; x: number; y: number };
const FIT: View = { scale: 1, x: 0, y: 0 };
const MIN = 0.5;
const MAX = 10;
const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));

function Viewer({ svg, full, onFull, onClose }: { svg: string; full: boolean; onFull?: () => void; onClose?: () => void }) {
  const [view, setView] = useState<View>(FIT);
  const box = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: View; dist: number; mid: { x: number; y: number }; at: { x: number; y: number } } | null>(null);

  // Zoom by a factor, keeping the point under (px, py) in place
  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    setView((v) => {
      const r = box.current?.getBoundingClientRect();
      const cx = px ?? (r ? r.width / 2 : 0);
      const cy = py ?? (r ? r.height / 2 : 0);
      const scale = clamp(v.scale * factor);
      const k = scale / v.scale;
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // The wheel listener must not be passive, so it can keep the page from scrolling while zooming
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!full && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const p = local(e);
      // A mouse wheel notch is about 100; a trackpad pinch sends many small steps
      zoomAt(Math.exp(-Math.max(-40, Math.min(40, e.deltaY)) * 0.01), p.x, p.y);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [full, zoomAt]);

  function begin() {
    const pts = [...pointers.current.values()];
    if (!pts.length) return (gesture.current = null);
    const mid = pts.length > 1 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
    const dist = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { view, dist, mid, at: mid };
  }

  function onPointerDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return;
    // On the page, one finger at the fitted size is left to scroll the page
    if (e.pointerType === 'touch' && !full && view.scale <= 1 && pointers.current.size === 0) {
      pointers.current.set(e.pointerId, local(e));
      gesture.current = null;
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    begin();
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, local(e));
    if (!gesture.current && pointers.current.size > 1) begin();
    const g = gesture.current;
    if (!g) return;
    const pts = [...pointers.current.values()];
    if (pts.length > 1 && g.dist) {
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const scale = clamp(g.view.scale * (Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) / g.dist));
      const k = scale / g.view.scale;
      setView({ scale, x: mid.x - (g.mid.x - g.view.x) * k, y: mid.y - (g.mid.y - g.view.y) * k });
    } else {
      setView({ ...g.view, x: g.view.x + pts[0].x - g.at.x, y: g.view.y + pts[0].y - g.at.y });
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    // The fingers left over carry on from where the drawing is now
    if (gesture.current) begin();
  }

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
      else if (e.key === '+' || e.key === '=') zoomAt(1.25);
      else if (e.key === '-') zoomAt(0.8);
      else if (e.key === '0') setView(FIT);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [full, onClose, zoomAt]);

  const zoomed = view.scale !== 1 || view.x !== 0 || view.y !== 0;
  return (
    <div
      ref={box}
      className={`diagram-view${full ? ' full' : ''}${view.scale > 1 ? ' zoomed' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        const p = local(e);
        zoomAt(2, p.x, p.y);
      }}
    >
      <div className="diagram-tools">
        <button className="btn small" onClick={() => zoomAt(1 / 1.5)} aria-label="Zoom out" title="Zoom out">
          −
        </button>
        <button className="btn small" onClick={() => zoomAt(1.5)} aria-label="Zoom in" title="Zoom in">
          +
        </button>
        <button className="btn small" disabled={!zoomed} onClick={() => setView(FIT)} title="Fit the whole diagram">
          Fit
        </button>
        {full ? (
          <button className="btn small" onClick={onClose}>
            Close
          </button>
        ) : (
          <button className="btn small" onClick={onFull}>
            Full screen
          </button>
        )}
      </div>
      <div
        className="diagram-canvas"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}

export default function DiagramViewer({ svg }: { svg: string }) {
  const [full, setFull] = useState(false);
  return (
    <>
      <Viewer svg={svg} full={false} onFull={() => setFull(true)} />
      {full && (
        <div className="diagram-overlay" role="dialog" aria-label="Diagram">
          <Viewer svg={svg} full onClose={() => setFull(false)} />
        </div>
      )}
    </>
  );
}
