"""Small, separately hosted media verifier. No media or signed URLs are logged."""
import hmac
import json
import math
import os
import subprocess
import tempfile
import threading
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECRET = os.environ.get("PROBE_SECRET", "")
ORIGIN = os.environ.get("MEDIA_ORIGIN", "http://127.0.0.1:5178").rstrip("/")
MAX_BYTES = 250 * 1024 * 1024
FFPROBE = os.environ.get("FFPROBE", "ffprobe")
SLOTS = threading.BoundedSemaphore(2)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Redirects are not allowed")

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/probe":
            return self.respond(404, {"error": "Not found"})
        if not SECRET or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + SECRET):
            return self.respond(401, {"error": "Unauthorized"})
        length = int(self.headers.get("Content-Length", 0))
        if not 0 < length <= 8192:
            return self.respond(413, {"error": "Invalid request size"})
        if not SLOTS.acquire(blocking=False):
            return self.respond(429, {"error": "Probe busy"})
        try:
            data = json.loads(self.rfile.read(length))
            url, expected = data["url"], data["bytes"]
            parsed = urllib.parse.urlsplit(url)
            if f"{parsed.scheme}://{parsed.netloc}" != ORIGIN or not parsed.path.startswith("/api/media/") or parsed.username or parsed.password:
                raise ValueError("Only the configured media origin is allowed")
            if not isinstance(expected, int) or not 0 < expected <= MAX_BYTES:
                raise ValueError("Invalid size")
            # Download to a temporary local file: ffprobe never follows nested remote references.
            with tempfile.TemporaryDirectory(prefix="transcript-probe-") as folder:
                path = os.path.join(folder, "media")
                import time
                start, total = time.monotonic(), 0
                opener = urllib.request.build_opener(NoRedirect)
                with opener.open(url, timeout=15) as response, open(path, "wb") as target:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > expected or total > MAX_BYTES or time.monotonic() - start > 75:
                            raise ValueError("File size or download limit exceeded")
                        target.write(chunk)
                if total != expected:
                    raise ValueError("Incomplete file")
                result = subprocess.run([
                    FFPROBE, "-v", "error", "-protocol_whitelist", "file",
                    "-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mp3,wav",
                    "-show_entries", "format=duration,format_name:stream=codec_type,duration",
                    "-of", "json", path
                ], capture_output=True, timeout=20, check=True)
                info = json.loads(result.stdout)
                duration = float(info.get("format", {}).get("duration", 0))
                audio = any(s.get("codec_type") == "audio" for s in info.get("streams", []))
                if not audio or not math.isfinite(duration) or not 0 < duration <= 7200:
                    raise ValueError("No audio track or invalid duration")
                self.respond(200, {"audio": True, "duration": duration})
        except Exception:
            self.respond(422, {"error": "File could not be verified"})
        finally:
            SLOTS.release()

if __name__ == "__main__":
    if len(SECRET) < 24:
        raise SystemExit("Set a separate PROBE_SECRET of at least 24 characters.")
    server = ThreadingHTTPServer((os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8790"))), Handler)
    print("Media probe listening; signed URLs are not logged.", flush=True)
    server.serve_forever()
