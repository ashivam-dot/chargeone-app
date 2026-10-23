import { useState } from 'preact/hooks';
import { lazy } from '../shell/lazy.tsx';
import { CarHero } from './CarHero.tsx';
import type { Car3DProps } from './Car3D.tsx';
import { glInfo } from '../../lib/gpu.ts';

// three.js is about 150 KB, so the 3D car loads only when a car is on screen; the drawing shows meanwhile.
const Car3D = lazy<Car3DProps>(() => import('./Car3D.tsx').then((m) => m.Car3D), () => <span />);

type Props = Omit<Car3DProps, 'onReady' | 'onError' | 'software'> & { arrive?: boolean };

/** The car in 3D where the device can draw it, and the flat illustration everywhere else. */
export function CarStage(props: Props) {
  const gl = glInfo();
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(gl.ok ? 'loading' : 'failed');
  return (
    <div class={`car-view car-view--${state}`} data-connected={String(props.connected)} data-testid="car-view">
      {state !== 'ready' && <CarHero {...props} />}
      {state !== 'failed' && (
        <Car3D key={props.modelId} {...props} software={gl.software} onReady={() => setState('ready')} onError={() => setState('failed')} />
      )}
    </div>
  );
}
