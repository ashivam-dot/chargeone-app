// Dev-only page for tuning car designs against reference photos (not part of the app build).
// npx vite, then http://localhost:5173/lab/car.html?id=tata-nexon-ev&view=side|front34|rear34|front|rear|top
import { ACESFilmicToneMapping, Color, DirectionalLight, HemisphereLight, PerspectiveCamera, Scene, SRGBColorSpace, WebGLRenderer } from 'three';
import { studioEnvironment } from '../src/ui/car/carStudio.ts';
import { buildCar } from '../src/ui/car/carMesh.ts';
import { designFor } from '../src/ui/car/carDesigns.ts';

const q = new URLSearchParams(location.search);
const { design } = designFor(q.get('id') ?? 'tata-nexon-ev');
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(2);
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.outputColorSpace = SRGBColorSpace;
const scene = new Scene();
scene.background = new Color(q.get('bg') ?? '#c4c7cc');

scene.environment = studioEnvironment(renderer).texture;
renderer.toneMappingExposure = 1.15;
scene.add(new HemisphereLight('#ffffff', '#202024', 1.0));
const key = new DirectionalLight('#ffffff', 2);
key.position.set(4, 7, 5);
scene.add(key);

const car = buildCar(design, q.get('paint') ?? design.paints[0]?.hex ?? '#8f9a92');
scene.add(car.group);
const L = car.length;
const camera = new PerspectiveCamera(q.get('view') === 'side' ? 11 : 20, innerWidth / innerHeight, 0.1, 200);
// Framed so the car fills most of a 900 x 520 shot.
const views: Record<string, [number, number, number]> = {
  side: [0, 0.8, L * 4.4],
  front34: [L * 1.32, 1.5, L * 1.32],
  rear34: [-L * 1.32, 1.5, L * 1.32],
  front: [L * 1.45, 0.95, 0],
  close: [L * 0.95, 1.1, L * 0.7],
  closeRear: [-L * 0.95, 1.1, L * 0.7],
  rear: [-L * 1.45, 0.95, 0],
  top: [0, 26, 0.01],
};
const v = views[q.get('view') ?? 'front34'] ?? views.front34;
camera.position.set(...v);
camera.lookAt(0, (design.heightMm / 1000) * 0.45, 0);
renderer.render(scene, camera);
(window as unknown as { __ready: boolean }).__ready = true;
