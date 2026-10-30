"""Ask Muse Spark what it hears in a clip, and turn that into pickable suggestion chips.

The Pick screen currently offers the same four hardcoded chips for every clip. This replaces them
with the sounds that are actually in the recording, each carrying the text prompt SAM Audio should
be given for it.

Three findings from `SPEC.md` §9 shape the whole module, and all three were measured rather than
assumed:

* `input_audio` is silently dropped - the request succeeds, the token count does not move and the
  model answers that it was given no audio. Audio has to travel inside an mp4 as `input_video`.
* That mp4's picture must not be blank. With black frames only 2 of 5 runs heard the audio; with the
  waveform drawn into it, 5 of 5 did. The prompt must also never mention the picture, because
  telling the model to ignore it brings the refusal straight back.
* Structured output is unreliable while audio is attached, so this runs two calls: one that listens
  and answers in plain prose, and a second, audio-free one that turns that prose into JSON.
"""

import json
import logging
import re
import subprocess
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import TypedDict, TypeGuard

import modal

import meta_api
from images import web_image
from ingest import build_served_trackmap, clip_dir, get_cache_root

LOGGER = logging.getLogger(__name__)

app = modal.App("mixray-suggest")

CACHE_VOLUME = modal.Volume.from_name("mixray-cache", create_if_missing=True)
CACHE_PATH = "/cache"

SUGGEST_TIMEOUT_SECONDS = 300
API_SECRET = modal.Secret.from_name("mixray-secrets")

# 1.2, not 1.3: the docs say audio understanding in 1.3 is not fully supported and may be degraded.
# Contributor mode is the production default, as CONTEXT.md decided and the Add screen discloses.
# Callers may pass the standard model instead, which costs roughly twelve times as much but keeps
# the request out of Meta's training data - worth it when the audio is not ours to contribute.
LISTEN_MODEL = "muse-spark-1.2-contributor"
STRUCTURE_MODEL = "muse-spark-1.2-contributor"
STANDARD_MODEL = "muse-spark-1.2"
# Reasoning shares the output budget, so a small cap can return an empty answer.
MAX_OUTPUT_TOKENS = 4000

WAVEFORM_SIZE = "320x180"
WAVEFORM_RATE = 5
MIN_SUGGESTIONS = 3
MAX_SUGGESTIONS = 6
SUMMARY_ATTEMPTS = 2
MIDI_PITCHES_PER_OCTAVE = 12
MIDI_OCTAVE_OFFSET = 1
MIDI_MAX = 127
MIDI_NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")

# The numeric matcher deliberately includes the octave in a note name such as C4. The note-name
# check below then ensures the complete spelling is one supplied by the TrackMap.
NUMBER_PATTERN = re.compile(r"(?<![\d.])-?\d+(?:\.\d+)?(?!\d)")
NOTE_NAME_PATTERN = re.compile(r"(?<![A-Za-z#b])([A-G](?:#|b)?-?\d+)(?![A-Za-z])")

# Lowercase noun phrases, because SAM Audio was trained on them: its README asks for "thunder"
# rather than "thunder can be heard in the background".
LISTEN_INSTRUCTION = (
    "This is a music clip. Listen to it and describe, in plain prose, each distinct sound you can "
    "hear - instruments, voices, drums, textures. For each one say what it is and how it behaves "
    "in the mix. Then give one sentence describing the clip as a whole: its genre, tempo feel and "
    "mood. Be concrete and only name sounds you actually hear."
)

# The mp4 workaround is not reliable every time. A run that fails comes back describing the picture
# or denying there was any audio, and it does so in a perfectly well-formed reply, so shape
# validation lets it through: one such run produced the chips "No Audible Audio" and "Waveform
# Image Only". These are the words those failures use; seeing any of them means the model never
# heard the clip, and the only fix is to ask again.
DEAF_MARKERS = (
    "waveform",
    "no audible",
    "no audio",
    "cannot hear",
    "can't hear",
    "unable to hear",
    "black background",
    "black screen",
    "text-based",
    "silent display",
)
STRUCTURE_INSTRUCTION = (
    "Turn the following description of a music clip into JSON. Produce between "
    f"{MIN_SUGGESTIONS} and {MAX_SUGGESTIONS} suggestions, one per distinct sound, ordered by how "
    "prominent the sound is. `label` is a short title for a button, in Title case, at most three "
    "words. `prompt` is the same sound written as a lowercase noun phrase for an audio separation "
    "model, such as 'synth lead' or 'kick drum' - no verbs, no sentence, no punctuation. `summary` "
    "is the single sentence describing the whole clip."
)


