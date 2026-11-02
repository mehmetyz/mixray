# Credits

All code in this repository was written during the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026).

## Demo media

The demos on the home page are shortcuts: `apps/web/public/demos/<id>/` holds only the video and a
still of it, and clicking a demo uploads that video through the same Add flow as any clip, with its
sound already chosen. Each demo is labelled on screen as **Real recording** or **AI-generated**, and
the studio shows this credit beside it.

| Demo (`id`) | Origin | Author | Source | Licence | Changes |
|---|---|---|---|---|---|
| Piano and espresso steam (`cafe-piano`) | AI-generated | Mixray team, generated with Google Flow | — | Made for Mixray | Watermark "AI-generated video (Google Flow)" burned in; 720p |
| Song in the park (`park-song`) | AI-generated | Mixray team, generated with Google Flow | — | Made for Mixray | Watermark burned in; 720p |
| Busker, dog and taxi (`busker-dog-taxi`) | AI-generated | Mixray team, generated with Google Flow | — | Made for Mixray | Watermark burned in; 720p |
| Rooftop singer (`rooftop-singer`) | AI-generated | Mixray team, generated with Google Flow | — | Made for Mixray | Watermark burned in; 720p |
| Piano on a rainy night (`rainy-piano`) | AI-generated | Mixray team, generated with Google Flow | — | Made for Mixray | Watermark burned in; 720p |
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

So the demos were generated: the scene and the music were written for Mixray in Google Flow, with
original chord progressions and no known songs, which leaves no third-party composition or
performance in them. Every one is labelled AI-generated on screen and carries a burned-in
watermark. They are test material, not evidence of accuracy on real recordings: the one real
recording is the public-domain U.S. Navy Band clip above, and anything uploaded by a user is real.

## Models

- **SAM Audio** (Meta, open weights) — prompted sound separation
- **SAM 3.1** (Meta Model API) — video segmentation and tracking
- **Muse Spark** (Meta Model API) — listens to the clip, suggests sounds, coaches
- **Muse Spark Open** (Meta, open weights, via Baseten) — sound recipe
- **Muse Voice Transcribe** (Meta Model API) — hands-free practice commands
- **Demucs** (MIT) — fallback stem separation for standard instruments
- **Basic Pitch** (Spotify, Apache-2.0) — audio to MIDI transcription
