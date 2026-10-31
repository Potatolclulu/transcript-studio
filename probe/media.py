"""Persistent public Bilibili/Xiaoyuzhou import jobs and authenticated media.

The caller supplies platform IDs, never arbitrary URLs. Secrets stay in the process.
"""
import base64
import hashlib
import html
import json
import math
import os
import re
import sqlite3
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(os.environ.get("MEDIA_CACHE_DIR", ".wrangler/media-cache")).resolve()
MAX_FILE = 512 * 1024 * 1024
MAX_CACHE = int(os.environ.get("MEDIA_CACHE_MAX_MB", "4096")) * 1024 * 1024
DAILY_MINUTES = int(os.environ.get("MEDIA_ASR_DAILY_MINUTES", "180"))
CHUNK = 600
LOCK = threading.RLock()
POOL = ThreadPoolExecutor(max_workers=2)
ACTIVE = set()
YT_DLP = os.environ.get("YT_DLP", "yt-dlp")
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")


def write(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False))
    temporary.replace(path)


def read(path):
    return json.loads(path.read_text())


def initialize():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with sqlite3.connect(ROOT / "budget.sqlite") as db:
        db.execute("CREATE TABLE IF NOT EXISTS spend(id TEXT PRIMARY KEY,day TEXT,minutes REAL)")
    for path in ROOT.glob("*/state.json"):
        state = read(path)
        if state["status"] in ("queued", "running"):
            state.update(status="failed", error="The media service restarted. Completed segments are saved; retry explicitly.")
            write(path, state)


def source(platform, source_id):
    if platform == "bilibili" and re.fullmatch(r"BV[0-9A-Za-z]{10}:p[1-9]\d{0,2}", source_id):
        bv, part = source_id.split(":p")
        return f"https://www.bilibili.com/video/{bv}/?p={part}"
    if platform == "xiaoyuzhou" and re.fullmatch(r"[a-f0-9]{24}", source_id):
        return f"https://www.xiaoyuzhoufm.com/episode/{source_id}"
    raise ValueError("Invalid public media source.")


def cache_usage():
    return sum(path.stat().st_size for path in ROOT.glob("**/*") if path.is_file())


def update(folder, **changes):
    with LOCK:
        state = read(folder / "state.json")
        state.update(changes)
        write(folder / "state.json", state)


def submit(data):
    if not isinstance(data, dict):
        raise ValueError("Use a JSON object for the media request.")
    platform, source_id = data.get("platform"), data.get("sourceId", "")
    source(platform, source_id)
    nonce = data.get("attempt")
    if not isinstance(nonce, str) or not re.fullmatch(r"[\w:-]{1,100}", nonce):
        raise ValueError("Invalid import attempt.")
    key = hashlib.sha256(f"{platform}:{source_id}".encode()).hexdigest()
    folder = ROOT / key
    with LOCK:
        if folder.exists():
            state = read(folder / "state.json")
            if state["status"] != "failed" or nonce == state["attempt"]:
                return state
            # Signed CDN addresses can expire while the saved speech remains valid.
            (folder / "metadata.json").unlink(missing_ok=True)
        if len(ACTIVE) >= 4:
            raise ValueError("The media service is busy. Please retry shortly.")
        used = cache_usage()
        if used > MAX_CACHE - MAX_FILE:
            raise ValueError("The media cache is full. Ask the server owner to clear unused cached media.")
        folder.mkdir(exist_ok=True)
        # A new explicit attempt permits resending only unfinished segments.
        for pending in folder.glob("chunk-*.sent"):
            pending.unlink()
        state = {"key": key, "platform": platform, "sourceId": source_id, "attempt": nonce,
                 "status": "queued", "progress": "Waiting for media", "error": None}
        write(folder / "state.json", state)
        ACTIVE.add(key)
        POOL.submit(work, folder)
        return state


def status(key):
    if not re.fullmatch(r"[a-f0-9]{64}", key):
        raise ValueError("Invalid media job.")
    folder = ROOT / key
    if not (folder / "state.json").exists():
        raise ValueError("Media job not found.")
    result = read(folder / "state.json")
    if result["status"] == "complete":
        result["result"] = read(folder / "result.json")
    return result


