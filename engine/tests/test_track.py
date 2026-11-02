"""Turning SAM 3.1 answers into the box the video overlay draws."""

from __future__ import annotations

from meta_sam_parser import SegmentationMaskBounds

from track import box_path, box_prompt, visible_ranges


def test_no_answers_means_never_visible() -> None:
    assert visible_ranges([]) == []


def test_close_frames_join_into_one_span() -> None:
    assert visible_ranges([0.0, 0.2, 0.4, 0.6]) == [[0.0, 0.6]]


def test_a_long_gap_ends_a_span() -> None:
    assert visible_ranges([0.0, 0.2, 5.0, 5.2]) == [[0.0, 0.2], [5.0, 5.2]]


def test_answers_out_of_order_are_sorted() -> None:
    assert visible_ranges([5.0, 0.0, 0.2]) == [[0.0, 0.2], [5.0, 5.0]]


def test_the_box_lands_where_the_object_is_in_the_frame() -> None:
    bounds = SegmentationMaskBounds(left=100.0, top=50.0, right=200.0, bottom=150.0)
    assert box_path(bounds, (1.0, 1.0)) == "M100.0 50.0L200.0 50.0L200.0 150.0L100.0 150.0Z"


def test_the_video_downscale_is_undone() -> None:
    bounds = SegmentationMaskBounds(left=10.0, top=20.0, right=30.0, bottom=40.0)
    assert box_path(bounds, (2.0, 2.0)) == "M20.0 40.0L60.0 40.0L60.0 80.0L20.0 80.0Z"


def test_a_box_prompt_is_written_by_metas_own_helper() -> None:
    prompt = box_prompt((640, 360), {"left": 10, "top": 20, "right": 30, "bottom": 40}, 5)
    assert isinstance(prompt, str)
    assert prompt
