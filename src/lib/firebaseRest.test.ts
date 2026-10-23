import { describe, expect, it } from 'vitest';
import { FirebaseAuthError, firebaseRest } from './firebaseRest.ts';

const config = { apiKey: 'AIzaSyTEST_key_000000000000000000000', projectId: 'p1', authDomain: 'p1.firebaseapp.com', appId: '' };

function fake(reply: (url: string, body: string) => Response) {
  const seen: Array<{ url: string; body: string; type: string | null }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const body = String(init.body ?? '');
    seen.push({ url, body, type: new Headers(init.headers).get('Content-Type') });
    return reply(url, body);
  };
  return { fetchImpl, seen };
}

const ok = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
const fail = (message: string, status = 400) => new Response(JSON.stringify({ error: { message } }), { status });

describe('firebaseRest', () => {
  it('signs up, sets the display name and returns the session', async () => {
    const f = fake((url) => (url.includes(':signUp') ? ok({ idToken: 't1', refreshToken: 'r1', localId: 'u1', email: 'a@b.co', expiresIn: '3600' }) : ok({})));
    const s = await firebaseRest(config, f.fetchImpl).signUp('a@b.co', 'Charge2026x', 'Asha');
    expect(s).toEqual({ idToken: 't1', refreshToken: 'r1', localId: 'u1', email: 'a@b.co', expiresIn: 3600 });
    expect(f.seen[0].url).toBe(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${config.apiKey}`);
    expect(JSON.parse(f.seen[0].body)).toEqual({ email: 'a@b.co', password: 'Charge2026x', returnSecureToken: true });
    expect(f.seen[1].url).toContain(':update?');
    expect(JSON.parse(f.seen[1].body)).toMatchObject({ idToken: 't1', displayName: 'Asha' });
  });

  it('sends verify and reset emails with the right request types', async () => {
    const f = fake(() => ok({ email: 'a@b.co' }));
    const rest = firebaseRest(config, f.fetchImpl);
    await rest.sendVerifyEmail('t1');
    await rest.sendPasswordReset('a@b.co');
    expect(JSON.parse(f.seen[0].body)).toEqual({ requestType: 'VERIFY_EMAIL', idToken: 't1' });
    expect(JSON.parse(f.seen[1].body)).toEqual({ requestType: 'PASSWORD_RESET', email: 'a@b.co' });
  });

  it('looks up and deletes the account', async () => {
    const f = fake((url) => (url.includes(':lookup') ? ok({ users: [{ localId: 'u1', emailVerified: true }] }) : ok({})));
    const rest = firebaseRest(config, f.fetchImpl);
    expect(await rest.lookup('t1')).toEqual({ localId: 'u1', emailVerified: true });
    await rest.deleteAccount('t1');
    expect(f.seen[1].url).toContain(':delete?');
  });

  it('refreshes the ID token through securetoken with a form body', async () => {
    const f = fake(() => ok({ id_token: 't2', refresh_token: 'r2', user_id: 'u1', expires_in: '3600' }));
    const s = await firebaseRest(config, f.fetchImpl).refreshIdToken('r1');
    expect(s).toEqual({ idToken: 't2', refreshToken: 'r2', localId: 'u1', expiresIn: 3600 });
    expect(f.seen[0].url).toBe(`https://securetoken.googleapis.com/v1/token?key=${config.apiKey}`);
    expect(f.seen[0].type).toBe('application/x-www-form-urlencoded');
    expect(f.seen[0].body).toBe('grant_type=refresh_token&refresh_token=r1');
  });

  it.each([
    ['EMAIL_EXISTS', 400, 'EMAIL_EXISTS'],
    ['WEAK_PASSWORD : Password should be at least 6 characters', 400, 'WEAK_PASSWORD'],
    ['INVALID_LOGIN_CREDENTIALS', 400, 'INVALID_LOGIN_CREDENTIALS'],
    ['TOO_MANY_ATTEMPTS_TRY_LATER', 400, 'TOO_MANY_ATTEMPTS_TRY_LATER'],
    ['BACKEND_ERROR', 503, 'NETWORK'],
  ])('maps %s to a typed error', async (message, status, code) => {
    const f = fake(() => fail(message, status));
    const err = await firebaseRest(config, f.fetchImpl).signInWithPassword('a@b.co', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FirebaseAuthError);
    expect((err as FirebaseAuthError).code).toBe(code);
    expect((err as FirebaseAuthError).message.length).toBeGreaterThan(10);
  });

  it('turns a network failure into NETWORK', async () => {
    const rest = firebaseRest(config, async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(rest.sendPasswordReset('a@b.co')).rejects.toMatchObject({ code: 'NETWORK' });
  });
});