def run(args, timeout=300):
    import tempfile
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(args, stdout=output, stderr=subprocess.DEVNULL, timeout=timeout)
        if result.returncode or output.tell() > 4 * 1024 * 1024:
            raise ValueError("Public media could not be prepared. The source may be restricted or unavailable.")
        output.seek(0)
        return output.read()


def duration(path):
    return float(run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], 30))


def download(url, path, headers=None, limit=MAX_FILE):
    host = (urlsplit(url).hostname or "").lower()
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port or not any(host == h or host.endswith("." + h) for h in (
        "bilivideo.com", "bilivideo.cn", "biliapi.net", "bilibili.com", "xyzcdn.net", "xiaoyuzhoufm.com", "hdslb.com")):
        raise ValueError("The platform returned an unsupported media host.")
    partial = path.with_suffix(path.suffix + ".download")
    try:
        with urlopen(Request(url, headers=headers or {}), timeout=45) as response, partial.open("wb") as target:
            final = urlsplit(response.geturl())
            if final.scheme != "https" or final.hostname != urlsplit(url).hostname:
                raise ValueError("Media redirects are not accepted.")
            size = 0
            while block := response.read(1024 * 1024):
                size += len(block)
                if size > limit:
                    raise ValueError("This media exceeds the supported file size.")
                with LOCK:
                    if cache_usage() + len(block) > MAX_CACHE:
                        raise ValueError("The media cache has reached its size limit. Completed work is saved.")
                    target.write(block)
        if not size:
            raise ValueError("The platform returned empty media.")
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


