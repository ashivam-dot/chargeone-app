import { describe, expect, it } from 'vitest';
import {
  AUTH_ERROR_TEXT,
  authErrorCode,
  authErrorText,
  isEmail,
  maskEmail,
  maskPhone,
  normalizePhone,
  normalizeUsername,
  passwordProblems,
  usernameProblem,
} from './auth.ts';

describe('usernames', () => {
  it('normalises case and spaces', () => {
    expect(normalizeUsername('  Asha_K ')).toBe('asha_k');
  });

  it.each([
    ['ab', 'too_short'],
    ['a'.repeat(21), 'too_long'],
    ['asha k', 'bad_chars'],
    ['asha-k', 'bad_chars'],
    ['आशा123', 'bad_chars'],
    ['.asha', 'bad_dots'],
    ['asha.', 'bad_dots'],
    ['as..ha', 'bad_dots'],
    ['admin', 'reserved'],
    ['support', 'reserved'],
    ['chargeone_help', 'reserved'],
    ['asha.k_99', null],
    ['abc', null],
    ['a'.repeat(20), null],
  ])('%s -> %s', (name, problem) => {
    expect(usernameProblem(name)).toBe(problem);
  });
});

describe('passwordProblems', () => {
  it('accepts a decent password', () => {
    expect(passwordProblems('Charge2026x')).toEqual([]);
  });

  it('lists every problem', () => {
    expect(passwordProblems('abc')).toEqual(['too_short', 'no_digit']);
    expect(passwordProblems('12345678')).toEqual(['no_letter', 'common']);
    expect(passwordProblems('password1')).toEqual(['common']);
    expect(passwordProblems('x'.repeat(129) + '1')).toEqual(['too_long']);
    expect(passwordProblems('asha2026!', { email: 'asha@gmail.com' })).toEqual(['matches_identity']);
    expect(passwordProblems('evdriver99', { username: 'EVDriver' })).toEqual(['matches_identity']);
  });

  it('counts letters in any script', () => {
    expect(passwordProblems('चार्ज2026xx')).toEqual([]);
  });
});

describe('email', () => {
  it('checks and masks addresses', () => {
    expect(isEmail('a@b.co')).toBe(true);
    expect(isEmail('no-at.example.com')).toBe(false);
    expect(isEmail('two@@example.com')).toBe(false);
    expect(isEmail('spa ce@example.com')).toBe(false);
    expect(maskEmail('akash@gmail.com')).toBe('a•••@gmail.com');
    expect(maskEmail('nonsense')).toBe('•••');
  });
});

describe('phone numbers', () => {
  it.each([
    ['9999900001', '+919999900001'],
    ['99999 00001', '+919999900001'],
    ['099999-00001', '+919999900001'],
    ['919999900001', '+919999900001'],
    ['+91 99999 00001', '+919999900001'],
    ['+14155550123', '+14155550123'],
    ['5999900001', null],
    ['+915999900001', null],
    ['12345', null],
    ['phone', null],
    ['', null],
  ])('%s -> %s', (input, out) => {
    expect(normalizePhone(input)).toBe(out);
  });

  it('masks all but the country code and last three digits', () => {
    expect(maskPhone('+919999900001')).toBe('+91•••••••001');
    expect(maskPhone('+14155550123')).toBe('+1•••••••123');
  });
});

describe('Firebase error codes', () => {
  it('reads REST messages, SDK codes and unknowns', () => {
    expect(authErrorCode('EMAIL_EXISTS')).toBe('EMAIL_EXISTS');
    expect(authErrorCode('WEAK_PASSWORD : Password should be at least 6 characters')).toBe('WEAK_PASSWORD');
    expect(authErrorCode('TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account has been temporarily disabled')).toBe('TOO_MANY_ATTEMPTS_TRY_LATER');
    expect(authErrorCode('INVALID_LOGIN_CREDENTIALS')).toBe('INVALID_LOGIN_CREDENTIALS');
    expect(authErrorCode('auth/invalid-verification-code')).toBe('INVALID_CODE');
    expect(authErrorCode('auth/code-expired')).toBe('CODE_EXPIRED');
    expect(authErrorCode('SESSION_EXPIRED')).toBe('CODE_EXPIRED');
    expect(authErrorCode('SOMETHING_NEW')).toBe('UNKNOWN');
    expect(authErrorCode(undefined)).toBe('UNKNOWN');
    expect(authErrorCode(42)).toBe('UNKNOWN');
  });

  it('has friendly text for every code', () => {
    for (const text of Object.values(AUTH_ERROR_TEXT)) expect(text.length).toBeGreaterThan(10);
    expect(authErrorText('EMAIL_EXISTS')).toBe(AUTH_ERROR_TEXT.EMAIL_EXISTS);
  });
});
