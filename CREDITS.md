# Credits

All code in this repository was written during the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026).

## Licence

The code is under the [MIT License](LICENSE). That licence covers code only: not the demo media, the models
or the data listed here, each of which has its own terms below.

## Demo media

The demos on the home page are shortcuts: `apps/web/public/demos/<id>/` holds only the video and a
still of it, and clicking a demo uploads that video through the same Add flow as any clip, with its
sound already chosen. Each demo is labelled on screen as **Real recording** or **AI-generated**, and
the studio shows this credit beside it.

The landing page plays the audio of the piano and espresso steam demo and the piano Mixray separated
from it, both in `apps/web/public/landing/`.

| Demo (`id`) | Origin | Author | Source | Licence | Changes |
|---|---|---|---|---|---|
| Piano and espresso steam (`cafe-piano`) | AI-generated | Mehmet Yildiz, generated with Google Flow on a Google AI Pro plan | — | CC BY 4.0, to the extent any rights exist | Watermark "AI-generated video (Google Flow)" burned in; 720p |
| Song in the park (`park-song`) | AI-generated | Mehmet Yildiz, generated with Google Flow on a Google AI Pro plan | — | CC BY 4.0, to the extent any rights exist | Watermark burned in; 720p |
| Busker, dog and taxi (`busker-dog-taxi`) | AI-generated | Mehmet Yildiz, generated with Google Flow on a Google AI Pro plan | — | CC BY 4.0, to the extent any rights exist | Watermark burned in; 720p |
| Rooftop singer (`rooftop-singer`) | AI-generated | Mehmet Yildiz, generated with Google Flow on a Google AI Pro plan | — | CC BY 4.0, to the extent any rights exist | Watermark burned in; 720p |
| Piano on a rainy night (`rainy-piano`) | AI-generated | Mehmet Yildiz, generated with Google Flow on a Google AI Pro plan | — | CC BY 4.0, to the extent any rights exist | Watermark burned in; 720p |
| The Washington Post, funk version (`navy-band-funk`) | Real recording | United States Navy Band Cruisers; arranged by Musician 1st Class Trevor Shifflett; march by John Philip Sousa (1889) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Sousa_gone_Funk_(Washington_Post)_-_U.S._Navy_Band.webm) | Public domain: work of the U.S. federal government made as part of official duties; the march was published in 1889 | 30 s excerpt (1:20–1:50) of the 720p transcode, re-encoded |

The Navy Band video is used without any suggestion that the Navy endorses Mixray. Third-party media
is only used when it is public domain, CC0, CC BY or CC BY-SA, and only when the music performed in it
is free as well; NC and ND licences are not used.

### Why most demos are AI-generated

Openly licensed videos of people playing music are rare, and the licence almost never covers
everything in them. A Creative Commons licence on a video covers the footage: it says nothing about
the song being played, which is usually a cover, an unnamed piece or someone else's composition, and
often nothing from the musicians themselves. We checked candidates from Wikimedia Commons, Musopen,
the Free Music Archive and academic datasets; most failed on the composition, on a non-commercial or
no-derivatives licence, or on ShareAlike carrying over to our own demo video.

The generated videos are not under this repository's MIT licence. They are offered under CC BY 4.0, to the extent any
rights exist. Google's terms say it won't claim ownership of original content generated with its services, and its
generative AI policy asks that such content not be passed off as made solely by a human, which is why each one is
labelled and watermarked.

The organisers ruled on this on Discord on Oct 28: "For the clips, you must have the rights to every asset, so Veo clips
from your own prompts and Pexels stills used under its license are fine as long as you follow those licenses and credit
the sources in the README. AI elements are allowed, but the video should still show your working app." Google Flow uses Veo.

So the demos were generated: the scene and the music were written for Mixray in Google Flow, with
original chord progressions and no known songs, which leaves no third-party composition or
performance in them. Every one is labelled AI-generated on screen and carries a burned-in
watermark. They are test material, not evidence of accuracy on real recordings: the one real
recording is the public-domain U.S. Navy Band clip above, and anything uploaded by a user is real.

