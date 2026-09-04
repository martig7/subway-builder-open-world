from pathlib import Path
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
RUNNER_SCRIPT = REPOSITORY_ROOT / "map-creator" / "scripts" / "run_japan_map_queue.ps1"
DETACHED_SCRIPT = REPOSITORY_ROOT / "map-creator" / "scripts" / "run_japan_map_queue_detached.ps1"
ROUTING_SCRIPT = REPOSITORY_ROOT / "map-creator" / "scripts" / "run_japan_routing_detached.ps1"
ROUTING_START_SCRIPT = REPOSITORY_ROOT / "map-creator" / "scripts" / "start_japan_routing.ps1"


class JapanRunnerScriptTests(unittest.TestCase):
    def test_downloads_are_resumable_and_only_published_after_success(self) -> None:
        script = RUNNER_SCRIPT.read_text(encoding="utf-8")

        partial_assignment = script.index('$partial = "$destination.partial"')
        retry_all_errors = script.index("--retry-all-errors")
        curl_exit_check = script.index("if ($LASTEXITCODE -ne 0)")
        publish = script.index("Move-Item -Force -LiteralPath $partial -Destination $destination")

        self.assertLess(partial_assignment, retry_all_errors)
        self.assertLess(retry_all_errors, curl_exit_check)
        self.assertLess(curl_exit_check, publish)
        self.assertIn("--continue-at -", script)

    def test_detached_queue_persists_progress_and_terminal_status(self) -> None:
        script = DETACHED_SCRIPT.read_text(encoding="utf-8")

        self.assertIn("queue.stdout.log", script)
        self.assertIn("queue.stderr.log", script)
        self.assertIn("queue.status.json", script)
        self.assertIn("queue.pid", script)
        self.assertIn("Write-QueueStatus -state 'complete' -exitCode 0", script)
        self.assertIn("Write-QueueStatus -state 'failed' -exitCode 1", script)

    def test_detached_routing_persists_progress_and_terminal_status(self) -> None:
        script = ROUTING_SCRIPT.read_text(encoding="utf-8")
        starter = ROUTING_START_SCRIPT.read_text(encoding="utf-8")

        self.assertIn("routing-progress.jsonl", script)
        self.assertIn("routing.stdout.log", script)
        self.assertIn("routing.stderr.log", script)
        self.assertIn("routing.status.json", script)
        self.assertIn("routing.pid", script)
        self.assertIn("Write-RoutingStatus -state 'complete' -exitCode 0", script)
        self.assertIn("Write-RoutingStatus -state 'failed' -exitCode 1", script)
        self.assertIn("-WindowStyle Hidden", starter)
        self.assertIn("'-DemandRoot', $DemandRoot", starter)
        self.assertIn("'-Invalidation', $Invalidation", starter)
        self.assertIn("launcher.stderr.log", starter)


if __name__ == "__main__":
    unittest.main()
