import { useEffect, useRef } from 'preact/hooks';
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RingGeometry,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
  type Material,
  type Object3D,
} from 'three';
import { studioEnvironment } from './carStudio.ts';
import { buildCar, type CarModel } from './carMesh.ts';
import { designFor } from './carDesigns.ts';
import { nextFrameDelay } from './frameBudget.ts';

export interface Car3DProps {
  modelId: string;
  paint: string;
  connected: boolean;
  driving: boolean;
  charging: boolean;
  speedKmh?: number | null;
  label: string;
  /** WebGL runs on the CPU here (see `glInfo`): draw on demand, at 1x, without antialiasing. */
  software?: boolean;
  /** Called once the model is on screen, so the flat drawing behind it can fade out. */
  onReady?: () => void;
  onError?: () => void;
}

/** Every car is shown at the same size on the stage; real proportions are kept within it. */
const CAR_LENGTH = 4.4;
const ARRIVE_MS = 1700;
const SHOWCASE_MS = 14_000;
const RING = '#2b6bff';
const RING_CHARGING = '#30d158';
/** Average frame cost (ms) above which the canvas drops to 1x pixels, and then stops its ambient motion. */
const SLOW_FRAME_MS = 18;
const VERY_SLOW_FRAME_MS = 30;

interface Live {
  paint: string;
  connected: boolean;
  driving: boolean;
  charging: boolean;
  speedKmh: number;
}

function shadowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.75)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new CanvasTexture(c);
}

function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats as Material[]) {
      for (const v of Object.values(mat)) if (v && typeof v === 'object' && 'isTexture' in v) (v as { dispose(): void }).dispose();
      mat.dispose();
    }
  });
}

/** Lets the browser handle input and paint between the expensive set-up steps, so a tap is never held for seconds. */
function yieldToMain(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return s?.yield ? s.yield() : new Promise((r) => setTimeout(r, 0));
}

/**
 * Waits, without blocking, until the GPU (or the CPU standing in for it) has finished the commands sent so far.
 * WebGL2 fences are polled asynchronously in Chrome, so the main thread stays free while shaders are linked.
 */
async function gpuIdle(renderer: WebGLRenderer, maxMs = 4000): Promise<void> {
  const gl = renderer.getContext();
  if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
    await yieldToMain();
    return;
  }
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  if (!sync) return;
  const until = performance.now() + maxMs;
  try {
    while (gl.getSyncParameter(sync, gl.SYNC_STATUS) !== gl.SIGNALED && performance.now() < until) {
      await new Promise((r) => setTimeout(r, 16));
    }
  } finally {
    gl.deleteSync(sync);
  }
}

/** Draws each not-yet-seen material on its own, waiting for the GPU in between, so every shader link is a separate task. */
async function warmUp(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, dead: () => boolean): Promise<void> {
  const meshes: Mesh[] = [];
  scene.traverse((o) => {
    if ((o as Mesh).isMesh && o.visible) meshes.push(o as Mesh);
  });
  const seen = new Set<Material>();
  for (const m of meshes) m.visible = false;
  try {
    for (const m of meshes) {
      const mats = (Array.isArray(m.material) ? m.material : [m.material]) as Material[];
      if (mats.every((x) => seen.has(x))) continue;
      for (const x of mats) seen.add(x);
      m.visible = true;
      renderer.render(scene, camera);
      m.visible = false;
      await gpuIdle(renderer);
      if (dead()) return;
    }
  } finally {
    for (const m of meshes) m.visible = true;
  }
}

function measure(name: string, start: number): void {
  try {
    performance.measure(`car3d:${name}`, { start, end: performance.now() });
  } catch {
    // Older browsers without the options form; timings are only for diagnostics.
  }
}