def metadata(folder, state):
    cached = folder / "metadata.json"
    if cached.exists():
        return read(cached)
    url = source(state["platform"], state["sourceId"])
    if state["platform"] == "bilibili":
        info = json.loads(run([YT_DLP, "--ignore-config", "--no-playlist", "--skip-download",
                               "--socket-timeout", "15", "--retries", "1", "--dump-single-json", url], 90))
        if info.get("is_live") or info.get("availability") in ("private", "premium_only", "subscriber_only", "needs_auth"):
            raise ValueError("Use a public recorded bilibili video.")
        # yt-dlp may return a playlist for a multi-part video. Select the explicit part.
        if info.get("entries"):
            part = int(state["sourceId"].split(":p")[1])
            entries = info["entries"]
            if part > len(entries):
                raise ValueError("This video part does not exist.")
            info = entries[part - 1]
        bv, part = state["sourceId"].split(":p")
        expected_ids = {f"{bv}_p{part}"}
        if part == "1":
            expected_ids.add(bv)
        if info.get("id") not in expected_ids:
            raise ValueError("Public metadata does not match the selected video part.")
        info["platform"] = "bilibili"
    else:
        with urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as response:
            page = response.read(4 * 1024 * 1024 + 1).decode()
        match = re.search(r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', page, re.S)
        if not match:
            raise ValueError("Public episode metadata is unavailable.")
        episode = json.loads(match[1])["props"]["pageProps"]["episode"]
        if episode.get("isPrivateMedia") or episode.get("payType") not in (None, "FREE"):
            raise ValueError("Use a free public Xiaoyuzhou episode.")
        enclosure = episode.get("enclosure") or {}
        media = episode.get("media") or {}
        audio_url = enclosure.get("url") or (media.get("source") or {}).get("url")
        if not audio_url:
            raise ValueError("This episode has no public audio.")
        info = {"platform": "xiaoyuzhou", "title": episode["title"], "duration": episode["duration"],
                "uploader": (episode.get("podcast") or {}).get("title", ""),
                "audio_url": audio_url, "chapters": []}
    seconds = info.get("duration")
    if not isinstance(seconds, (int, float)) or not 0 < seconds <= 7200:
        raise ValueError("Use a public recording of up to two hours.")
    write(cached, info)
    return info


def subtitle_cues(payload, extension):
    if extension == "json":
        body = json.loads(payload).get("body") or []
        cues = [{"start": float(c["from"]), "end": float(c["to"]),
                 "text": html.unescape(c["content"]).strip()} for c in body if c.get("content", "").strip()]
    else:
        def seconds(value):
            hours, minutes, rest = value.replace(",", ".").split(":")
            return int(hours) * 3600 + int(minutes) * 60 + float(rest)
        cues = []
        for block in re.split(r"\n[ \t]*\n", payload.replace("\r\n", "\n").strip("\ufeff\n ")):
            lines = block.splitlines()
            timing = next((i for i, line in enumerate(lines) if "-->" in line), None)
            if timing is None:
                continue
            match = re.fullmatch(r"\s*(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*", lines[timing])
            if not match:
                raise ValueError("Invalid subtitle timestamp.")
            text = html.unescape(re.sub(r"</?(?:b|i|u|font)\b[^>]*>", "", "\n".join(lines[timing + 1:]))).strip()
            if text:
                cues.append({"start": seconds(match[1]), "end": seconds(match[2]), "text": text})
    if not cues or len(cues) > 12000 or any(
            not math.isfinite(c["start"]) or not math.isfinite(c["end"]) or
            not 0 <= c["start"] < c["end"] or len(c["text"]) > 12000 or
            i > 0 and c["start"] < cues[i - 1]["start"] for i, c in enumerate(cues)):
        raise ValueError("Invalid native subtitle timeline.")
    return cues


def native_captions(folder, info):
    """Accept yt-dlp inline SRT and original platform JSON; never use shownotes."""
    candidates = []
    for origin, field in (("manual", "subtitles"), ("automatic", "automatic_captions")):
        for language, formats in (info.get(field) or {}).items():
            if language in ("danmaku", "live_chat") or not re.fullmatch(r"[\w.-]{1,50}", language):
                continue
            for entry in formats:
                if entry.get("ext") in ("json", "srt"):
                    candidates.append((language, origin, entry))
    candidates.sort(key=lambda item: (not item[0].startswith("zh"), item[1] != "manual", item[0]))
    for language, origin, entry in candidates[:20]:
        try:
            payload = entry.get("data")
            if payload is None:
                path = folder / f"native.{entry['ext']}"
                download(entry["url"], path, info.get("http_headers"), 4 * 1024 * 1024)
                payload = path.read_text()
            if not isinstance(payload, str) or len(payload.encode()) > 4 * 1024 * 1024:
                continue
            cues = subtitle_cues(payload, entry["ext"])
            if any(c["end"] > info["duration"] + 5 for c in cues):
                continue
            return cues, {"id": f"{origin}:{language}", "language": language, "name": language,
                          "source": origin, "translated": False}
        except (ValueError, KeyError, TypeError, URLError, OSError):
            continue
    return None, None


def prepare(folder, info):
    audio = folder / "source.m4a"
    playable = folder / ("playback.mp4" if info["platform"] == "bilibili" else "playback.m4a")
    if playable.exists() and audio.exists():
        return audio, playable
    headers = {"User-Agent": "Mozilla/5.0", **(info.get("http_headers") or {})}
    if info["platform"] == "bilibili":
        headers["Referer"] = "https://www.bilibili.com/"
        formats = info.get("formats") or []
        audios = [f for f in formats if f.get("vcodec") == "none" and f.get("acodec") not in (None, "none") and f.get("url")]
        videos = [f for f in formats if f.get("vcodec", "").startswith("avc") and f.get("acodec") == "none" and f.get("url")]
        if not audios or not videos:
            raise ValueError("A public H.264 video and audio track are unavailable.")
        def download_formats(formats, path, video=False):
            # Peer CDN nodes may be unreachable from a server. Prefer platform CDN
            # URLs and try another advertised format, without retrying recognition.
            formats = sorted(formats, key=lambda f: (
                ".mcdn." in (urlsplit(f["url"]).hostname or ""),
                -(f.get("height") or 0) if video else f.get("abr") or f.get("tbr") or 9999,
            ))
            for candidate in formats[:3]:
                try:
                    download(candidate["url"], path, {**headers, **(candidate.get("http_headers") or {}),
                                                      "Referer": "https://www.bilibili.com/"})
                    return
                except (URLError, TimeoutError):
                    continue
            raise ValueError("The public media CDN is unavailable. Completed work is saved; retry shortly.")
        eligible = [f for f in videos if (f.get("height") or 9999) <= 720] or videos
        if not audio.exists():
            download_formats(audios, audio)
        update(folder, progress="Preparing video playback")
        video = folder / "video.m4s"
        if not video.exists():
            download_formats(eligible, video, True)
        temporary = folder / "playback.tmp.mp4"
        with LOCK:
            if cache_usage() + video.stat().st_size + audio.stat().st_size + 1024 * 1024 > MAX_CACHE:
                raise ValueError("The media cache is full. Completed work is saved.")
        run([FFMPEG, "-y", "-v", "error", "-i", str(video), "-i", str(audio), "-map", "0:v:0",
             "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", str(temporary)], 180)
        temporary.replace(playable)
        video.unlink()
    else:
        if not audio.exists():
            download(info["audio_url"], audio, headers)
        # Keep an independent playback name; MP4 audio supports browser byte-range seeking.
        import shutil
        with LOCK:
            if cache_usage() + audio.stat().st_size > MAX_CACHE:
                raise ValueError("The media cache is full. Completed work is saved.")
            shutil.copyfile(audio, playable)
    actual = duration(playable)
    if not math.isfinite(actual) or abs(actual - info["duration"]) > max(5, info["duration"] * .01):
        raise ValueError("Downloaded media does not match the source timeline.")
    return audio, playable


def reserve(minutes):
    with LOCK, sqlite3.connect(ROOT / "budget.sqlite") as db:
        day = time.strftime("%Y-%m-%d", time.gmtime())
        db.execute("BEGIN IMMEDIATE")
        spent = db.execute("SELECT COALESCE(SUM(minutes),0) FROM spend WHERE day=?", (day,)).fetchone()[0]
        if spent + minutes > DAILY_MINUTES:
            raise ValueError("Daily speech recognition limit reached. Completed segments are saved; retry after the limit resets.")
        request_id = str(uuid.uuid4())
        db.execute("INSERT INTO spend VALUES(?,?,?)", (request_id, day, minutes))
        return request_id


def recognize(folder, audio, seconds):
    key = os.environ.get("DOUBAO_API_KEY", "")
    if not key:
        raise ValueError("Speech recognition is not configured. Your link is saved.")
    cues = []
    total = math.ceil(seconds / CHUNK)
    for index in range(total):
        start = index * CHUNK
        length = min(CHUNK, seconds - start)
        cached = folder / f"chunk-{index:03}.json"
        pending = folder / f"chunk-{index:03}.sent"
        update(folder, progress=f"Transcribing segment {index + 1} of {total}")
        if cached.exists():
            cues.extend(read(cached))
            continue
        if pending.exists():
            raise ValueError("A speech request was interrupted. Completed segments are saved; retry explicitly.")
        mp3 = folder / f"chunk-{index:03}.mp3"
        run([FFMPEG, "-y", "-v", "error", "-ss", str(start), "-i", str(audio), "-t", str(length),
             "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", str(mp3)], 120)
        if mp3.stat().st_size > 100 * 1024 * 1024:
            raise ValueError("Speech segment exceeds the provider size limit.")
        request_id = reserve(length / 60)
        pending.write_text(request_id)
        body = json.dumps({"user": {"uid": "margin-media"}, "audio": {"data": base64.b64encode(mp3.read_bytes()).decode()},
                           "request": {"model_name": "bigmodel", "show_utterances": True,
                                       "enable_itn": True, "enable_punc": True}}).encode()
        request = Request("https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash", data=body, headers={
            "Content-Type": "application/json", "X-Api-Key": key, "X-Api-Resource-Id": "volc.bigasr.auc_turbo",
            "X-Api-Request-Id": request_id, "X-Api-Sequence": "-1"})
        with urlopen(request, timeout=240) as response:
            if response.headers.get("X-Api-Status-Code") != "20000000":
                raise ValueError("Speech recognition did not complete. Completed segments are saved; retry explicitly.")
            payload = response.read(4 * 1024 * 1024 + 1)
        if len(payload) > 4 * 1024 * 1024:
            raise ValueError("Speech response exceeds the size limit.")
        result = json.loads(payload).get("result") or {}
        items = result.get("utterances") or []
        segment = []
        for utterance in items:
            text = str(utterance.get("text", "")).strip()
            begin = float(utterance["start_time"]) / 1000
            end = float(utterance["end_time"]) / 1000
            if not text or len(text) > 12000 or not 0 <= begin <= end <= length + 5:
                raise ValueError("Speech recognition returned an invalid timeline.")
            segment.append({"start": start + begin, "end": min(seconds, start + end), "text": text})
        if not segment:
            # No speech in a segment is valid only when the provider also returns empty text.
            if result.get("text", "").strip():
                raise ValueError("Speech recognition returned text without timed sentences.")
        write(cached, segment)
        pending.unlink()
        mp3.unlink()
        cues.extend(segment)
    if not cues or len(cues) > 12000:
        raise ValueError("No usable timed speech was found.")
    return cues


def work(folder):
    try:
        update(folder, status="running", progress="Getting public media")
        state = read(folder / "state.json")
        info = metadata(folder, state)
        update(folder, title=str(info.get("title", ""))[:500], duration=info["duration"])
        cues, track = native_captions(folder, info)
        audio, playable = prepare(folder, info)
        if cues is None:
            cues = recognize(folder, audio, info["duration"])
            content = "".join(cue["text"] for cue in cues)
            language = "zh" if re.search(r"[\u4e00-\u9fff]", content) else str(info.get("language") or "und")[:50]
            track = {"id": "automatic:asr-original", "language": language, "name": "Original · speech recognition",
                     "source": "automatic", "translated": False}
        cues.sort(key=lambda cue: cue["start"])
        if any(not 0 <= c["start"] <= c["end"] <= info["duration"] + 5 for c in cues):
            raise ValueError("The transcript does not match the media timeline.")
        from captions import chapters
        completeness = "partial" if cues[0]["start"] > 90 or cues[-1]["end"] < info["duration"] - max(90, info["duration"] * .15) else "complete"
        result = {"title": str(info.get("title") or state["sourceId"])[:500],
                  "author": str(info.get("channel") or info.get("uploader") or "")[:300],
                  "duration": info["duration"], "tracks": [track], "selectedTrack": track["id"],
                  "cues": cues, "completeness": completeness, "chapters": chapters(info, info["duration"])}
        write(folder / "result.json", result)
        update(folder, status="complete", progress="Transcript ready", mediaFile=playable.name, error=None)
    except Exception as error:
        # Never serialize URLs, provider response bodies, credentials, or subprocess stderr.
        message = str(error) if isinstance(error, ValueError) else "Public media import failed. Completed segments are saved; retry explicitly."
        update(folder, status="failed", error=message[:300])
    finally:
        with LOCK:
            ACTIVE.discard(folder.name)


def serve(handler, key, head=False):
    state = status(key)
    if not state.get("mediaFile"):
        # Playback may be prepared while recognition is still running.
        name = "playback.mp4" if state["platform"] == "bilibili" else "playback.m4a"
    else:
        name = state["mediaFile"]
    path = ROOT / key / name
    if not path.exists():
        return handler.respond(404, {"error": "Media is not ready yet."})
    size = path.stat().st_size
    start, end = 0, size - 1
    requested = handler.headers.get("Range")
    if requested:
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested)
        if not match or not any(match.groups()):
            handler.send_response(416)
            handler.send_header("Content-Range", f"bytes */{size}")
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
        a, b = match.groups()
        if not a:
            start = max(0, size - int(b))
        else:
            start, end = int(a), min(size - 1, int(b)) if b else size - 1
        if start >= size or start > end:
            handler.send_response(416)
            handler.send_header("Content-Range", f"bytes */{size}")
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
    handler.send_response(206 if requested else 200)
    handler.send_header("Content-Type", "video/mp4" if name.endswith(".mp4") else "audio/mp4")
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Content-Length", str(end - start + 1))
    if requested:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    handler.end_headers()
    if not head:
        try:
            with path.open("rb") as stream:
                stream.seek(start)
                remaining = end - start + 1
                while remaining:
                    block = stream.read(min(256 * 1024, remaining))
                    if not block:
                        break
                    handler.wfile.write(block)
                    remaining -= len(block)
        except (BrokenPipeError, ConnectionResetError):
            pass
