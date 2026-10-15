// Slightly hand-drawn strokes. Seeded so a shape never jitters between renders.
import { memo } from 'react';
import rough from 'roughjs';

const gen = rough.generator();
const base = { roughness: 0.7, bowing: 0.9, strokeWidth: 1, stroke: 'currentColor', disableMultiStroke: true };

export const Sketch = memo(function Sketch({ shape, className, draw = false }) {
  return (
    <svg className={className} aria-hidden="true">
      {shape.flatMap((drawable, i) =>
        gen.toPaths(drawable).map((p, j) => (
          <path
            key={`${i}-${j}`}
            d={p.d}
            stroke={p.stroke}
            strokeWidth={p.strokeWidth}
            fill="none"
            strokeLinecap="round"
            pathLength={draw ? 1 : undefined}
            className={draw ? 'draw-in' : undefined}
          />
        )),
      )}
    </svg>
  );
});

export const line = (x1, y1, x2, y2, o) => gen.line(x1, y1, x2, y2, { ...base, ...o });
export const rect = (x, y, w, h, o) => gen.rectangle(x, y, w, h, { ...base, ...o });
export const ellipse = (x, y, w, h, o) => gen.ellipse(x, y, w, h, { ...base, ...o });
