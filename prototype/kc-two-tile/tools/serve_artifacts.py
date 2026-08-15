from __future__ import annotations

import argparse
import os
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class ArtifactHandler(SimpleHTTPRequestHandler):
    range_to_send: tuple[int, int] | None = None

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):  # type: ignore[no-untyped-def]
        request_range = self.headers.get("Range")
        path = Path(self.translate_path(self.path))
        if not request_range or not path.is_file():
            self.range_to_send = None
            return super().send_head()
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", request_range.strip())
        if not match:
            self.send_error(416, "Only one byte range is supported")
            return None
        size = path.stat().st_size
        start_text, end_text = match.groups()
        if start_text:
            start = int(start_text); end = int(end_text) if end_text else size - 1
        else:
            suffix = int(end_text or 0); start, end = max(0, size - suffix), size - 1
        if start >= size or start < 0 or end < start:
            self.send_response(416); self.send_header("Content-Range", f"bytes */{size}"); self.end_headers(); return None
        end = min(end, size - 1)
        handle = path.open("rb")
        self.send_response(206)
        self.send_header("Content-type", self.guess_type(str(path)))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Last-Modified", self.date_time_string(path.stat().st_mtime))
        self.end_headers()
        handle.seek(start); self.range_to_send = (start, end)
        return handle

    def copyfile(self, source, outputfile) -> None:  # type: ignore[no-untyped-def]
        if self.range_to_send is None:
            return super().copyfile(source, outputfile)
        remaining = self.range_to_send[1] - self.range_to_send[0] + 1
        while remaining:
            chunk = source.read(min(1024 * 1024, remaining))
            if not chunk: break
            outputfile.write(chunk); remaining -= len(chunk)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve generated tile packages with CORS and byte ranges")
    parser.add_argument("--directory", type=Path, default=Path(__file__).parents[1] / "artifacts")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    directory = args.directory.resolve(strict=True)
    os.chdir(directory)
    server = ThreadingHTTPServer((args.host, args.port), ArtifactHandler)
    print(f"Serving {directory} at http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()

