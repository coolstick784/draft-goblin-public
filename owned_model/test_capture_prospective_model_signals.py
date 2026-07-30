import importlib.util
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "capture-prospective-model-signals.py"
SPEC = importlib.util.spec_from_file_location("capture_prospective_model_signals", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
POLICY = json.loads((Path(__file__).parents[1] / "data" / "model-signal-policy.json").read_text(encoding="utf-8"))


class Headers(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class Response:
    def __init__(self, data, headers=None):
        self.data = data
        self.headers = Headers(headers or {})

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return self.data


class CaptureProspectiveSignalsTest(unittest.TestCase):
    def setUp(self):
        self.original_open = MODULE.urllib.request.urlopen
        self.original_sleep = MODULE.time.sleep

    def tearDown(self):
        MODULE.urllib.request.urlopen = self.original_open
        MODULE.time.sleep = self.original_sleep

    def test_capture_hashes_required_data_and_records_optional_404(self):
        csv_data = b"player_id,team,position\n" + b"00-0000001,BUF,WR\n" * 12

        def fake_open(request, **_):
            if "injuries_" in request.full_url:
                raise urllib.error.HTTPError(request.full_url, 404, "not published", {}, None)
            return Response(csv_data, {"ETag": '"abc123"', "Last-Modified": "Fri, 17 Jul 2026 10:00:00 GMT"})

        MODULE.urllib.request.urlopen = fake_open
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            manifest = MODULE.capture_policy_signals(POLICY, 2026, output, "2026-07-17T10:47:00Z")
            stored = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(stored, manifest)
        self.assertFalse(manifest["eligibleToAffectProduction"])
        roster = next(row for row in manifest["signals"] if row["id"] == "nflverse-weekly-rosters")
        injuries = next(row for row in manifest["signals"] if row["id"] == "nflverse-injuries")
        self.assertTrue(roster["available"])
        self.assertEqual(roster["headers"]["etag"], '"abc123"')
        self.assertEqual(len(roster["sha256"]), 64)
        self.assertFalse(injuries["available"])
        self.assertEqual(injuries["reason"], "not-published")

    def test_required_404_fails_closed(self):
        def missing(request, **_):
            raise urllib.error.HTTPError(request.full_url, 404, "missing", {}, None)

        MODULE.urllib.request.urlopen = missing
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(urllib.error.HTTPError):
                MODULE.capture_policy_signals(POLICY, 2026, Path(directory))

    def test_transient_failure_retries(self):
        calls = []
        sleeps = []
        csv_data = b"player_id,team\n" + b"00-0000001,BUF\n" * 12

        def flaky(request, **_):
            calls.append(request.full_url)
            if len(calls) < 3:
                raise urllib.error.URLError(ConnectionResetError("reset"))
            return Response(csv_data)

        MODULE.urllib.request.urlopen = flaky
        MODULE.time.sleep = sleeps.append
        data, _ = MODULE.fetch_bytes("https://example.test/rosters.csv")
        self.assertEqual(data, csv_data)
        self.assertEqual(len(calls), 3)
        self.assertEqual(sleeps, [1, 2])


if __name__ == "__main__":
    unittest.main()
