from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from replay_roundtrip import run_logged


@unittest.skipUnless(sys.platform.startswith("linux"), "owned process groups require Linux/WSL")
class OwnedCommandTests(unittest.TestCase):
    def command(self, marker, exit_code=None):
        child = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"
        parent = (
            "import os,subprocess,sys,time; from pathlib import Path; "
            f"child=subprocess.Popen([sys.executable,'-c',{child!r}]); "
            f"Path({str(marker)!r}).write_text(str(os.getpid())+' '+str(child.pid)); "
            + ("time.sleep(60)" if exit_code is None else f"sys.exit({exit_code})")
        )
        return [sys.executable, "-c", parent]

    def assert_stopped(self, marker):
        self.assertTrue(marker.is_file(), "test command did not start both processes")
        for pid in map(int, marker.read_text().split()):
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                stat = Path(f"/proc/{pid}/stat")
                if not stat.exists() or stat.read_text().split()[2] == "Z":
                    break
                time.sleep(0.02)
            else:
                self.fail(f"owned process {pid} survived cancellation")

    def test_timeout_stops_parent_and_sigterm_ignoring_child(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory)
            marker = logs / "processes"
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                run_logged(logs, "timeout", self.command(marker), timeout=2)
            self.assert_stopped(marker)

    def test_interruption_stops_parent_and_child(self):
        original_popen = subprocess.Popen
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory)
            marker = logs / "processes"

            def popen(*args, **kwargs):
                process = original_popen(*args, **kwargs)
                original_wait = process.wait
                first = True

                def wait(*args, **kwargs):
                    nonlocal first
                    if first:
                        first = False
                        deadline = time.monotonic() + 3
                        while not marker.exists() and time.monotonic() < deadline:
                            time.sleep(0.02)
                        raise KeyboardInterrupt("fixture interruption")
                    return original_wait(*args, **kwargs)

                process.wait = wait
                return process

            with patch("replay_roundtrip.subprocess.Popen", side_effect=popen):
                with self.assertRaises(KeyboardInterrupt):
                    run_logged(logs, "interrupted", self.command(marker))
            self.assert_stopped(marker)

    def test_completed_parent_cannot_leave_background_child(self):
        for code in (0, 7):
            with self.subTest(exit_code=code), tempfile.TemporaryDirectory() as directory:
                logs = Path(directory)
                marker = logs / "processes"
                if code == 0:
                    result, _, _ = run_logged(logs, "completed", self.command(marker, code))
                    self.assertEqual(result, 0)
                else:
                    with self.assertRaisesRegex(RuntimeError, "exited 7"):
                        run_logged(logs, "failed", self.command(marker, code))
                self.assert_stopped(marker)


if __name__ == "__main__":
    unittest.main()
