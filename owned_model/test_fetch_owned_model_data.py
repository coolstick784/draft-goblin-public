import importlib.util
import tempfile
import unittest
import urllib.error
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "fetch-owned-model-data.py"
SPEC = importlib.util.spec_from_file_location("fetch_owned_model_data", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Response:
    def __init__(self, data):
        self.data = data

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return self.data


class FetchOwnedModelDataTest(unittest.TestCase):
    def setUp(self):
        self.original_open = MODULE.urllib.request.urlopen
        self.original_sleep = MODULE.time.sleep

    def tearDown(self):
        MODULE.urllib.request.urlopen = self.original_open
        MODULE.time.sleep = self.original_sleep

    def test_download_retries_transient_connection_failures(self):
        calls = []
        sleeps = []

        def flaky_open(*args, **kwargs):
            calls.append((args, kwargs))
            if len(calls) < 3:
                raise urllib.error.URLError(ConnectionResetError("reset"))
            return Response(b"player_id,points\n" + b"a,1\n" * 30)

        MODULE.urllib.request.urlopen = flaky_open
        MODULE.time.sleep = sleeps.append
        with tempfile.TemporaryDirectory() as directory:
            result = MODULE.download("https://example.test/data.csv", Path(directory) / "data.csv")
        self.assertGreater(result["bytes"], 100)
        self.assertEqual(len(calls), 3)
        self.assertEqual(sleeps, [1, 2])

    def test_download_does_not_retry_permanent_client_errors(self):
        calls = []

        def missing(*args, **kwargs):
            calls.append((args, kwargs))
            raise urllib.error.HTTPError("https://example.test/missing.csv", 404, "missing", {}, None)

        MODULE.urllib.request.urlopen = missing
        MODULE.time.sleep = lambda *_: None
        with self.assertRaises(urllib.error.HTTPError) as raised:
            MODULE.fetch_bytes("https://example.test/missing.csv")
        self.assertEqual(raised.exception.code, 404)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
