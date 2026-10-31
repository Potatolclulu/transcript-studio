"""Authenticated public captions service with persistent public media jobs."""
import hmac
import html
import json
import os
import re
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

SECRET = os.environ.get("CAPTION_SERVICE_SECRET", "")
YT_DLP = os.environ.get("YT_DLP", "yt-dlp")
SLOTS = threading.BoundedSemaphore(2)
MAX_DATA = 4 * 1024 * 1024
# YouTube JSON3 includes per-word timing and formatting omitted from our response.
MAX_CAPTION_FILE = 16 * 1024 * 1024


def command(args, folder, timeout=55):
    # Disk-bounded stdout, no shell and no user-provided command flags.
    output = Path(folder) / "output.json"
    with output.open("wb") as target:
        result = subprocess.run(
            [YT_DLP, "--ignore-config", "--no-playlist", "--socket-timeout", "12",
             "--retries", "1", "--js-runtimes", "node", *args],
            stdout=target, stderr=subprocess.DEVNULL, timeout=timeout,
        )
    if result.returncode or output.stat().st_size > MAX_DATA:
        raise ValueError("Public metadata or captions could not be retrieved. Try again later.")
    return output.read_text()


def available(info):
    tracks = []
    for source, field in (("manual", "subtitles"), ("automatic", "automatic_captions")):
        for language, formats in (info.get(field) or {}).items():
            if language == "live_chat" or not re.fullmatch(r"[\w.-]{1,50}", language):
                continue
            eligible = [f for f in formats if f.get("ext") == "json3"]
            if not eligible:
                continue
            translated = any(parse_qs(urlsplit(f.get("url", "")).query).get("tlang") for f in eligible)
            # Prefer original tracks. YouTube can advertise hundreds of machine translations.
            tracks.append({
                "id": f"{source}:{language}", "language": language,
                "name": str(eligible[0].get("name") or language)[:120],
                "source": source, "translated": translated,
            })
    original = str(info.get("language") or "").split("-")[0]
    def rank(track):
        lang = track["language"].split("-")[0].split(".")[0]
        return (track["translated"], lang != original if original else lang != "en",
                track["source"] != "manual", lang != "zh", lang != "en", track["id"])
    return sorted(tracks, key=rank)[:100]


def chapters(info, duration):
    result = []
    for item in (info.get("chapters") or [])[:100]:
        start, end = item.get("start_time"), item.get("end_time")
        title = str(item.get("title") or "").strip()[:200]
        if not title or not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        if not 0 <= start < end <= duration or result and start < result[-1]["end"]:
            continue
        result.append({"start": start, "end": end, "title": title})
    return result


