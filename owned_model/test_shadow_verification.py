import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify-owned-shadow-artifacts.py"
SPEC = importlib.util.spec_from_file_location("verify_owned_shadow_artifacts", SCRIPT)
VERIFY = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(VERIFY)


class ShadowVerificationTests(unittest.TestCase):
    def test_fetch_manifest_binds_exact_local_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input.csv"
            source.write_bytes(b"player,points\none,1\n")
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            manifest = {
                "schemaVersion": 1,
                "attribution": "nflverse, CC-BY-4.0",
                "inputs": [{
                    "file": source.name,
                    "url": "https://example.test/input.csv",
                    "bytes": source.stat().st_size,
                    "sha256": digest,
                    "license": "CC-BY-4.0",
                }],
            }
            VERIFY.verify_fetch_manifest(manifest, root)
            source.write_bytes(b"player,points\none,2\n")
            with self.assertRaisesRegex(AssertionError, "Digest mismatch"):
                VERIFY.verify_fetch_manifest(manifest, root)

    def test_reproduction_comparison_ignores_only_generated_timestamp(self):
        first = {"generatedAt": "first", "modelVersion": "v1", "players": [{"id": "1"}]}
        second = {"generatedAt": "second", "modelVersion": "v1", "players": [{"id": "1"}]}
        self.assertEqual(VERIFY.inference_payload(first), VERIFY.inference_payload(second))
        second["players"][0]["id"] = "2"
        self.assertNotEqual(VERIFY.inference_payload(first), VERIFY.inference_payload(second))

    def test_candidate_inputs_must_match_fetch_manifest(self):
        inputs = [
            {"file": f"input-{index}.csv", "sha256": f"{index:064x}", "bytes": index + 1}
            for index in range(10)
        ]
        fetch = {"inputs": inputs}
        candidate = {"inputManifest": [dict(item) for item in inputs]}
        VERIFY.verify_candidate_inputs(candidate, fetch)
        candidate["inputManifest"][0]["bytes"] = 999
        with self.assertRaisesRegex(AssertionError, "Model/fetch manifest mismatch"):
            VERIFY.verify_candidate_inputs(candidate, fetch)

    def test_candidate_diagnostic_base_is_complete_and_wr_only(self):
        candidate = {
            "players": [
                {
                    "position": "RB", "meanStd": 90, "meanPpr": 110,
                    "baseMeanStd": 90, "baseMeanHalf": 100,
                    "baseMeanPpr": 110,
                },
                {
                    "position": "WR", "meanStd": 80, "meanPpr": 105,
                    "baseMeanStd": 70, "baseMeanHalf": 80,
                    "baseMeanPpr": 90,
                },
            ]
        }
        VERIFY.verify_candidate_diagnostics(candidate)
        candidate["players"][0]["baseMeanPpr"] = None
        with self.assertRaises(AssertionError):
            VERIFY.verify_candidate_diagnostics(candidate)


if __name__ == "__main__":
    unittest.main()
