import { haptic } from '../../native/platform.ts';
import { paintsFor } from './carPaints.ts';

interface Props {
  modelId: string;
  paint: string;
  onPaint: (hex: string) => void;
  small?: boolean;
}

/** The car's own factory colours; a colour from elsewhere (an RC lookup, another car) stays as its own swatch. */
export function PaintSwatches({ modelId, paint, onPaint, small }: Props) {
  const paints = paintsFor(modelId);
  const known = paints.some((p) => p.hex.toLowerCase() === paint.toLowerCase());
  const list = known ? paints : [...paints, { name: 'Your colour', hex: paint }];
  return (
    <div class={small ? 'swatches swatches--small' : 'swatches'} role="radiogroup" aria-label="Paint">
      {list.map((p) => (
        <button
          key={p.hex + p.name}
          class="swatch"
          role="radio"
          aria-checked={p.hex.toLowerCase() === paint.toLowerCase()}
          aria-label={p.name}
          title={p.name}
          style={{ '--c': p.hex }}
          onClick={() => {
            void haptic('selection');
            onPaint(p.hex);
          }}
        />
      ))}
    </div>
  );
}
