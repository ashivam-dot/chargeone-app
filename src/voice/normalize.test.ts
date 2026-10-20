import { describe, expect, it } from 'vitest';
import { sentences, speakable } from './normalize.ts';

describe('speakable', () => {
  it('reads money, power, energy and distance in words', () => {
    expect(speakable('Est. cost ₹1,200 · up to 48 kW · 45 kWh · 506 km', 'en')).toBe('Est. cost 1200 rupees, up to 48 kilowatts, 45 kilowatt-hours, 506 kilometres');
  });

  it('handles Indian digit grouping', () => {
    expect(speakable('₹1,20,000', 'en')).toBe('120000 rupees');
  });

  it('reads durations with singular and plural', () => {
    expect(speakable('11 h 49 min', 'en')).toBe('11 hours 49 minutes');
    expect(speakable('1 h 1 min', 'en')).toBe('1 hour 1 minute');
  });

  it('reads speed, consumption, percent and temperature', () => {
    expect(speakable('70 km/h, 138 Wh/km, 39%, 29 °C', 'en')).toBe('70 kilometres per hour, 138 watt-hours per kilometre, 39 percent, 29 degrees');
  });

  it('reads a range as "to", not minus', () => {
    expect(speakable('Charge 20–80% in 20 min', 'en')).toBe('Charge 20 to 80 percent in 20 minutes');
  });

  it('speaks Hindi units', () => {
    expect(speakable('लगभग ₹350 और 45 kW', 'hi')).toBe('लगभग 350 रुपये और 45 किलोवॉट');
    expect(speakable('2 h 5 min', 'hi')).toBe('2 घंटे 5 मिनट');
  });

  it('drops markdown and symbols a voice would read aloud', () => {
    expect(speakable('**Stop 1** → Salem ~ 40 min', 'en')).toBe('Stop 1 to Salem about 40 minutes');
    expect(speakable('- Food at every stop\n- Stays near Salem', 'en')).toBe('Food at every stop. Stays near Salem');
  });

  it('leaves plain words alone', () => {
    expect(speakable('Kim reached Hamirpur', 'en')).toBe('Kim reached Hamirpur');
  });
});

describe('sentences', () => {
  it('splits on full stops, including the Devanagari danda', () => {
    expect(sentences('You will make it with three stops. Arrive with 39 percent battery.')).toEqual(['You will make it with three stops.', 'Arrive with 39 percent battery.']);
    expect(sentences('पहला स्टॉप सेलम है। वहाँ खाना भी मिलेगा।')).toEqual(['पहला स्टॉप सेलम है। वहाँ खाना भी मिलेगा।']);
  });

  it('joins very short sentences to a neighbour', () => {
    expect(sentences('Okay. Plan the trip to Chennai now.')).toEqual(['Okay. Plan the trip to Chennai now.']);
  });

  it('breaks a run-on sentence at a comma', () => {
    const long = `${'Stop at Salem for food, '.repeat(12)}then drive on.`;
    const parts = sentences(long, 100);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' ').trim());
  });
});
