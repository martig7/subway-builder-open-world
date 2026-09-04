"""Run only on a disposable macOS Actions runner; never a user's game folder."""
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import time
import urllib.request


def wait_for_tile(port):
    deadline = time.monotonic() + 45
    last_error = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/_health', timeout=2) as response:
                assert response.headers['X-PMTiles-Server-Version']
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/NEC_TEST_A/0/0/0.mvt', timeout=2) as response:
                assert response.read() == b'\x1a'
            return
        except Exception as error:
            last_error = error
            time.sleep(1)
    raise RuntimeError(f'Server failed to serve fixture on {port}: {last_error}')


def main():
    if sys.platform != 'darwin' or os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('This test requires a disposable macOS GitHub Actions runner.')
    app = Path(sys.argv[1]).resolve()
    binary = app / 'Contents/MacOS/open-world-tile-server'
    for port in (18799, 8799):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    data = Path.home() / 'Library/Application Support/metro-maker4/cities/data'
    fixture = data / 'NEC_TEST_A'
    fixture.mkdir(parents=True, exist_ok=False)
    payload = bytearray(133)
    payload[:8] = b'PMTiles\x03'
    for offset, value in ((8, 127), (16, 5), (24, 132), (40, 132), (56, 132), (64, 1)):
        struct.pack_into('<Q', payload, offset, value)
    payload[96:100] = bytes([1, 1, 1, 1])
    payload[127:] = bytes([1, 0, 1, 1, 1, 0x1a])
    (fixture / 'tiles.pmtiles').write_bytes(payload)
    subprocess.run([binary, 'version'], check=True, timeout=15)
    error = subprocess.run([binary, 'serve', '--port', 'invalid'], capture_output=True, text=True, timeout=15)
    assert error.returncode != 0 and error.stderr.strip(), 'Missing startup error diagnostic'
    print('PASS: native architecture execution and startup error output', flush=True)
    with open('artifacts/server.log', 'w') as log:
        server = subprocess.Popen([binary, 'serve', '--root', data, '--port', '18799'], stdout=log, stderr=log)
        try:
            wait_for_tile(18799)
            print('PASS: packaged server health and tile response', flush=True)
        finally:
            server.terminate()
            server.wait(timeout=15)
    try:
        subprocess.run(['/usr/bin/open', '-n', str(app)], check=True, timeout=15)
        wait_for_tile(8799)
        print('PASS: app -> Terminal -> server launch from Applications', flush=True)
    finally:
        subprocess.run([binary, 'stop'], capture_output=True, timeout=15)
        (fixture / 'tiles.pmtiles').unlink()
        fixture.rmdir()


if __name__ == '__main__':
    main()
