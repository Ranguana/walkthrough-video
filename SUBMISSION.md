# Publishing and listing this skill

Research current as of **September 2026**. Everything below was verified by fetching the pages listed; where something
could not be confirmed it says so.

## The short version

There is **no** Anthropic-run directory that accepts *skill* submissions. There **is** an Anthropic-run **plugin**
directory that accepts third-party submissions, and a skill is published to it by wrapping it in a plugin — which this
repo already is. So:

| Step | What it gets you | Effort |
|---|---|---|
| 1. Push to a public GitHub repo | installable by anyone; auto-indexed by skills.sh | minutes |
| 2. Submit to Anthropic's `claude-community` marketplace | listed in the official community plugin directory | one form |
| 3. PR into a community index or two | discoverability | one PR each |

## Suggested repo name and description

**Repo name:** `walkthrough-video`

Short and matches the skill's `name`, which must equal the directory name when the skill is installed — so a clone into
`~/.claude/skills/` works with no rename. (`claude-skill-walkthrough-video` is the alternative if you want the repo to
self-describe in a list of your projects, but then everyone who clones must rename the folder. Prefer the plain name.)

**GitHub description (one paragraph):**

> A Claude Code Agent Skill that records narrated product walkthrough videos of a website, web app, or Electron desktop
> app — no screen recorder, no editor. You describe the video as a list of beats (a screen, what the cursor does, one
> sentence of narration); the skill renders the voice-over, drives the app with Playwright while recording it, lines the
> speech up 0.5 s behind each beat's first frame, freezes frames rather than speeding audio when a line outgrows its
> beat, burns captions, cuts a thumbnail, and runs a QA pass that proves the timing. Narration uses ElevenLabs when a key
> is present and the free macOS `say` voice when it is not.

Suggested topics: `claude-code`, `claude-skill`, `agent-skills`, `playwright`, `ffmpeg`, `screencast`, `demo-video`,
`electron`.

## Step 1 — publish the repo

```bash
cd ~/Documents/claude-skills/walkthrough-video
# the first commit is already made locally; add your remote:
gh repo create walkthrough-video --public --source=. --remote=origin \
  --description "A Claude Code Agent Skill that records narrated product walkthrough videos of a website, web app, or Electron desktop app."
git push -u origin main
```

Before pushing, replace the `OWNER` placeholders:

- `package.json` → `repository.url`, `homepage`, `bugs`
- `.claude-plugin/plugin.json` → `homepage`, `repository`
- `.claude-plugin/marketplace.json` → `plugins[0].homepage`
- `README.md` → the two `https://github.com/Ranguana/...` clone URLs

```bash
grep -rn "OWNER" --exclude-dir=node_modules .
```

Once it is public it is immediately usable three ways:

```bash
git clone https://github.com/Ranguana/walkthrough-video ~/.claude/skills/walkthrough-video   # plain skill install
npx skills add Ranguana/walkthrough-video                                                     # skills.sh CLI
/plugin marketplace add Ranguana/walkthrough-video                                            # as a plugin marketplace
```

