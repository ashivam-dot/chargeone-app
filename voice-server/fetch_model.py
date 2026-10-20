"""Downloads the Supertonic 3 voice model (sherpa-onnx int8 build, about 140 MB) into models/supertonic-3.

The archive is checked against a pinned sha256 before anything is unpacked.
"""

import hashlib
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request

URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2'
SHA256 = '82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427'
TOP = 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11'
NEEDED = ['duration_predictor.int8.onnx', 'text_encoder.int8.onnx', 'vector_estimator.int8.onnx', 'vocoder.int8.onnx',
          'tts.json', 'unicode_indexer.bin', 'voice.bin', 'LICENSE']

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.environ.get('MODEL_DIR', os.path.join(HERE, 'models', 'supertonic-3'))


def main() -> None:
    if all(os.path.exists(os.path.join(DEST, f)) for f in NEEDED):
        print(f'Model already in {DEST}')
        return
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    with tempfile.TemporaryDirectory(dir=os.path.dirname(DEST)) as tmp:
        archive = os.path.join(tmp, 'model.tar.bz2')
        digest = hashlib.sha256()
        with urllib.request.urlopen(URL, timeout=60) as res, open(archive, 'wb') as out:
            while chunk := res.read(1 << 20):
                digest.update(chunk)
                out.write(chunk)
        if digest.hexdigest() != SHA256:
            sys.exit(f'Checksum mismatch: got {digest.hexdigest()}, expected {SHA256}. Nothing was unpacked.')
        with tarfile.open(archive, 'r:bz2') as tar:
            tar.extractall(tmp, filter='data')
        missing = [f for f in NEEDED if not os.path.exists(os.path.join(tmp, TOP, f))]
        if missing:
            sys.exit(f'The archive is missing {missing}.')
        if os.path.exists(DEST):
            shutil.rmtree(DEST)
        shutil.move(os.path.join(tmp, TOP), DEST)
    print(f'Model ready in {DEST}')


if __name__ == '__main__':
    main()
