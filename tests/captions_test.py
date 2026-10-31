"""Caption helper regression checks. Run: python3 -B -m unittest discover -s tests -p captions_test.py"""
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "captions", Path(__file__).resolve().parents[1] / "probe" / "captions.py"
)
captions = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(captions)


class CaptionSizeTests(unittest.TestCase):
    def extract(self, write_file):
        info = {
            "title": "Long lecture",
            "duration": 12683,
            "language": "en",
            "automatic_captions": {
                "en": [{"ext": "json3", "name": "English", "url": "https://example.com/captions"}]
            },
        }

        def command(args, folder, timeout=55):
            if "--dump-single-json" in args:
                return json.dumps(info)
            self.assertIn("--skip-download", args)
            self.assertIn("--write-auto-subs", args)
            write_file(Path(folder) / "source.en.json3")
            return ""

        with patch.object(captions, "command", side_effect=command):
            return captions.extract("7xTGNNLPyMI")

    def test_large_raw_json3_is_reduced_to_a_bounded_response(self):
        def write_file(path):
            # Raw format/timing overhead should not count as returned transcript text.
            path.write_text(json.dumps({
                "formatting": " " * (captions.MAX_DATA + 148525),
                "events": [
                    {"tStartMs": 0, "dDurationMs": 5000, "segs": [{"utf8": "An opening idea."}]},
                    {"tStartMs": 12678000, "dDurationMs": 5000, "segs": [{"utf8": "A final idea."}]},
                ],
            }))
            self.assertGreater(path.stat().st_size, captions.MAX_DATA)
            self.assertLess(path.stat().st_size, captions.MAX_CAPTION_FILE)

        result = self.extract(write_file)
        self.assertEqual(result["completeness"], "complete")
        self.assertEqual([cue["text"] for cue in result["cues"]], ["An opening idea.", "A final idea."])
        self.assertLess(len(json.dumps(result).encode()), captions.MAX_DATA)

    def test_oversized_raw_file_is_rejected_with_a_size_error(self):
        def write_file(path):
            with path.open("wb") as target:
                target.truncate(captions.MAX_CAPTION_FILE + 1)

        with self.assertRaisesRegex(ValueError, "caption file exceeds.*size limit"):
            self.extract(write_file)

    def test_missing_caption_file_remains_a_download_error(self):
        with self.assertRaisesRegex(ValueError, "Captions could not be downloaded"):
            self.extract(lambda path: None)

    def test_chinese_translation_remains_visible_among_many_advertised_tracks(self):
        info = {"language": "en", "automatic_captions": {
            **{f"lang{i}": [{"ext": "json3", "url": f"https://example.com/?tlang=lang{i}"}] for i in range(150)},
            "en": [{"ext": "json3", "url": "https://example.com/"}],
            "zh-Hans": [{"ext": "json3", "url": "https://example.com/?tlang=zh-Hans"}],
        }}
        tracks = captions.available(info)
        self.assertEqual(tracks[0]["language"], "en")
        self.assertIn("zh-Hans", [t["language"] for t in tracks])
        self.assertEqual(len(tracks), 100)

    def test_metadata_mode_does_not_download_captions(self):
        info = {"duration": 120, "chapters": [{"start_time": 0, "end_time": 60, "title": "Opening"},
                                            {"start_time": 60, "end_time": 120, "title": "Main topic"}]}
        with patch.object(captions, "command", return_value=json.dumps(info)) as command:
            result = captions.extract("7xTGNNLPyMI", mode="metadata")
        self.assertEqual(command.call_count, 1)
        self.assertEqual(result["chapters"][1]["start"], 60)


if __name__ == "__main__":
    unittest.main()
