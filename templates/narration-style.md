# Narration style

Rules for the `text` (caption form) and `spoken` (what the voice reads) fields in `beats.json`. Product-agnostic; the
worked examples use a fictional data-import product called Example.

## Voice and tone

- Peer to peer. A practitioner explaining a tool to another practitioner, not a brand talking to "users". No hype words
  ("revolutionary", "seamless", "powerful"), no exclamation marks, no rhetorical questions.
- Second person, present tense, active voice: "You upload the export. It pulls the fields out."
- One idea per sentence. Say what is on screen at the moment it is on screen; the cursor should be on the thing being named.
- Describe what the product *does*, never what it *guarantees*. "Helps you prepare", "drafts", "flags" — not "prepares your
  filing", "ensures", "makes sure it is correct". The user remains responsible for the result.
- Never claim data is real. Say it is fictional in the first beat that shows data: "a fictional sample order. No real
  customer data, and nothing is saved."
- No credentials or professional claims in a synthetic-voice video (see the regulated-industry note below).
- 80-160 words per minute of video is comfortable. A beat of 10-25 s of narration is typical; over 30 s, split the beat.

## Humanization (what makes synthetic narration sound like a person)

- Split long sentences where a breath belongs. Commas for short pauses; an ellipsis `…` for a beat of thought. `tts.mjs` turns
  `…` into `...`, which the voice reads as a pause.
- Prefer contractions in speech ("that's", "didn't", "you'll"); keep the written/caption form formal if you like and add a
  `spokenMap` entry for the contraction so captions and audio stay in sync.
- Put the important word at the end of the sentence: "…before it ever reached a record you would keep."
- Avoid stacked nouns and abbreviations the voice cannot read. Test every beat with `--dry-run` and listen to the first render.
- Give the voice context: with the ElevenLabs engine `tts.mjs` sends the previous and next beat as `previous_text` /
  `next_text`, so consecutive beats keep the same delivery. Re-render neighbours together when you rewrite one.
- The free `say` engine ignores prosody context and reads more flatly. Draft with it, then re-render the final pass with
  ElevenLabs if the video is going to be published.

## Number and name reading

Write the caption form in `text`; map it to the spoken form with `spokenMap` (regex → replacement) in the config:

| Written (captions) | Spoken (audio) |
|---|---|
| API | A P I |
| SKU-4120 | S K U four one two zero |
| v2.1 | version two point one |
| 412 Example Road | four twelve Example Road |
| §12-a | section twelve A |
| example.com/demo | example dot com slash demo (automatic when `voice.humanizeUrls` is on) |
| CSV | C S V (reads fine as letters); spell out if the voice stumbles |
| ITEM (all caps in a data field) | Item — all caps can be read letter by letter |
| $850,000 | eight hundred fifty thousand dollars |
| 2026 | twenty twenty-six |
| Cmd+Shift+5 | command shift five |

Dollar amounts, years, version numbers, form/SKU numbers and street numbers are the usual offenders. Anything that must be
read exactly gets a `spokenMap` entry; a one-off can be set directly in the beat's `spoken` field.

## Structure of a walkthrough

1. **Hook** (8-12 s): the problem in one sentence, the product in one sentence. Screen: landing page.
2. **Orientation** (10-15 s): what the demo is, that the data is fictional and nothing is saved.
3. **Proof point** (20-30 s): the one thing the product does that a screenshot cannot show. Zoom in. Slow down.
4. **The rest of the flow** (1-3 beats): each step of the workflow, one sentence per field or card the cursor touches.
5. **Close** (10-14 s): the limitation, the responsibility line, the URL, "no signup needed". Show a closing card.

## The close

> This is a product demonstration with sample data. You are still the one who reviews every record.
> Try it yourself at example.com/demo. No signup needed.

Keep the limitation **spoken** (not only captioned) and **shown** on the closing card. Substitute whatever your product
needs: "not legal advice", "not tax advice", "not medical advice", "results shown are from sample data".

## Regulated industries

If your product serves a regulated profession, the video may itself be regulated advertising. This is not legal advice —
check your own jurisdiction and rules — but the mechanics that usually apply:

- A synthetic narrator describing a product, with fictional data and no professional credentials spoken, is ordinary
  product marketing.
- If a licensed professional appears or speaks about their own practice to promote the product, it is likely professional
  advertising: label it as such in the video description and on any page that carries it, and retain the final video,
  script and metadata for your jurisdiction's retention window. Keep a copy outside the hosting platform.
- Testimonials, "prior results" and comparative claims need their own disclaimers and written consent. Leave them out of a
  walkthrough.
- Never show a real client, customer, matter, patient, address or document. Build the demo data set first; make the names
  obviously fictional (`example.com` and the `555-01xx` phone range are reserved for exactly this).

*Worked example — US attorney advertising:* under New York's rule (22 NYCRR 1200.7.1) an attorney promoting their own
practice must add an "Attorney Advertising" label and retain the material (generally three years; one year for
computer-accessed communications). Other professions and jurisdictions have their own equivalents.