export function Car3D(props: Car3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<Live>({ paint: props.paint, connected: props.connected, driving: props.driving, charging: props.charging, speedKmh: props.speedKmh ?? 0 });
  live.current = { paint: props.paint, connected: props.connected, driving: props.driving, charging: props.charging, speedKmh: props.speedKmh ?? 0 };
  const callbacks = useRef({ onReady: props.onReady, onError: props.onError });
  callbacks.current = { onReady: props.onReady, onError: props.onError };
  const software = Boolean(props.software);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let dead = false;
    const cleanups: Array<() => void> = [];
    const kicker = canvas as HTMLCanvasElement & { kick?: () => void };

    const setup = async () => {
      let t = performance.now();
      let renderer: WebGLRenderer;
      try {
        renderer = new WebGLRenderer({ canvas, antialias: !software, alpha: true, powerPreference: 'low-power' });
      } catch {
        callbacks.current.onError?.();
        return;
      }
      // dispose() alone leaves the WebGL context alive until GC; browsers cap live contexts (~16), so after
      // enough Car/Explore switches the oldest one, the map's, was lost. Release it now.
      cleanups.push(() => {
        renderer.dispose();
        renderer.forceContextLoss();
      });
      let pixelRatio = software ? 1 : Math.min(devicePixelRatio, 2);
      renderer.setPixelRatio(pixelRatio);
      renderer.toneMapping = ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      renderer.outputColorSpace = SRGBColorSpace;
      measure('context', t);

      const scene = new Scene();
      cleanups.push(() => disposeTree(scene));
      scene.add(new HemisphereLight('#eef3ff', '#16181d', 1.0));
      const key = new DirectionalLight('#ffffff', 2.2);
      key.position.set(4, 7, 5);
      scene.add(key);
      const rim = new DirectionalLight('#dbe6ff', 1.1);
      rim.position.set(-5, 3, -6);
      scene.add(rim);

      const camera = new PerspectiveCamera(24, 2, 0.1, 100);
      camera.position.set(0, 1.9, 9);
      camera.lookAt(0, 0.7, 0);

      const stage = new Group();
      scene.add(stage);
      const shadow = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.scale.set(CAR_LENGTH * 1.25, CAR_LENGTH * 0.62, 1);
      shadow.position.y = 0.005;
      stage.add(shadow);
      const ringMat = new MeshBasicMaterial({ color: new Color(RING), transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false });
      const ring = new Mesh(new RingGeometry(2.5, 2.54, 160), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.01;
      stage.add(ring);
      const pulseMat = ringMat.clone();
      const pulse = new Mesh(new RingGeometry(2.35, 2.7, 160), pulseMat);
      pulse.rotation.x = -Math.PI / 2;
      pulse.position.y = 0.012;
      stage.add(pulse);

      const car = new Group();
      stage.add(car);
      stage.rotation.y = -0.55;

      await yieldToMain();
      if (dead) return;
      t = performance.now();
      let model: CarModel;
      try {
        model = buildCar(designFor(props.modelId).design, live.current.paint);
      } catch {
        callbacks.current.onError?.();
        return;
      }
      cleanups.push(() => model.dispose());
      const scale = CAR_LENGTH / model.length;
      model.group.scale.setScalar(scale);
      car.add(model.group);
      const wheelRadius = model.wheelRadius * scale;
      measure('build', t);

      await yieldToMain();
      if (dead) return;
      t = performance.now();
      const studio = studioEnvironment(renderer);
      scene.environment = studio.texture;
      cleanups.push(() => studio.dispose());
      measure('environment', t);

      await yieldToMain();
      if (dead) return;
      t = performance.now();
      if (software) {
        // A CPU WebGL links each shader on first draw, about half a second apiece, and the first full frame
        // used to hold the main thread for 2 s. Draw one piece at a time (the canvas is still transparent)
        // so each link is its own task and taps in between are handled.
        await warmUp(renderer, scene, camera, () => dead);
      } else {
        // Shaders compile off the main thread where the browser supports it (KHR_parallel_shader_compile).
        try {
          await renderer.compileAsync(scene, camera);
        } catch {
          // The first render compiles them instead.
        }
      }
      measure('compile', t);
      if (dead) return;

      // Motion state. On a CPU-drawn canvas the car arrives already parked and the turntable stays still,
      // so the screen only draws when something changes.
      let lite = software;
      const still = () => reduce || lite;
      const t0 = performance.now();
      let last = t0;
      let spin = 0;
      let dragging = false;
      let dragX = 0;
      let velocity = still() ? 0 : 0.14;
      let raf = 0;
      let timer: ReturnType<typeof setTimeout> | 0 = 0;
      let visible = true;
      let ready = false;
      let shownPaint = live.current.paint;
      let cost = 0;
      let frames = 0;
      let arrivedAt = still() ? t0 - ARRIVE_MS * 2 : t0;

      const resize = () => {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        // Keep the whole car and its ring in frame on narrow phones.
        camera.position.z = Math.max(8.8, 21 / camera.aspect);
        camera.lookAt(0, 0.8, 0);
        camera.updateProjectionMatrix();
      };

      const frame = (now: number) => {
        raf = 0;
        const began = performance.now();
        // Frames can be far apart when throttled; keep motion in real time but never jump more than a quarter second.
        const dt = Math.min(0.25, (now - last) / 1000);
        last = now;
        const l = live.current;
        if (l.paint !== shownPaint) {
          model.paint.color.set(l.paint);
          shownPaint = l.paint;
        }
        const lampsTarget = l.connected ? 2.4 : model.lampGlow;
        for (const h of model.headlights) h.emissiveIntensity = still() ? lampsTarget : h.emissiveIntensity + (lampsTarget - h.emissiveIntensity) * Math.min(1, dt * 6);
        for (const tl of model.taillights) tl.emissiveIntensity = l.driving ? 1.6 : l.connected ? 1.1 : 0.9;

        // Arrival: the car rolls in from the left and settles on its springs.
        const p = Math.min(1, (now - arrivedAt) / ARRIVE_MS);
        const ease = 1 - (1 - p) ** 3;
        const prevX = car.position.x;
        car.position.x = (1 - ease) * -9;
        let roll = car.position.x - prevX;
        const since = now - arrivedAt - ARRIVE_MS;
        const settle = p < 1 || since > 1500 ? 0 : Math.exp(-since / 260) * Math.sin(since / 55);
        car.position.y = settle * 0.025;
        car.rotation.z = p < 1 ? -0.015 * (1 - ease) : settle * 0.01;

        if (l.driving && !reduce) {
          roll += (Math.max(8, l.speedKmh) / 3.6) * dt * 0.35;
          if (!lite) car.position.y += Math.sin(now / 47) * 0.004;
        }
        spin -= roll / wheelRadius;
        for (const w of model.wheels) w.rotation.z = spin;

        // Turntable with inertia that glides to rest after a while, so an idle screen stops drawing; a drag spins it by hand.
        const idle = now - t0 > SHOWCASE_MS || still();
        if (!dragging) velocity += ((l.driving || idle ? 0 : 0.14) - velocity) * Math.min(1, dt * (idle ? 0.8 : 1.5));
        if (idle && Math.abs(velocity) < 0.002) velocity = 0;
        if (!dragging) stage.rotation.y += velocity * dt;

        const glow = l.charging && !reduce ? 0.5 + 0.5 * Math.sin(now / 320) : l.charging ? 0.5 : 0;
        ringMat.color.set(l.charging ? RING_CHARGING : RING);
        ringMat.opacity = 0.3 + (l.connected ? 0.3 : 0) + glow * 0.3;
        const wave = l.charging && !reduce ? (now / 1600) % 1 : 0;
        pulse.scale.setScalar(1 + wave * 0.35);
        pulseMat.color.copy(ringMat.color);
        pulseMat.opacity = l.charging ? (1 - wave) * 0.35 : 0;

        renderer.render(scene, camera);
        if (!ready) {
          ready = true;
          callbacks.current.onReady?.();
        }

        // Watch what a frame really costs here and get cheaper when it is a lot: first 1x pixels, then no ambient motion.
        const spent = performance.now() - began;
        cost = frames ? cost * 0.8 + spent * 0.2 : spent;
        frames += 1;
        if (frames >= 4 && cost > SLOW_FRAME_MS && pixelRatio > 1) {
          pixelRatio = 1;
          renderer.setPixelRatio(1);
          resize();
          frames = 1;
        } else if (frames >= 6 && cost > VERY_SLOW_FRAME_MS && !lite) {
          lite = true;
        }
        canvas.dataset.frameMs = cost.toFixed(1);

        const moving = !reduce && (p < 1 || Math.abs(velocity) > 0.001 || settle !== 0 || l.driving || l.charging);
        if (moving || dragging) schedule(dragging);
      };

      /** Next frame, spaced out so drawing never takes more than about a quarter of the main thread. */
      const schedule = (urgent = false) => {
        if (raf || timer || dead || !visible || document.hidden) return;
        const wait = urgent ? 0 : nextFrameDelay(cost, lite);
        if (wait <= 4) raf = requestAnimationFrame(frame);
        else
          timer = setTimeout(() => {
            timer = 0;
            if (!dead && visible && !document.hidden) raf = requestAnimationFrame(frame);
          }, wait);
      };
      const kick = () => {
        if (raf) return;
        if (timer) {
          clearTimeout(timer);
          timer = 0;
        }
        if (!visible || dead) return;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      };

      const onDown = (e: PointerEvent) => {
        dragging = true;
        dragX = e.clientX;
        velocity = 0;
        canvas.setPointerCapture(e.pointerId);
        kick();
      };
      const onMove = (e: PointerEvent) => {
        if (!dragging) return;
        const dx = (e.clientX - dragX) / Math.max(1, canvas.clientWidth);
        dragX = e.clientX;
        stage.rotation.y += dx * Math.PI * 1.6;
        velocity = still() ? 0 : (dx * Math.PI * 1.6) / (1 / 60);
        kick();
      };
      const onUp = () => {
        dragging = false;
        kick();
      };
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);

      const ro = new ResizeObserver(() => {
        resize();
        kick();
      });
      ro.observe(canvas);
      const io = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        if (visible) kick();
      });
      io.observe(canvas);
      const onVisibility = () => {
        if (!document.hidden) kick();
      };
      document.addEventListener('visibilitychange', onVisibility);
      cleanups.push(() => {
        cancelAnimationFrame(raf);
        if (timer) clearTimeout(timer);
        ro.disconnect();
        io.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        delete kicker.kick;
      });
      resize();
      kick();
      kicker.kick = kick;
    };
    void setup();

    return () => {
      dead = true;
      for (const fn of cleanups.reverse()) fn();
    };
  }, [props.modelId]);

  // Paint, lights and driving changes restart the loop if it had come to rest.
  useEffect(() => {
    (canvasRef.current as (HTMLCanvasElement & { kick?: () => void }) | null)?.kick?.();
  }, [props.paint, props.connected, props.driving, props.charging]);

  const { design, exact } = designFor(props.modelId);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  return (
    <div class="car3d">
      <canvas
        ref={canvasRef}
        class="car3d__canvas"
        role="img"
        aria-label={props.label}
        data-testid="car-3d"
        data-motion={reduced ? 'still' : software ? 'lite' : 'live'}
      />
      <span class="car3d__note" data-testid="car-3d-note">
        {exact ? `${design.name} · ChargeOne model, not an official render` : 'Generic electric SUV in your colour'}
      </span>
    </div>
  );
}