class Suggestion(TypedDict):
    """One chip on the Pick screen: what to show, and what to ask SAM Audio for."""

    label: str
    prompt: str


class ClipSuggestions(TypedDict):
    """Everything `suggest` contributes to a trackmap."""

    suggestions: list[Suggestion]
    summary: str


class SoundSummaryFacts(TypedDict):
    """The complete, TrackMap-derived material Muse may use in a sound summary."""

    label: str
    key: str
    tempo_bpm: float
    duration_seconds: float
    low_midi: int
    low_note: str
    high_midi: int
    high_note: str
    entry_bar: int
    note_count: int


SUGGESTION_SCHEMA: dict[str, object] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["suggestions", "summary"],
    "properties": {
        "suggestions": {
            "type": "array",
            "minItems": MIN_SUGGESTIONS,
            "maxItems": MAX_SUGGESTIONS,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["label", "prompt"],
                "properties": {"label": {"type": "string"}, "prompt": {"type": "string"}},
            },
        },
        "summary": {"type": "string"},
    },
}


def waveform_mp4(wav_path: Path, mp4_path: Path) -> None:
    """Wrap the audio in an mp4 whose picture is its own waveform.

    Both streams are given the same explicit duration: `-shortest` against a generated video source
    once left a 41 s picture over 30 s of audio.
    """
    argv = [
        "ffmpeg",
        "-y",
        "-i",
        str(wav_path),
        "-filter_complex",
        f"[0:a]showwaves=s={WAVEFORM_SIZE}:mode=line:rate={WAVEFORM_RATE}[v]",
        "-map",
        "[v]",
        "-map",
        "0:a",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        str(mp4_path),
    ]
    subprocess.run(argv, check=True, capture_output=True)


def heard_audio(description: str) -> bool:
    """True when the reply describes sound rather than denying there was any."""
    lowered = description.lower()
    return not any(marker in lowered for marker in DEAF_MARKERS)


def listen_to_clip(mp4_path: Path, api_key: str, model: str = LISTEN_MODEL) -> str:
    """Ask the model what it hears, in prose, until it actually hears something.

    The picture is never mentioned, by design: telling the model to ignore it reliably brings back
    the refusal this retries around.
    """
    payload: dict[str, object] = {
        "model": model,
        "max_output_tokens": MAX_OUTPUT_TOKENS,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": LISTEN_INSTRUCTION},
                    # The media source sits directly on the part, and inline base64 travels as a
                    # data URL: an `input_video` carrying a `data` field is rejected with
                    # "input_video content part requires `video_url` or `file_id`".
                    {"type": "input_video", "video_url": meta_api.data_url(mp4_path, "video/mp4")},
                ],
            }
        ],
    }
    for attempt in range(1, meta_api.ATTEMPTS + 1):
        description = meta_api.output_text(meta_api.post_responses(payload, api_key))
        if heard_audio(description):
            return description
        LOGGER.warning(
            "attempt %d/%d did not hear the clip: %s", attempt, meta_api.ATTEMPTS, description[:120]
        )
    raise RuntimeError(f"Muse Spark did not hear the clip in {meta_api.ATTEMPTS} attempts")


def structure_description(
    description: str, api_key: str, model: str = STRUCTURE_MODEL
) -> ClipSuggestions:
    """Turn the prose description into chips. No audio here, so strict JSON is safe."""
    payload: dict[str, object] = {
        "model": model,
        "max_output_tokens": MAX_OUTPUT_TOKENS,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": f"{STRUCTURE_INSTRUCTION}\n\n{description}"}
                ],
            }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "clip_suggestions",
                "schema": SUGGESTION_SCHEMA,
                "strict": True,
            }
        },
    }
    return parse_suggestions(meta_api.output_text(meta_api.post_responses(payload, api_key)))