**skills.sh** (https://skills.sh, run by Vercel, CLI at https://github.com/vercel-labs/skills) has **no submission form
and no PR** — it discovers skills by scanning public GitHub repos for `SKILL.md` via the GitHub Trees API and reading
their frontmatter. Publishing the repo is the entire listing process. *Unverified:* what governs appearing on its
leaderboard as opposed to merely being installable.

## Step 2 — Anthropic's community plugin marketplace (the official path)

Two Anthropic-run marketplaces exist:

| Marketplace | Repo | Submissions |
|---|---|---|
| `claude-plugins-official` | https://github.com/anthropics/claude-plugins-official | Curated by Anthropic. The docs state plainly that there is **no application process** and that the submission form does not add plugins here. |
| `claude-community` | https://github.com/anthropics/claude-plugins-community | **Open to third-party submissions after review.** ~2,280 plugins listed. |

**Submit at https://platform.claude.com/plugins/submit** (the shortlink is https://clau.de/plugin-directory-submission).
The docs section is https://code.claude.com/docs/en/plugins#submit-your-plugin-to-the-community-marketplace. There is a
second form at `https://claude.ai/admin-settings/directory/submissions/plugins/new`, but it requires a Team/Enterprise org
with directory-management access — individual authors use the platform.claude.com form.

**Do not open a PR against `anthropics/claude-plugins-community`.** Its README says it is a read-only mirror and that PRs
opened against it are closed automatically; everything flows through the internal review pipeline. Approved entries are
pinned to a commit SHA and the public catalog **syncs nightly**, so expect a lag between approval and installability.

### Before submitting

```bash
claude plugin validate .          # the review pipeline runs the same check
claude plugin validate --strict . # warnings become errors
```

This repo currently passes. Then check it against the published review criteria — the actual LLM reviewer prompt is public
at `anthropics/claude-plugins-official/.github/policy/prompt.md`, and the governing policy is the
[Anthropic Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy).
The automatic failures that matter here:

| Auto-fail | This skill |
|---|---|
| Broad-scope hooks (any ungated `UserPromptSubmit` / `PreToolUse` / `PostToolUse`) | ✅ ships **no hooks at all** |
| Undisclosed telemetry — any outbound call to a host not declared in the README, without a documented opt-out | ✅ the only network calls are (a) `api.elevenlabs.io`, only when the user sets their own key, and (b) the page being recorded. Both are documented in the README. No analytics, no phone-home. |
| Description / behaviour mismatch | ✅ the description matches what the scripts do |
| Malicious or deceptive behaviour, data exfiltration | ✅ credentials are read via dotenv and never logged, printed, or transmitted anywhere except to ElevenLabs as the user's own API call |

The reviewer clones and inspects the **entire** repo, including `.claude/`, `scripts/`, hidden directories and tests — so
keep it clean of anything project-specific.

The directory policy also requires, for submitted software: a privacy policy link, a verified contact/support channel,
**at least three working example prompts or use cases**, and a test account with sample data where applicable. For a
local-only skill like this one, be ready to supply:

- *Support channel:* GitHub Issues on the repo (set `bugs` in `package.json` — already done).
- *Privacy statement:* one paragraph in the README is usually enough — this skill stores nothing, sends nothing, and the
  only third-party call is the user's own ElevenLabs key. Consider adding a short `PRIVACY.md` if the form demands a URL.
- *Three example prompts:*
  1. "use the walkthrough-video skill to record a 90-second walkthrough of our landing page and demo flow"
  2. "record a 3-minute signed-in walkthrough of the onboarding flow with a throwaway account, then clean it up"
  3. "record a 60-second tour of our Electron desktop app and burn in captions"
- *Sample data:* `examples/beats.minimal.json` runs against `example.com` with the free `say` voice and needs no account
  or key at all — point the reviewer at it.

### Plugin layout in this repo (already in place)

```
walkthrough-video/                 <- repo root = plugin root = skill folder
  .claude-plugin/
    plugin.json                    plugin metadata (only "name" is strictly required)
    marketplace.json               makes the repo itself installable as a marketplace
  SKILL.md                         single-skill plugin: SKILL.md at the plugin root
  scripts/, templates/, examples/
```

This is the **single-skill plugin** layout, where the skill lives at the plugin root; the frontmatter `name` is required
in that case (it is present). Never put `skills/`, `commands/`, `agents/` or `hooks/` *inside* `.claude-plugin/` — only
`plugin.json` and `marketplace.json` go there.

If you later add a second skill, restructure to the multi-skill layout instead:

```
  .claude-plugin/plugin.json
  skills/walkthrough-video/SKILL.md
  skills/<second-skill>/SKILL.md
```

### Note on SKILL.md frontmatter

The frontmatter deliberately uses **only** the portable Agent Skills spec fields — `name`, `description`, `license`,
`metadata` (https://agentskills.io/specification). Claude Code supports a larger superset (`when_to_use`,
`disable-model-invocation`, `model`, `context`, `hooks`, …), but any non-spec key is a **hard error** on claude.ai upload,
the Skills API, and `package_skill.py`:

> `Unexpected key(s) in SKILL.md frontmatter: … Allowed properties are: allowed-tools, compatibility, description, license, metadata, name`

`allowed-tools` is allowed by the spec but is marked experimental, and this skill legitimately needs Bash, Read, Write and
Edit, so it is omitted (omitting it means no restriction). Keep `description` under 1024 characters — it is currently 278.

## Step 3 — community indexes

Optional, ordered by how little friction they involve:

**`ccplugins/awesome-claude-code-plugins`** — https://github.com/ccplugins/awesome-claude-code-plugins (Apache-2.0, site
https://claudecodeplugins.dev). A real installable marketplace; submit a PR editing
`.claude-plugin/marketplace.json` directly. Entry shape: `name`, `source`, `description`, `version`, `author`,
`category`, `homepage`, `keywords` — the same fields already in this repo's `marketplace.json`. Lowest-friction real
marketplace listing found.

**`travisvn/awesome-claude-skills`** — https://github.com/travisvn/awesome-claude-skills. Fork and PR, one line:
`- **[walkthrough-video](url)** - Records narrated product walkthrough videos of a website, web app, or Electron app.`
Has a "social proof" requirement, and bans SaaS wrappers and anything requiring a paid platform (this skill qualifies:
it works fully with no key).

**`hesreallyhim/awesome-claude-code`** — https://github.com/hesreallyhim/awesome-claude-code. The canonical awesome list,
but it gates on age or traction: the resource must be **≥14 days old with continued commits, or have ≥100 stars**. Submit
**only** via the web issue form
(https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml) — PRs and `gh` CLI
submissions are explicitly not accepted. One resource per submission, a machine-detectable LICENSE file is required
(present), and the blurb must be one descriptive, non-promotional line with no emoji. **So: wait ~2 weeks after pushing,
then file this.**

**`wshobson/agents`** — https://github.com/wshobson/agents (marketplace `claude-code-workflows`). PR process:
`plugins/<name>/.claude-plugin/plugin.json`, skills in `skills/`, add the entry to `.claude-plugin/marketplace.json`,
then `make generate-all && make validate && make garden`. Strict commercial rules (no funnels to paid products, no
metered API on the default path) — all fine here.

**`ComposioHQ/awesome-claude-skills`** — https://github.com/ComposioHQ/awesome-claude-skills. Hosts skill folders in-repo
and prescribes its own SKILL.md section template (`## When to Use This Skill`, `## What This Skill Does`, `## How to
Use`, `## Example`, `**Inspired by:**`). Only worth it if you are willing to keep a second, restructured copy.

### Repos that explicitly do **not** accept skills

- `anthropics/skills` (https://github.com/anthropics/skills) — no `CONTRIBUTING.md`; its own skills are stated to be "for
  demonstration and educational purposes only". Partner skills are occasionally highlighted at Anthropic's discretion,
  with no submission path.
- `agentskills/agentskills` (https://github.com/agentskills/agentskills) — the spec repo. `CONTRIBUTING.md`: *"Skill
  submissions — We don't maintain a directory of community skills. This may change in the future."* It does accept
  client/logo listings and docs fixes, and requires AI-assistance disclosure in every PR.
- `anthropics/claude-code` — issues and `/bug` only; its marketplace is a demo.

## Draft submission text

### For the platform.claude.com plugin submission form

> **Name:** walkthrough-video
>
> **Repository:** https://github.com/Ranguana/walkthrough-video
>
> **What it does:** Records a narrated product walkthrough video of a website, web app, or Electron desktop app, entirely
> from the command line — no screen recorder and no video editor. The author describes the video as a list of "beats" (a
> screen, what the cursor does, one sentence of narration) in two JSON files. The skill renders the voice-over per beat,
> drives the app with Playwright while recording it, places each clip 0.5 s after its beat's first frame, freezes the
> last frame of any beat whose narration outgrew it rather than speeding the audio up, burns captions, cuts a thumbnail,
> and runs a QA pass that verifies speech onset, track lengths and per-beat slack. Rewriting a line of narration
> therefore never requires re-recording.
>
> **Requirements:** Node 22+, ffmpeg/ffprobe, Playwright Chromium. Narration works with no credentials at all via the
> macOS `say` voice; `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` switch to ElevenLabs for a publishable voice.
>
> **Network access:** Two outbound destinations, both documented in the README: the page or app being recorded, and
> `api.elevenlabs.io` — the latter only when the user has supplied their own ElevenLabs API key. No telemetry, no
> analytics, no phone-home. Credentials are read with dotenv from the process environment, the project's env file, or
> `~/.config/walkthrough-video/.env`, and are never logged or written to any output.
>
> **Hooks:** none.
>
> **Example prompts:**
> 1. "use the walkthrough-video skill to record a 90-second walkthrough of our landing page and demo flow"
> 2. "record a 3-minute signed-in walkthrough of the onboarding flow with a throwaway account, then clean it up"
> 3. "record a 60-second tour of our Electron desktop app and burn in captions"
>
> **Trying it with no account or key:** `examples/beats.minimal.json` records two public pages
> (example.com and iana.org) with the free macOS voice and produces a ~12-second captioned mp4. `examples/README.md` has
> the four commands and the expected output.
>
> **License:** MIT. **Support:** GitHub Issues on the repository.

### For the `hesreallyhim/awesome-claude-code` issue form (file after ~2 weeks)

> **Resource name:** walkthrough-video
> **Category:** Skills
> **Link:** https://github.com/Ranguana/walkthrough-video
> **License:** MIT
> **Description:** Records a narrated product walkthrough video of a website, web app, or Electron desktop app from a
> beats file, using Playwright, a text-to-speech voice and ffmpeg.

### For a `ccplugins/awesome-claude-code-plugins` PR

Add to `.claude-plugin/marketplace.json` under `plugins`:

```json
{
  "name": "walkthrough-video",
  "source": { "source": "github", "repo": "Ranguana/walkthrough-video" },
  "description": "Record a narrated product walkthrough video of a website, web app, or Electron desktop app: scripted Playwright recording, per-beat voice-over, burned-in captions, thumbnail, and a QA pass.",
  "version": "0.1.0",
  "author": { "name": "Jessica Wilson" },
  "category": "productivity",
  "homepage": "https://github.com/Ranguana/walkthrough-video",
  "keywords": ["walkthrough", "screencast", "demo-video", "playwright", "ffmpeg", "electron"]
}
```

PR title: `Add walkthrough-video plugin`. Body: the one-paragraph description above plus a note that it ships no hooks
and makes no network calls beyond the recorded page and the user's own ElevenLabs key.

## Pre-publication checklist

- [x] No project-specific names, domains, sample data, voice ids or absolute home paths anywhere in the repo
- [x] No credentials; `.env*` git-ignored; scripts never print env values
- [x] `SKILL.md` frontmatter uses spec fields only; `name` matches the directory name
- [x] LICENSE present (MIT) and `license` declared in `SKILL.md`, `package.json`, `plugin.json`
- [x] `claude plugin validate .` passes
- [x] Pipeline self-tested end to end on the no-key path
- [x] No committed media; `examples/` documents expected output instead
- [x] Repository owner set to `Ranguana`
- [ ] Repo pushed public
- [ ] Plugin submitted at https://platform.claude.com/plugins/submit
