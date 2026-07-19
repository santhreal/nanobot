"""CronJob.from_dict must load partial run_history rows."""

from nanobot.cron.types import CronJob


def test_from_dict_accepts_run_history_without_run_at_ms() -> None:
    job = CronJob.from_dict(
        {
            "id": "j1",
            "name": "n",
            "schedule": {"kind": "every", "every_ms": 60_000},
            "state": {"run_history": [{"status": "ok"}]},
        }
    )
    assert len(job.state.run_history) == 1
    assert job.state.run_history[0].run_at_ms == 0
    assert job.state.run_history[0].status == "ok"
    assert job.state.run_history[0].duration_ms == 0