def parse_suggestions(raw: str) -> ClipSuggestions:
    """Validate the model's JSON at the boundary before any of it reaches a trackmap."""
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise RuntimeError("suggestions reply was not an object")
    summary = parsed.get("summary")
    items = parsed.get("suggestions")
    if not isinstance(summary, str) or not isinstance(items, list):
        raise RuntimeError("suggestions reply was missing summary or suggestions")

    suggestions: list[Suggestion] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        label, prompt = item.get("label"), item.get("prompt")
        if not isinstance(label, str) or not isinstance(prompt, str):
            continue
        cleaned = prompt.strip().lower().rstrip(".")
        if label.strip() and cleaned:
            suggestions.append({"label": label.strip(), "prompt": cleaned})
    if len(suggestions) < MIN_SUGGESTIONS:
        raise RuntimeError(f"only {len(suggestions)} usable suggestions came back")
    return {"suggestions": suggestions[:MAX_SUGGESTIONS], "summary": summary.strip()}


def _is_json_object(value: object) -> TypeGuard[dict[str, object]]:
    """Narrow JSON objects before reading untrusted sidecars."""
    return isinstance(value, dict) and all(isinstance(key, str) for key in value)


def _required_string(value: object, field: str) -> str:
    """Read a non-empty string from a TrackMap field."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"trackmap {field} must be a non-empty string")
    return value.strip()


def _required_number(value: object, field: str) -> float:
    """Read a finite JSON number without accepting bools."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"trackmap {field} must be a number")
    number = float(value)
    if not Decimal(str(number)).is_finite():
        raise ValueError(f"trackmap {field} must be finite")
    return number


def _required_int(value: object, field: str) -> int:
    """Read a JSON integer without accepting bools."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"trackmap {field} must be an integer")
    return value


def _required_json_object(value: object, field: str) -> dict[str, object]:
    """Read a JSON object from a required TrackMap field."""
    if not _is_json_object(value):
        raise ValueError(f"trackmap {field} is missing")
    return value


def _required_nonempty_list(value: object, field: str) -> list[object]:
    """Read a non-empty JSON array from a required TrackMap field."""
    if not isinstance(value, list) or not value:
        raise ValueError(f"trackmap {field} is missing")
    return value


def _summary_isolation(isolations: list[object], isolation_id: str) -> dict[str, object]:
    """Find the requested isolation in an assembled TrackMap."""
    for candidate in isolations:
        if _is_json_object(candidate) and candidate.get("id") == isolation_id:
            return candidate
    raise ValueError(f"trackmap isolation is missing: {isolation_id}")


def _summary_range(isolation: dict[str, object]) -> tuple[int, int]:
    """Read and validate the isolation range used as sound-summary material."""
    note_range = _required_json_object(isolation.get("range"), "isolation range")
    low_midi = _required_int(note_range.get("low"), "isolation range low")
    high_midi = _required_int(note_range.get("high"), "isolation range high")
    if not 0 <= low_midi <= high_midi <= MIDI_MAX:
        raise ValueError("isolation range is invalid")
    return low_midi, high_midi


def _earliest_note_start(isolation: dict[str, object]) -> tuple[float, int]:
    """Return the isolation's first note time and its TrackMap note count."""
    notes = _required_nonempty_list(isolation.get("notes"), "isolation notes")
    note_starts: list[float] = []
    for index, note in enumerate(notes):
        note_object = _required_json_object(note, f"isolation notes[{index}]")
        note_starts.append(
            _required_number(note_object.get("start"), f"isolation notes[{index}].start")
        )
    return min(note_starts), len(notes)


