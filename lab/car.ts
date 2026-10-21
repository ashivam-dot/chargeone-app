// Dev-only page for tuning car designs against reference photos (not part of the app build).
// npx vite, then http://localhost:5173/lab/car.html?id=tata-nexon-ev&view=side|front34|rear34|front|rear|top
import { ACESFilmicToneMapping, Color, DirectionalLight, HemisphereLight, PerspectiveCamera, PMREMGenerator, Scene, SRGBColorSpace, WebGLRenderer } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
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
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new HemisphereLight('#ffffff', '#202024', 1.0));
const key = new DirectionalLight('#ffffff', 2);
key.position.set(4, 7, 5);
scene.add(key);

const car = buildCar(design, q.get('paint') ?? design.paints[0]?.hex ?? '#8f9a92');
scene.add(car.group);
const L = car.length;
const camera = new PerspectiveCamera(q.get('view') === 'side' ? 11 : 20, innerWidth / innerHeight, 0.1, 200);
const views: Record<string, [number, number, number]> = {
  side: [0, 0.8, 26],
  front34: [L * 1.5, 1.6, L * 1.5],
  rear34: [-L * 1.5, 1.6, L * 1.5],
  front: [L * 2.6, 0.9, 0],
  rear: [-L * 2.6, 0.9, 0],
  top: [0, 26, 0.01],
};
const v = views[q.get('view') ?? 'front34'] ?? views.front34;
camera.position.set(...v);
camera.lookAt(0, (design.heightMm / 1000) * 0.45, 0);
renderer.render(scene, camera);
(window as unknown as { __ready: boolean }).__ready = true;