## Evaluation data

Used only to measure and tune the engine. No audio from it ships in this repository or in the app, and no
model was trained on it. The README's evaluation table reports the results.

| Data | Used for | Authors | Source | Licence |
|---|---|---|---|---|
| GuitarSet | Note decoding on guitar; whole-app test on 12 recordings | Q. Xi, R. Bittner, J. Pauwels, X. Ye, J. P. Bello, ISMIR 2018 | [Zenodo](https://zenodo.org/records/3371780) | CC BY 4.0 |
| AlbumDB | Comparing SAM Audio and Demucs; level gates | T. McKenzie, E. Moliner, A. Wright, AES 160th Convention, 2026 | [Zenodo](https://doi.org/10.5281/zenodo.19683001) | CC BY 4.0 |
| Mutopia Project scores | 20 solo piano pieces by Chopin, Joplin, Beethoven, Mozart, Debussy, Schumann and Grieg, rendered to audio for tuning piano note decoding; the list and each piece's licence are in `evaluation` | Mutopia Project contributors | [mutopiaproject.org](https://www.mutopiaproject.org) | Public domain |
| Salamander Grand Piano V3 | Rendering those pieces | Alexander Holm | [GitHub](https://github.com/sfzinstruments/SalamanderGrandPiano) | CC BY 3.0 |
| FluidR3 GM | Rendering the simple bass and drums under those pieces | Frank Wen | — | MIT |

## Models

| Model | Used for | Author | Licence |
|---|---|---|---|
| SAM Audio `large` ([paper](https://arxiv.org/abs/2512.18099)) | Prompted sound separation, self-hosted; weights are not in this repository | Meta | SAM License |
| Judge | Picks the best of eight draws | Meta | SAM License |
| PE-AV and PE-A-Frame | Inside SAM Audio and Judge; span prediction | Meta | Apache-2.0. Their package, `perception_models`, also holds PLM code under the FAIR Noncommercial Research License, which Mixray does not use |
| SAM 3.1 | Follows an instrument through the video, through the Meta Model API | Meta | Meta Model API terms |
| Muse Spark | Listens to the clip, suggests sounds, names an area, summarises, coaches, through the Meta Model API | Meta | Meta Model API terms |
| Muse Spark Open | Sound recipe, through Baseten. Built with Muse Spark Open | Meta | [Muse Model License](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B/blob/main/LICENSE.md); its $20M clause concerns companies hosting the model as a service |
| Muse Voice Transcribe | Hands-free practice commands, through the Meta Model API | Meta | Meta Model API terms |
| Demucs `htdemucs_6s` | Stem separation for standard instruments | Meta Research | MIT |
| Basic Pitch | Audio to notes | Spotify | Apache-2.0 |
| CLAP | Compared with Judge in the evaluation; installed in the SAM Audio image as a dependency, not called at runtime | LAION; fork `lematt1991/CLAP` | CC0-1.0 |
| ImageBind | Installed in the SAM Audio image as a dependency of `sam-audio`; never built or called, because the rankers are off | Meta | CC BY-NC-SA 4.0 |

## Libraries and tools

| Name | Used for | Licence |
|---|---|---|
| Next.js, React, Tailwind CSS, Ajv | Web app | MIT |
| Geist and Geist Mono | Typefaces | SIL OFL 1.1 |
| FastAPI | Engine API | MIT |
| Modal client | Engine runtime | Apache-2.0 |
| httpx, NumPy, soundfile | Engine | BSD |
| librosa | Tempo, chords and key | ISC |
| `meta-sam-parser` | SAM 3.1 response parsing | SAM License |
| DACVAE, Transformers, TensorFlow | Model runtimes | Apache-2.0 |
| PyTorch | Model runtime | BSD-style |
| FFmpeg | Decoding and encoding media, as a system package | LGPL or GPL, depending on the build |
| `mir_eval`, `pretty_midi` | Evaluation | MIT |
| FluidSynth | Rendering evaluation pieces | LGPL-2.1 |

## Services

Modal (engine and GPU), Baseten (Muse Spark Open) and Vercel (web hosting).
