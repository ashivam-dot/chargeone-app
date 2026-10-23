import { afterEach, describe, expect, it, vi } from 'vitest';
import { setReloadBlocker } from './reloadGuard.ts';
import { CHECK_EVERY_MS, MIN_GAP_MS, isEditing, watchForUpdates, type UpdateEnv } from './swUpdate.ts';

function emitter() {
  const fns = new Map<string, Array<() => void>>();
  return {
    addEventListener: (type: string, fn: () => void) => fns.set(type, [...(fns.get(type) ?? []), fn]),
    emit: (type: string) => fns.get(type)?.forEach((fn) => fn()),
  };
}

function setup({ controller = {} as unknown, active = null as Element | null } = {}) {
  const sw = { ...emitter(), controller };
  const win = { ...emitter(), tick: () => {}, setInterval: (fn: () => void, ms: number) => ((win.tick = fn), (win.every = ms)), every: 0 };
  const doc = { ...emitter(), visibilityState: 'visible', activeElement: active };
  const update = vi.fn(async () => undefined);
  let t = 0;
  const env = {
    sw: { ...sw, getRegistration: async () => ({ update }) },
    win,
    doc,
    now: () => t,
    reload: vi.fn(),
    offerReload: vi.fn(),
  };
  watchForUpdates(env as unknown as UpdateEnv);
  return { env, sw: env.sw, win, doc, update, advance: (ms: number) => (t += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as unknown as Element;

afterEach(() => setReloadBlocker(() => false));

describe('watchForUpdates', () => {
  it('asks for an update on focus, on becoming visible and every 30 minutes, at most once a minute', async () => {
    const s = setup();
    expect(s.win.every).toBe(CHECK_EVERY_MS);
    s.win.emit('focus');
    s.doc.emit('visibilitychange');
    await flush();
    expect(s.update).toHaveBeenCalledTimes(1);
    s.advance(MIN_GAP_MS);
    s.doc.visibilityState = 'hidden';
    s.doc.emit('visibilitychange');
    await flush();
    expect(s.update).toHaveBeenCalledTimes(1);
    s.win.tick();
    await flush();
    expect(s.update).toHaveBeenCalledTimes(2);
  });

  it('reloads when a new build takes control and nothing would be lost', () => {
    const s = setup();
    s.sw.emit('controllerchange');
    s.sw.emit('controllerchange');
    expect(s.env.reload).toHaveBeenCalledTimes(1);
    expect(s.env.offerReload).not.toHaveBeenCalled();
  });

  it('ignores the first install, then handles the next update', () => {
    const s = setup({ controller: null });
    s.sw.emit('controllerchange');
    expect(s.env.reload).not.toHaveBeenCalled();
    s.sw.emit('controllerchange');
    expect(s.env.reload).toHaveBeenCalledTimes(1);
  });

  it('offers a Reload button instead while a trip is being planned or the user is typing', () => {
    setReloadBlocker(() => true);
    const planning = setup();
    planning.sw.emit('controllerchange');
    expect(planning.env.reload).not.toHaveBeenCalled();
    expect(planning.env.offerReload).toHaveBeenCalledWith(planning.env.reload);

    setReloadBlocker(() => false);
    const typing = setup({ active: el('INPUT') });
    typing.sw.emit('controllerchange');
    expect(typing.env.reload).not.toHaveBeenCalled();
    expect(typing.env.offerReload).toHaveBeenCalledTimes(1);
  });
});

describe('isEditing', () => {
  it('counts text fields, selects and editable elements', () => {
    expect(isEditing(el('INPUT'))).toBe(true);
    expect(isEditing(el('TEXTAREA'))).toBe(true);
    expect(isEditing(el('SELECT'))).toBe(true);
    expect(isEditing(el('DIV', true))).toBe(true);
    expect(isEditing(el('BUTTON'))).toBe(false);
    expect(isEditing(null)).toBe(false);
  });
});