def _entry_bar(downbeats: list[object], entry_time: float) -> int:
    """Return the one-based displayed bar containing an isolation's first note."""
    entry_bar = 1
    for index, raw_downbeat in enumerate(downbeats, start=1):
        downbeat = _required_number(raw_downbeat, f"downbeats[{index - 1}]")
        if downbeat > entry_time:
            break
        entry_bar = index
    return entry_bar


def midi_note_name(pitch: int) -> str:
    """Return the schema-compatible sharp spelling for one MIDI pitch."""
    if not 0 <= pitch <= MIDI_MAX:
        raise ValueError(f"MIDI pitch is outside range: {pitch}")
    name = MIDI_NOTE_NAMES[pitch % MIDI_PITCHES_PER_OCTAVE]
    octave = pitch // MIDI_PITCHES_PER_OCTAVE - MIDI_OCTAVE_OFFSET
    return f"{name}{octave}"


def isolation_summary_facts(trackmap: dict[str, object], isolation_id: str) -> SoundSummaryFacts:
    """Collect only facts already held by the assembled TrackMap for one isolation."""
    tempo = _required_json_object(trackmap.get("tempo"), "tempo")
    key = _required_json_object(trackmap.get("key"), "key")
    downbeats = _required_nonempty_list(trackmap.get("downbeats"), "downbeats")
    isolations = _required_nonempty_list(trackmap.get("isolations"), "isolations")
    isolation = _summary_isolation(isolations, isolation_id)
    low_midi, high_midi = _summary_range(isolation)
    entry_time, note_count = _earliest_note_start(isolation)
    tonic = _required_string(key.get("tonic"), "key tonic")
    mode = _required_string(key.get("mode"), "key mode")
    return {
        "label": _required_string(isolation.get("label"), "isolation label"),
        "key": f"{tonic} {mode}",
        "tempo_bpm": _required_number(tempo.get("bpm"), "tempo bpm"),
        "duration_seconds": _required_number(trackmap.get("duration"), "duration"),
        "low_midi": low_midi,
        "low_note": midi_note_name(low_midi),
        "high_midi": high_midi,
        "high_note": midi_note_name(high_midi),
        "entry_bar": _entry_bar(downbeats, entry_time),
        "note_count": note_count,
    }


def _decimal(value: int | float) -> Decimal:
    """Normalise a JSON number for exact comparison with a generated numeral."""
    return Decimal(str(value))


def allowed_summary_numbers(facts: SoundSummaryFacts) -> set[Decimal]:
    """Return every numeral a summary may use from its supplied TrackMap facts."""
    # The MIDI pitch numbers are deliberately NOT allowed, although they are true. Offering them
    # made the first live summary read "entering at 1 between 36 and 71": every number correct and
    # the sentence unusable, because a screen that shows a musician raw MIDI integers is showing
    # them the inside of the program. The octave digits of the note names carry the same fact in
    # the form a player reads.
    allowed = {
        _decimal(facts["tempo_bpm"]),
        _decimal(facts["duration_seconds"]),
        _decimal(facts["entry_bar"]),
        _decimal(facts["note_count"]),
    }
    for note_name in (facts["low_note"], facts["high_note"]):
        octave = NUMBER_PATTERN.search(note_name)
        if octave is not None:
            allowed.add(Decimal(octave.group()))
    return allowed


def summary_numbers_are_allowed(summary: str, facts: SoundSummaryFacts) -> bool:
    """True only when every numeral and note spelling is present in supplied TrackMap facts."""
    if not summary.strip():
        return False
    allowed_numbers = allowed_summary_numbers(facts)
    for match in NUMBER_PATTERN.finditer(summary):
        try:
            number = Decimal(match.group())
        except InvalidOperation:
            return False
        if not number.is_finite() or number not in allowed_numbers:
            return False

    allowed_notes = {facts["low_note"], facts["high_note"]}
    return all(match.group(1) in allowed_notes for match in NOTE_NAME_PATTERN.finditer(summary))


