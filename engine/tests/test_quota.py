"""The per-IP daily limits that bound what one visitor can spend."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from ingest import DAILY_CLIP_QUOTA, DAILY_ISOLATION_QUOTA, QuotaExceededError
from ingest import check_and_increment_quota as charge


def _usage(cache_root: Path) -> dict[str, dict[str, int]]:
    day = time.strftime("%Y-%m-%d", time.gmtime())
    usage: dict[str, dict[str, int]] = json.loads(
        (cache_root / "quotas" / f"{day}.json").read_text(encoding="utf-8")
    )
    return usage


def test_each_use_is_counted(cache_root: Path) -> None:
    charge("1.1.1.1", "clips", cache_root)
    charge("1.1.1.1", "clips", cache_root)
    charge("1.1.1.1", "isolations", cache_root)
    assert _usage(cache_root)["1.1.1.1"] == {"clips": 2, "isolations": 1}


def test_the_default_limits_are_the_documented_cost_guards() -> None:
    assert DAILY_CLIP_QUOTA == 25
    assert DAILY_ISOLATION_QUOTA == 50


def test_the_limit_refuses_the_next_use_and_keeps_the_count(
    cache_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MIXRAY_DAILY_CLIP_QUOTA", "2")
    charge("1.1.1.1", "clips", cache_root)
    charge("1.1.1.1", "clips", cache_root)
    with pytest.raises(QuotaExceededError, match=r"clips limit \(2\)"):
        charge("1.1.1.1", "clips", cache_root)
    assert _usage(cache_root)["1.1.1.1"]["clips"] == 2


def test_clips_and_isolations_have_separate_limits(
    cache_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MIXRAY_DAILY_CLIP_QUOTA", "1")
    charge("1.1.1.1", "clips", cache_root)
    charge("1.1.1.1", "isolations", cache_root)
    with pytest.raises(QuotaExceededError):
        charge("1.1.1.1", "clips", cache_root)


def test_one_visitor_does_not_use_up_another(
    cache_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MIXRAY_DAILY_ISOLATION_QUOTA", "1")
    charge("1.1.1.1", "isolations", cache_root)
    charge("2.2.2.2", "isolations", cache_root)
    with pytest.raises(QuotaExceededError):
        charge("1.1.1.1", "isolations", cache_root)


def test_the_count_starts_again_each_day(cache_root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MIXRAY_DAILY_CLIP_QUOTA", "1")
    charge("1.1.1.1", "clips", cache_root)
    day = time.strftime("%Y-%m-%d", time.gmtime())
    (cache_root / "quotas" / f"{day}.json").rename(cache_root / "quotas" / "2000-01-01.json")
    charge("1.1.1.1", "clips", cache_root)


def test_the_quota_can_be_switched_off_for_local_work(
    cache_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MIXRAY_DISABLE_QUOTA", "1")
    monkeypatch.setenv("MIXRAY_DAILY_CLIP_QUOTA", "0")
    charge("1.1.1.1", "clips", cache_root)
    assert not (cache_root / "quotas").exists()
