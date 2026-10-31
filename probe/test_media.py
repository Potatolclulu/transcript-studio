import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import media


class FakeHandler:
    def __init__(self, range_header=None):
        self.headers = {"Range": range_header} if range_header else {}
        self.wfile = io.BytesIO()
        self.output = {}
    def send_response(self, status): self.status = status
    def send_header(self, name, value): self.output[name] = value
    def end_headers(self): pass
    def respond(self, status, data): self.status = status


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = patch.object(media, "ROOT", Path(self.folder.name))
        self.root.start()
        media.initialize()
    def tearDown(self):
        self.root.stop()
        self.folder.cleanup()

    def job(self, status="complete"):
        key = "a" * 64
        folder = media.ROOT / key
        folder.mkdir()
        media.write(folder / "state.json", {"key": key, "platform": "bilibili", "status": status,
                                          "sourceId": "BV1234567890:p1", "attempt": "attempt-0",
                                          "progress": "Ready", "error": None})
        (folder / "playback.mp4").write_bytes(bytes(range(100)))
        media.write(folder / "result.json", {"cues": []})
        return key, folder

    def test_ranges_head_and_unsatisfiable(self):
        key, _ = self.job()
        for requested, status, length, first in [
            (None, 200, 100, 0), ("bytes=10-19", 206, 10, 10),
            ("bytes=-5", 206, 5, 95), ("bytes=98-", 206, 2, 98),
            ("bytes=100-", 416, 0, None), ("bytes=20-10", 416, 0, None),
            ("bytes=0-1,4-5", 416, 0, None), ("bytes=-0", 416, 0, None),
        ]:
            handler = FakeHandler(requested)
            media.serve(handler, key)
            self.assertEqual(handler.status, status)
            self.assertEqual(len(handler.wfile.getvalue()), length)
            if first is not None: self.assertEqual(handler.wfile.getvalue()[0], first)
        handler = FakeHandler("bytes=10-19")
        media.serve(handler, key, True)
        self.assertEqual(handler.output["Content-Length"], "10")
        self.assertEqual(handler.wfile.getvalue(), b"")

    def test_restart_does_not_automatically_resend_speech(self):
        _, folder = self.job("running")
        media.write(folder / "chunk-000.json", [{"start": 0, "end": 3, "text": "完成"}])
        media.initialize()
        self.assertEqual(media.read(folder / "state.json")["status"], "failed")
        self.assertTrue((folder / "chunk-000.json").exists())

    def test_cache_checkpoint_skips_provider_and_reserved_minutes(self):
        _, folder = self.job()
        media.write(folder / "chunk-000.json", [{"start": 0, "end": 599, "text": "第一段"}])
        media.write(folder / "chunk-001.json", [{"start": 600, "end": 699, "text": "第二段"}])
        with patch.dict("os.environ", {"DOUBAO_API_KEY": "test-only"}), patch.object(media, "urlopen") as provider:
            cues = media.recognize(folder, folder / "source.m4a", 700)
        self.assertEqual(len(cues), 2)
        provider.assert_not_called()

    def test_interrupted_request_requires_explicit_retry(self):
        _, folder = self.job("failed")
        (folder / "chunk-000.sent").write_text("unknown-request")
        with patch.dict("os.environ", {"DOUBAO_API_KEY": "test-only"}), patch.object(media, "urlopen") as provider:
            with self.assertRaisesRegex(ValueError, "interrupted"):
                media.recognize(folder, folder / "source.m4a", 10)
        provider.assert_not_called()

    def test_polling_and_queue_redelivery_never_restart_a_failed_attempt(self):
        import hashlib
        key = hashlib.sha256(b"bilibili:BV1234567890:p1").hexdigest()
        folder = media.ROOT / key
        folder.mkdir()
        media.write(folder / "state.json", {"key": key, "platform": "bilibili", "status": "failed",
                                          "sourceId": "BV1234567890:p1", "attempt": "attempt-0"})
        media.write(folder / "chunk-000.json", [{"start": 0, "end": 10, "text": "Saved"}])
        media.write(folder / "metadata.json", {"signed": "expired"})
        (folder / "chunk-001.sent").write_text("unconfirmed")
        data = {"platform": "bilibili", "sourceId": "BV1234567890:p1", "attempt": "attempt-0"}
        with patch.object(media.POOL, "submit") as queue, patch.object(media, "ACTIVE", set()):
            self.assertEqual(media.submit(data)["status"], "failed")
            queue.assert_not_called()
            data["attempt"] = "attempt-1"
            self.assertEqual(media.submit(data)["status"], "queued")
            self.assertEqual(media.submit(data)["status"], "queued")
            queue.assert_called_once()
            self.assertTrue((folder / "chunk-000.json").exists())
            self.assertFalse((folder / "chunk-001.sent").exists())
            self.assertFalse((folder / "metadata.json").exists())
        with self.assertRaises(ValueError):
            media.submit([])

    def test_limits_and_source_whitelist(self):
        with patch.object(media, "DAILY_MINUTES", 1):
            media.reserve(.75)
            with self.assertRaisesRegex(ValueError, "Daily"):
                media.reserve(.5)
        for url in ("http://media.xyzcdn.net/test", "https://media.xyzcdn.net.evil.invalid/test",
                    "https://user:pass@media.xyzcdn.net/test", "https://media.xyzcdn.net:444/test"):
            with self.assertRaises(ValueError):
                media.download(url, media.ROOT / "no-file")
        for platform, source_id in (("bilibili", "BV1234567890:p0"), ("youtube", "arj7oStGLkU"),
                                   ("xiaoyuzhou", "../../file")):
            with self.assertRaises(ValueError): media.source(platform, source_id)

    def test_actual_ytdlp_inline_srt_is_used_without_downloading_or_recognition(self):
        _, folder = self.job()
        info = {"duration": 700, "subtitles": {
            "danmaku": [{"ext": "xml", "url": "https://comment.bilibili.com/1.xml"}],
            "zh-Hans": [{"ext": "srt", "data": "1\n00:00:01,250 --> 00:00:10,000\n<b>原文</b> &amp; 证据\n第二行\n\n2\n00:10:00,000 --> 00:11:40,000\n结束\n\n"}],
        }}
        with patch.object(media, "download") as fetcher, patch.object(media, "recognize") as recognize:
            cues, track = media.native_captions(folder, info)
        self.assertEqual(cues[0], {"start": 1.25, "end": 10, "text": "原文 & 证据\n第二行"})
        self.assertEqual(track["id"], "manual:zh-Hans")
        fetcher.assert_not_called()
        recognize.assert_not_called()

    def test_native_json_and_automatic_fallback_keep_their_origin(self):
        _, folder = self.job()
        info = {"duration": 700, "subtitles": {"danmaku": [{"ext": "xml"}]},
                "automatic_captions": {"zh": [{"ext": "json", "data": json.dumps({
                    "body": [{"from": 0, "to": 10, "content": "自动字幕"}]})}]}}
        cues, track = media.native_captions(folder, info)
        self.assertEqual(cues[0]["text"], "自动字幕")
        self.assertEqual(track["source"], "automatic")

    def test_invalid_native_timelines_fall_back_without_saving_wrong_anchors(self):
        _, folder = self.job()
        for data in ("1\n00:00:05,000 --> 00:00:01,000\n反向时间\n\n",
                     "1\n00:20:00,000 --> 00:21:00,000\n超出时长\n\n"):
            self.assertEqual(media.native_captions(folder, {"duration": 700,
                "subtitles": {"zh": [{"ext": "srt", "data": data}]}}), (None, None))

    def test_metadata_verifies_the_requested_bilibili_part(self):
        _, folder = self.job()
        state = {"platform": "bilibili", "sourceId": "BV1234567890:p2"}
        for wrong in ("BV1234567890_p1", None):
            with patch.object(media, "run", return_value=json.dumps({"id": wrong, "duration": 10}).encode()):
                with self.assertRaisesRegex(ValueError, "selected video part"):
                    media.metadata(folder, state)
        with patch.object(media, "run", return_value=json.dumps({"id": "BV1234567890_p2", "duration": 10}).encode()):
            self.assertEqual(media.metadata(folder, state)["id"], "BV1234567890_p2")


if __name__ == "__main__":
    unittest.main()