def isolation_summary_prompt(facts: SoundSummaryFacts) -> str:
    """Ask Muse for a readable sentence whose factual material is completely bounded."""
    facts_json = json.dumps(facts, sort_keys=True)
    return (
        "Write exactly one short sentence a musician would want to read about this isolated sound, "
        'in the shape of this example: "A detuned supersaw lead in A minor, mostly eighth notes '
        'between A4 and E5, entering on bar 9." Write flowing prose, not a list of values. Name '
        'pitches by their note names and never as MIDI numbers. Say "bar" before a bar number. '
        "Use only the JSON facts below; they are the complete source of truth. If you use a digit, "
        "it must be one of the numbers shown in those facts. Do not infer or introduce a rhythm "
        "value, interval, bar, pitch, duration, count, tempo, or any other number. Use a note name "
        "only exactly as shown. Do not mention these instructions.\n\n"
        f"Facts:\n{facts_json}"
    )


def request_isolation_summary(facts: SoundSummaryFacts, api_key: str) -> str:
    """Request a bounded sound summary, retrying once when its numerals are not verifiable."""
    payload: dict[str, object] = {
        "model": LISTEN_MODEL,
        "max_output_tokens": MAX_OUTPUT_TOKENS,
        "input": [
            {
                "role": "user",
                "content": [{"type": "input_text", "text": isolation_summary_prompt(facts)}],
            }
        ],
    }
    for attempt in range(1, SUMMARY_ATTEMPTS + 1):
        summary = meta_api.output_text(meta_api.post_responses(payload, api_key)).strip()
        if "\n" not in summary and summary_numbers_are_allowed(summary, facts):
            return summary
        LOGGER.warning(
            "sound summary attempt %d/%d carried unsupported facts", attempt, SUMMARY_ATTEMPTS
        )
    raise RuntimeError(f"Muse Spark returned no safe summary after {SUMMARY_ATTEMPTS} attempts")


def write_isolation_summary(clip_id: str, isolation_id: str, cache_root: Path | None = None) -> str:
    """Write an optional per-isolation summary sidecar without mutating the base TrackMap."""
    root = cache_root if cache_root is not None else get_cache_root()
    facts = isolation_summary_facts(build_served_trackmap(clip_id, root), isolation_id)
    summary = request_isolation_summary(facts, meta_api.api_key())
    path = clip_dir(clip_id, root) / "isolations" / isolation_id / "summary.json"
    temporary_path = path.with_suffix(".json.tmp")
    temporary_path.write_text(json.dumps({"summary": summary}), encoding="utf-8")
    temporary_path.replace(path)
    LOGGER.info("wrote summary for clip=%s isolation=%s", clip_id, isolation_id)
    return summary


def suggest_clip(
    clip_id: str, cache_root: Path | None = None, model: str = LISTEN_MODEL
) -> ClipSuggestions:
    """Listen to a cached clip and write its chips to the clip's own sidecar."""
    root = cache_root if cache_root is not None else get_cache_root()
    directory = clip_dir(clip_id, root)
    wav_path = directory / "mix_mono.wav"
    if not wav_path.exists():
        raise FileNotFoundError(f"no mono mix for clip {clip_id}: {wav_path}")

    mp4_path = directory / "suggest_input.mp4"
    waveform_mp4(wav_path, mp4_path)
    api_key = meta_api.api_key()
    described = listen_to_clip(mp4_path, api_key, model)
    LOGGER.info("muse spark heard: %s", described[:200])
    result = structure_description(described, api_key, model)
    (directory / "suggest.json").write_text(json.dumps(result), encoding="utf-8")
    LOGGER.info("suggested %d sounds for clip=%s", len(result["suggestions"]), clip_id)
    return result


@app.function(
    image=web_image,
    volumes={CACHE_PATH: CACHE_VOLUME},
    secrets=[API_SECRET],
    timeout=SUGGEST_TIMEOUT_SECONDS,
    gpu=None,
)
def suggest_worker(clip_id: str, model: str = LISTEN_MODEL) -> ClipSuggestions:
    """Muse Spark is an HTTP call, so this needs no GPU and no model image."""
    logging.basicConfig(level=logging.INFO)
    CACHE_VOLUME.reload()
    try:
        return suggest_clip(clip_id, model=model)
    finally:
        CACHE_VOLUME.commit()
