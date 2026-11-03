"""A separation that is one click in silence is no sound at all."""

from __future__ import annotations

import math

from isolate import LONE_TRANSIENT_CREST_DB, MAX_INVENTED_SHARE, crest_db, invented_share


def test_a_lone_click_is_far_above_the_threshold() -> None:
    assert crest_db(peak=10 ** (-11.8 / 20), rms=10 ** (-56.7 / 20)) > LONE_TRANSIENT_CREST_DB


def test_real_events_stay_under_it() -> None:
    for peak_db, rms_db in ((-1.1, -26.3), (-1.0, -33.0)):
        assert crest_db(10 ** (peak_db / 20), 10 ** (rms_db / 20)) < LONE_TRANSIENT_CREST_DB


def test_a_sine_has_the_crest_of_a_sine() -> None:
    assert math.isclose(crest_db(1.0, 1 / math.sqrt(2)), 20 * math.log10(math.sqrt(2)))


def test_a_sound_where_the_mix_has_nothing_is_invented() -> None:
    mix = [1.0, 1.0, 0.0001, 0.0001]
    rain = [0.1, 0.1, 1.0, 1.0]
    assert invented_share(rain, mix) > MAX_INVENTED_SHARE


def test_a_sound_inside_the_mix_is_not() -> None:
    mix = [1.0, 1.0, 0.5, 0.0001]
    piano = [0.9, 0.6, 0.2, 0.0]
    assert invented_share(piano, mix) == 0.0
