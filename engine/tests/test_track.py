"""Turning SAM 3.1 answers into the outline the video overlay draws."""

from __future__ import annotations

import pytest
from meta_sam_parser import SegmentationMask, SegmentationMaskBounds

from track import box_prompt, to_frame_space, visible_ranges


def test_no_answers_means_never_visible() -> None:
    assert visible_ranges([]) == []


def test_close_frames_join_into_one_span() -> None:
    assert visible_ranges([0.0, 0.2, 0.4, 0.6]) == [[0.0, 0.6]]


def test_a_long_gap_ends_a_span() -> None:
    assert visible_ranges([0.0, 0.2, 5.0, 5.2]) == [[0.0, 0.2], [5.0, 5.2]]


def test_answers_out_of_order_are_sorted() -> None:
    assert visible_ranges([5.0, 0.0, 0.2]) == [[0.0, 0.2], [5.0, 5.0]]


def _mask() -> SegmentationMask:
    return SegmentationMask(encoding="lossless", payload="", width=100, height=50)


def test_a_mask_path_lands_where_the_object_is_in_the_frame() -> None:
    bounds = SegmentationMaskBounds(left=200.0, top=100.0, right=400.0, bottom=200.0)
    path = to_frame_space("M0 0 L50 25 L100 50", _mask(), bounds, (1.0, 1.0))
    assert path == "M200.0 100.0 L300.0 150.0 L400.0 200.0"


def test_the_video_downscale_is_undone() -> None:
    bounds = SegmentationMaskBounds(left=0.0, top=0.0, right=100.0, bottom=50.0)
    assert to_frame_space("M10 10", _mask(), bounds, (2.0, 2.0)) == "M20.0 20.0"


def test_a_path_with_nothing_to_place_is_an_error() -> None:
    bounds = SegmentationMaskBounds(left=0.0, top=0.0, right=1.0, bottom=1.0)
    with pytest.raises(RuntimeError):
        to_frame_space("Z", _mask(), bounds, (1.0, 1.0))


def test_a_box_prompt_is_written_by_metas_own_helper() -> None:
    prompt = box_prompt((640, 360), {"left": 10, "top": 20, "right": 30, "bottom": 40}, 5)
    assert isinstance(prompt, str)
    assert prompt
