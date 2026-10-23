import { BackSide, DoubleSide, BufferAttribute, Color, Mesh, MeshBasicMaterial, PlaneGeometry, PMREMGenerator, Scene, SphereGeometry, type Texture, type WebGLRenderer } from 'three';

// A photo-studio reflection map for the car paint and glass: a dark floor, a soft grey horizon and a few
// large overhead and side softboxes, so clearcoat shows long clean highlights along the body.

export function studioEnvironment(renderer: WebGLRenderer): { texture: Texture; dispose(): void } {
  const scene = new Scene();
  const dome = new SphereGeometry(20, 32, 16);
  const pos = dome.getAttribute('position');
  const colours = new Float32Array(pos.count * 3);
  const floor = new Color('#151619');
  const horizon = new Color('#8d9198');
  const sky = new Color('#666a72');
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 20;
    if (y < 0) c.copy(horizon).lerp(floor, Math.min(1, -y * 4));
    else c.copy(horizon).lerp(sky, Math.min(1, y * 1.6));
    colours.set([c.r, c.g, c.b], i * 3);
  }
  dome.setAttribute('color', new BufferAttribute(colours, 3));
  scene.add(new Mesh(dome, new MeshBasicMaterial({ vertexColors: true, side: BackSide })));
  const box = (w: number, h: number, intensity: number, x: number, y: number, z: number) => {
    const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(intensity, intensity, intensity), side: DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  box(14, 4, 4, 0, 12, 0); // long overhead strip
  box(6, 3, 2.5, 10, 4, 8); // key side
  box(6, 3, 1.6, -10, 4, -6); // fill
  box(10, 1.2, 2, 0, 3, -12); // rim strip
  box(10, 1.2, 1.4, 0, 3, 12);
  const pmrem = new PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.03);
  pmrem.dispose();
  scene.traverse((o) => {
    const m = o as Mesh;
    m.geometry?.dispose();
    (m.material as MeshBasicMaterial | undefined)?.dispose?.();
  });
  return { texture: rt.texture, dispose: () => rt.dispose() };
}
