# Overture Maps Places -> India EV charging extract for pipeline/adapters/overture.ts.
#
# Reads the public release over anonymous S3 (no account, no key) with DuckDB and writes one JSON file:
#   <cache>/overture/places-ev-<release>.json
# Run it without installing anything globally:
#   uv run --with duckdb python -I pipeline/overture-extract.py [--release 2026-10-21.0] [--cache data-cache]
#   uv run --with duckdb python -I pipeline/overture-extract.py --describe   # print the schema and stop
# With no --release it lists s3://overturemaps-us-west-2/release/ and takes the newest.
#
# Licences (https://docs.overturemaps.org/attribution/): Places is CDLA-Permissive-2.0, with per-record
# sources under their own licence (Foursquare Apache-2.0, AllThePlaces CC0-1.0, the rest CDLA). Every
# source of every record is kept so the pipeline's licence gate can check each one.
import argparse
import json
import os
import re
import sys
import urllib.request

BUCKET = 'overturemaps-us-west-2'
# Generous India box; the country filter below does the real work.
BBOX = (68.0, 6.0, 97.5, 37.5)


def latest_release() -> str:
    url = f'https://{BUCKET}.s3.us-west-2.amazonaws.com/?list-type=2&prefix=release/&delimiter=/'
    with urllib.request.urlopen(url, timeout=60) as res:
        body = res.read().decode('utf-8')
    releases = sorted(re.findall(r'<Prefix>release/(\d{4}-\d{2}-\d{2}\.\d+)/</Prefix>', body))
    if not releases:
        sys.exit('no Overture releases listed')
    return releases[-1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--release')
    ap.add_argument('--cache', default=os.environ.get('PIPELINE_CACHE_DIR', 'data-cache'))
    ap.add_argument('--describe', action='store_true')
    args = ap.parse_args()

    import duckdb  # noqa: PLC0415 (only needed past argument parsing)

    release = args.release or latest_release()
    path = f's3://{BUCKET}/release/{release}/theme=places/type=place/*.parquet'
    con = duckdb.connect()
    con.sql("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    if args.describe:
        for name, kind, *_ in con.sql(f"DESCRIBE SELECT * FROM read_parquet('{path}') LIMIT 1").fetchall():
            print(name, kind[:400])
        return

    xmin, ymin, xmax, ymax = BBOX
    rows = con.sql(
        f"""
        SELECT id,
               names.primary AS name,
               taxonomy.primary AS category,
               basic_category,
               confidence,
               operating_status,
               brand.names.primary AS brand,
               websites,
               addresses[1].freeform AS address,
               addresses[1].locality AS locality,
               addresses[1].region AS region,
               addresses[1].postcode AS postcode,
               addresses[1].country AS country,
               to_json(sources) AS sources,
               round((bbox.xmin + bbox.xmax) / 2, 6) AS lng,
               round((bbox.ymin + bbox.ymax) / 2, 6) AS lat
        FROM read_parquet('{path}')
        WHERE bbox.xmin BETWEEN {xmin} AND {xmax} AND bbox.ymin BETWEEN {ymin} AND {ymax}
          AND (taxonomy.primary = 'ev_charging_station' OR basic_category = 'ev_charging_station')
          AND addresses[1].country = 'IN'
        ORDER BY id
        """
    )
    cols = [d[0] for d in rows.description]
    places = []
    for values in rows.fetchall():
        rec = dict(zip(cols, values))
        rec['sources'] = json.loads(rec['sources']) if rec['sources'] else []
        rec['websites'] = list(rec['websites'] or [])
        if rec['confidence'] is not None:
            rec['confidence'] = round(float(rec['confidence']), 4)
        places.append(rec)

    out_dir = os.path.join(args.cache, 'overture')
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f'places-ev-{release}.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({'release': release, 'query': 'taxonomy.primary or basic_category = ev_charging_station, country IN', 'places': places}, f, default=str)
    print(f'{len(places)} places -> {out}')


if __name__ == '__main__':
    main()
