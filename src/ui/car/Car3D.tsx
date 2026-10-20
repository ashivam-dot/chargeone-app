import { useEffect, useRef } from 'preact/hooks';
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  Box3,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  RingGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { car3dFor } from './models3d.ts';

export interface Car3DProps {
  modelId: string;
  paint: string;
  connected: boolean;
  driving: boolean;
  charging: boolean;
  speedKmh?: number | null;
  label: string;
  /** Called once the model is on screen, so the flat drawing behind it can fade out. */
  onReady?: () => void;
  onError?: () => void;
}

const CAR_LENGTH = 4.4;
const ARRIVE_MS = 1700;

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

export function Car3D(props: Car3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<Live>({ paint: props.paint, connected: props.connected, driving: props.driving, charging: props.charging, speedKmh: props.speedKmh ?? 0 });
  live.current = { paint: props.paint, connected: props.connected, driving: props.driving, charging: props.charging, speedKmh: props.speedKmh ?? 0 };
  const callbacks = useRef({ onReady: props.onReady, onError: props.onError });
  callbacks.current = { onReady: props.onReady, onError: props.onError };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      callbacks.current.onError?.();
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    renderer.outputColorSpace = SRGBColorSpace;

    const scene = new Scene();
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    scene.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose?.();

    scene.add(new HemisphereLight('#c9f4ff', '#0b1220', 1.1));
    const key = new DirectionalLight('#ffffff', 2.2);
    key.position.set(4, 7, 5);
    scene.add(key);
    const rim = new DirectionalLight('#67e8f9', 1.4);
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
    const ringMat = new MeshBasicMaterial({ color: new Color('#22d3ee'), transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false });
    const ring = new Mesh(new RingGeometry(2.5, 2.56, 160), ringMat);
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

    const wheels: Mesh[] = [];
    let wheelRadius = 0.35;
    let axle = new Vector3(0, 0, 1);
    let paintMat: MeshPhysicalMaterial | null = null;
    const headlights: MeshPhysicalMaterial[] = [];
    const taillights: MeshPhysicalMaterial[] = [];
    let ready = false;
    let disposed = false;
    const model = car3dFor(props.modelId);

    new GLTFLoader()
      .loadAsync(model.url)
      .then((gltf) => {
        if (disposed) return disposeTree(gltf.scene);
        const root = gltf.scene;
        root.updateMatrixWorld(true);
        const body = new Box3().setFromObject(root);
        const size = body.getSize(new Vector3());
        // Lay the car along x so the camera sees it in three-quarter view; the wheels turn about z.
        if (size.z > size.x) {
          root.rotation.y = Math.PI / 2;
          root.updateMatrixWorld(true);
        }
        root.traverse((o) => {
          const mesh = o as Mesh;
          if (!mesh.isMesh) return;
          const swap = (mat: Material): Material => {
            const name = mat.name;
            const base = mat as MeshPhysicalMaterial;
            if (name === model.paintMaterial) {
              paintMat ??= new MeshPhysicalMaterial({ color: new Color(live.current.paint), metalness: 0.35, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.05 });
              return paintMat;
            }
            if (/window|glass/i.test(name)) return new MeshPhysicalMaterial({ color: '#0b1220', metalness: 0.2, roughness: 0.04, clearcoat: 1 });
            if (/headlight/i.test(name)) {
              const m = new MeshPhysicalMaterial({ color: '#f8fafc', emissive: new Color('#bdf4ff'), emissiveIntensity: 0, roughness: 0.2 });
              headlights.push(m);
              return m;
            }
            if (/tail/i.test(name)) {
              const m = new MeshPhysicalMaterial({ color: '#7f1d1d', emissive: new Color('#ef4444'), emissiveIntensity: 0.15, roughness: 0.3 });
              taillights.push(m);
              return m;
            }
            if (/black|tyre|tire|rubber/i.test(name)) return new MeshPhysicalMaterial({ color: '#0a0a0c', roughness: 0.85 });
            if (/grey|gray|rim|chrome/i.test(name)) return new MeshPhysicalMaterial({ color: base.color ?? '#9aa3af', metalness: 0.9, roughness: 0.28 });
            return mat;
          };
          mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
          if (/wheel/i.test(mesh.name)) {
            // Move each wheel's pivot to its own centre so it spins in place.
            mesh.geometry.computeBoundingBox();
            const c = mesh.geometry.boundingBox!.getCenter(new Vector3());
            mesh.geometry.translate(-c.x, -c.y, -c.z);
            mesh.position.add(c.multiply(mesh.scale).applyQuaternion(mesh.quaternion));
            const ws = mesh.geometry.boundingBox!.getSize(new Vector3());
            wheelRadius = Math.max(ws.x, ws.y, ws.z) / 2 || wheelRadius;
            wheels.push(mesh);
          }
        });
        // Wheel geometry is in the root's frame, where the axle is the body's narrower horizontal axis.
        axle = size.z > size.x ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1);
        const scale = CAR_LENGTH / Math.max(size.x, size.z);
        root.scale.multiplyScalar(scale);
        wheelRadius *= scale;
        root.updateMatrixWorld(true);
        const placed = new Box3().setFromObject(root);
        const centre = placed.getCenter(new Vector3());
        root.position.set(-centre.x, -placed.min.y, -centre.z);
        car.add(root);
        ready = true;
        callbacks.current.onReady?.();
        kick();
      })
      .catch(() => callbacks.current.onError?.());

    // Motion state.
    const t0 = performance.now();
    let last = t0;
    let spin = 0;
    let dragging = false;
    let dragX = 0;
    let velocity = reduce ? 0 : 0.14;
    let raf = 0;
    let visible = true;
    let shownPaint = live.current.paint;

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
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const l = live.current;
      if (paintMat && l.paint !== shownPaint) {
        paintMat.color.set(l.paint);
        shownPaint = l.paint;
      }
      for (const h of headlights) h.emissiveIntensity += ((l.connected ? 2.2 : 0) - h.emissiveIntensity) * Math.min(1, dt * 6);
      for (const t of taillights) t.emissiveIntensity = l.driving ? 1.2 : l.connected ? 0.6 : 0.15;

      // Arrival: the car rolls in from the left and settles on its springs.
      const p = reduce ? 1 : Math.min(1, (now - t0) / ARRIVE_MS);
      const ease = 1 - (1 - p) ** 3;
      const prevX = car.position.x;
      car.position.x = (1 - ease) * -9;
      let roll = car.position.x - prevX;
      const settle = p < 1 ? 0 : Math.exp(-(now - t0 - ARRIVE_MS) / 260) * Math.sin((now - t0 - ARRIVE_MS) / 55);
      car.position.y = settle * 0.025;
      car.rotation.z = p < 1 ? -0.015 * (1 - ease) : settle * 0.01;

      if (l.driving && !reduce) {
        roll += (Math.max(8, l.speedKmh) / 3.6) * dt * 0.35;
        car.position.y += Math.sin(now / 47) * 0.004;
      }
      spin -= roll / wheelRadius;
      for (const w of wheels) w.setRotationFromAxisAngle(axle, spin);

      // Turntable with inertia; a drag spins it by hand.
      if (!dragging && !reduce) velocity += ((l.driving ? 0 : 0.14) - velocity) * Math.min(1, dt * 1.5);
      if (!dragging) stage.rotation.y += velocity * dt;

      const glow = l.charging ? 0.5 + 0.5 * Math.sin(now / 320) : 0;
      ringMat.color.set(l.charging ? '#34d399' : '#22d3ee');
      ringMat.opacity = 0.35 + (l.connected ? 0.3 : 0) + glow * 0.3;
      const wave = l.charging && !reduce ? ((now / 1600) % 1) : 0;
      pulse.scale.setScalar(1 + wave * 0.35);
      pulseMat.color.copy(ringMat.color);
      pulseMat.opacity = l.charging ? (1 - wave) * 0.35 : 0;

      renderer.render(scene, camera);
      const moving = !reduce && (p < 1 || Math.abs(velocity) > 0.001 || l.driving || l.charging || settle !== 0);
      if (visible && !document.hidden && (moving || dragging)) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf && visible) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    const onDown = (e: PointerEvent) => {
      if (!ready) return;
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
      velocity = (dx * Math.PI * 1.6) / (1 / 60);
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
      kick();
    });
    io.observe(canvas);
    const onVisibility = () => kick();
    document.addEventListener('visibilitychange', onVisibility);
    resize();
    kick();
    (canvas as HTMLCanvasElement & { kick?: () => void }).kick = kick;

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      disposeTree(scene);
      scene.environment?.dispose();
      pmrem.dispose();
      renderer.dispose();
    };
  }, [props.modelId]);

  // Paint, lights and driving changes restart the loop if it had come to rest.
  useEffect(() => {
    (canvasRef.current as (HTMLCanvasElement & { kick?: () => void }) | null)?.kick?.();
  }, [props.paint, props.connected, props.driving, props.charging]);

  const model = car3dFor(props.modelId);
  return (
    <div class="car3d">
      <canvas
        ref={canvasRef}
        class="car3d__canvas"
        role="img"
        aria-label={props.label}
        data-testid="car-3d"
        data-motion={matchMedia('(prefers-reduced-motion: reduce)').matches ? 'still' : 'live'}
      />
      {!model.exact && <span class="car3d__note">Generic {model.url.includes('suv') ? 'SUV' : model.url.includes('sedan') ? 'sedan' : 'hatchback'} body in your colour</span>}
    </div>
  );
}
