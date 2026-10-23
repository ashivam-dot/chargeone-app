import { describe, expect, it } from 'vitest';
import { warmable } from './swWarm.ts';

describe('warmable', () => {
  const origin = 'https://chargeone.test';

  it('keeps own data and map files and the tile hosts, once each', () => {
    expect(
      warmable(
        [
          `${origin}/data/index.json`,
          `${origin}/data/shards/td.json?v=1`,
          `${origin}/data/shards/td.json?v=1`,
          `${origin}/map/night.json`,
          'https://tiles.openfreemap.org/planet/1/2/3.pbf',
          'https://tiles.mapterhorn.com/5/6/7.webp',
        ],
        origin,
      ),
    ).toEqual([
      `${origin}/data/index.json`,
      `${origin}/data/shards/td.json?v=1`,
      `${origin}/map/night.json`,
      'https://tiles.openfreemap.org/planet/1/2/3.pbf',
      'https://tiles.mapterhorn.com/5/6/7.webp',
    ]);
  });

  it('skips the API, app code, cache-busting re-reads, other sites and junk', () => {
    expect(
      warmable(
        [`${origin}/api/me`, `${origin}/assets/index-abc.js`, `${origin}/data/index.json?fresh=x1`, 'https://evil.test/data/index.json', 'not a url'],
        origin,
      ),
    ).toEqual([]);
  });

  it('stops at a bounded number of files', () => {
    const many = Array.from({ length: 1000 }, (_, i) => `https://tiles.openfreemap.org/t/${i}.pbf`);
    expect(warmable(many, origin)).toHaveLength(400);
  });
});