def extract(video_id, requested=None, mode=None):
    if not re.fullmatch(r"[\w-]{11}", video_id):
        raise ValueError("Invalid YouTube video.")
    url = f"https://www.youtube.com/watch?v={video_id}"
    with tempfile.TemporaryDirectory(prefix="learning-captions-") as folder:
        info = json.loads(command(["--skip-download", "--dump-single-json", url], folder))
        duration = info.get("duration")
        if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming") or not isinstance(duration, (float, int)) or not 0 < duration <= 14400:
            raise ValueError("Use a recorded public video of up to four hours.")
        tracks = available(info)
        if mode == "metadata":
            return {"chapters": chapters(info, duration), "duration": duration}
        if mode == "translation":
            requested = next((t["id"] for t in tracks if t["language"].startswith("zh")), None)
            if not requested:
                raise ValueError("No Chinese caption track is available.")
        selected = next((t for t in tracks if t["id"] == requested), None) if requested else (tracks[0] if tracks else None)
        if requested and not selected:
            raise ValueError("That caption track is no longer available.")
        result = {
            "title": str(info.get("title") or video_id)[:500],
            "author": str(info.get("channel") or info.get("uploader") or "")[:300],
            "duration": duration, "tracks": tracks,
            "selectedTrack": selected["id"] if selected else None,
            "completeness": "none", "cues": [],
            "chapters": chapters(info, duration),
        }
        if not selected:
            return result
        command([
            "--skip-download", "--write-subs" if selected["source"] == "manual" else "--write-auto-subs",
            "--sub-langs", re.escape(selected["language"]), "--sub-format", "json3",
            "-o", str(Path(folder) / "source.%(ext)s"), url,
        ], folder)
        files = list(Path(folder).glob("source.*.json3"))
        if len(files) != 1:
            raise ValueError("Captions could not be downloaded.")
        if files[0].stat().st_size > MAX_CAPTION_FILE:
            raise ValueError("This caption file exceeds the supported size limit.")
        data = json.loads(files[0].read_text())
        cues = []
        for event in data.get("events", []):
            text = html.unescape("".join(s.get("utf8", "") for s in event.get("segs", []))).strip()
            if not text:
                continue
            start = max(0, float(event.get("tStartMs", 0)) / 1000)
            end = min(14400, start + max(0, float(event.get("dDurationMs", 0))) / 1000)
            if start > duration + 5 or len(text) > 12000:
                continue
            cues.append({"start": start, "end": max(start, end), "text": text})
        cues.sort(key=lambda c: c["start"])
        if not cues or len(cues) > 12000:
            raise ValueError("This track has no usable timed captions.")
        result["cues"] = cues
        # This is timeline coverage, not a guarantee of transcription accuracy.
        result["completeness"] = "partial" if cues[0]["start"] > 90 or cues[-1]["end"] < duration - max(90, duration * 0.15) else "complete"
        return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        if len(body) > MAX_DATA:
            status, body = 422, b'{"error":"Caption response exceeds the size limit."}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path not in ("/extract", "/jobs"):
            return self.respond(404, {"error": "Not found."})
        if not SECRET or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + SECRET):
            return self.respond(401, {"error": "Unauthorized."})
        try:
            size = int(self.headers.get("Content-Length", 0))
        except ValueError:
            size = 0
        if not 0 < size <= 4096:
            return self.respond(413, {"error": "Invalid request size."})
        if self.path == "/jobs":
            try:
                import media
                return self.respond(202, media.submit(json.loads(self.rfile.read(size))))
            except (ValueError, KeyError, TypeError) as error:
                return self.respond(422, {"error": str(error)[:300]})
        if not SLOTS.acquire(blocking=False):
            return self.respond(429, {"error": "Caption service is busy. Please retry shortly."})
        try:
            data = json.loads(self.rfile.read(size))
            if data.get("mode") not in (None, "metadata", "translation"):
                raise ValueError("Invalid caption request.")
            self.respond(200, extract(data["youtubeId"], data.get("trackId"), data.get("mode")))
        except (ValueError, subprocess.TimeoutExpired) as error:
            message = str(error) if isinstance(error, ValueError) else "Caption retrieval timed out. Your saved link is safe."
            self.respond(422, {"error": message[:300]})
        except Exception:
            self.respond(422, {"error": "Captions could not be retrieved. Your saved link is safe."})
        finally:
            SLOTS.release()

    def do_GET(self):
        self.media_request()

    def do_HEAD(self):
        self.media_request(True)

    def media_request(self, head=False):
        if not SECRET or not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + SECRET):
            return self.respond(401, {"error": "Unauthorized."})
        match = re.fullmatch(r"/(jobs|media)/([a-f0-9]{64})", self.path)
        if not match:
            return self.respond(404, {"error": "Not found."})
        try:
            import media
            if match[1] == "jobs":
                return self.respond(200, media.status(match[2]))
            media.serve(self, match[2], head)
        except ValueError as error:
            self.respond(404, {"error": str(error)[:300]})


if __name__ == "__main__":
    if len(SECRET) < 24:
        raise SystemExit("Set a separate CAPTION_SERVICE_SECRET of at least 24 characters.")
    import media
    media.initialize()
    server = ThreadingHTTPServer((os.environ.get("HOST", "127.0.0.1"), int(os.environ.get("PORT", "8791"))), Handler)
    print("Public captions and media service listening; credentials are never logged.", flush=True)
    server.serve_forever()
