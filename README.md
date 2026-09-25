# Even or Odd — two-player Teams meeting game

Classic odds-and-evens, live in a Teams meeting:

1. One player takes **Even**, the other **Odd** (everyone else can watch).
2. Both secretly type any positive number and click **Lock in**.
3. When both are in, the numbers are revealed. The **sum** decides the winner:
   even sum → Even wins, odd sum → Odd wins.
4. The winner gets a badge, the loser a consolation badge. **Play again** or **Swap sides**.

State is synced with the [Live Share SDK](https://aka.ms/livesharedocs) (Fluid
Framework), so there's no game server to run — Teams provides the relay inside meetings.

```
src/main.ts       startup: Teams, local test, or public landing page
src/game.ts       pure rules, types and validation of remote data
src/fairplay.ts   commit–reveal hashing (Web Crypto SHA-256)
src/store.ts      shared state, auto-reveal, verification, presence
src/session.ts    the only module that knows which sync service is used
src/views.ts      rendering
src/teams.ts      Teams SDK: context, theme, config page, meeting stage
src/identity.ts   Teams name, profile photo, avatars
src/badges.ts     badge art, titles and messages
appPackage/       Teams manifest + icons
```

### Fair play

Picks use **commit–reveal**. Locking in publishes only
`SHA-256("even-odd:v1:<round>:<side>:<number>:<128-bit salt>")`. Once both
players have committed, each client reveals its number and salt, and every
client verifies the reveal against the commitment. So nobody can see the
other's number early (not even in dev tools), and nobody can change theirs
after seeing the opponent's.

- A reveal that doesn't match its commitment **forfeits** the round.
- Not revealing within 15 s of both commitments (e.g. closing the tab to dodge
  a loss) **forfeits** the round. If neither side reveals, the round is void.
- Players who leave are detected via Live Share presence; their side can be
  taken over, which starts a fresh round.

### Quality gates

`npm run check` = type check (strict TypeScript) + ESLint (type-aware) + tests.
CI runs it before every deploy. Dependabot keeps dependencies current; majors of
Live Share / Fluid are excluded because they must be migrated together.

## Play it locally (two browser tabs)

```bash
npm install
npm run sync-server      # terminal 1 — local Fluid relay on :7070
npm run dev              # terminal 2 — app on http://localhost:5173
```

Open http://localhost:5173 — the URL gets a `#<game-id>`. Open **that exact URL**
in a second tab; each tab is a separate player.

`npm test` runs the rule tests.

## Hosting

Every push to `main` runs the tests, builds, and deploys to GitHub Pages
(`.github/workflows/pages.yml`):

**https://jureperak.github.io/parity-duel/**

The manifest in `appPackage/` already points there.

## Put it in Teams

1. `npm run package` → `even-odd.zip`.
2. Teams → **Apps → Manage your apps → Upload an app**, then either
   **Upload a custom app** (just you) or **Submit an app to your org** (admin approves it
   for the company catalog). If neither option is there, your Teams admin must allow custom apps.
3. In a meeting (or scheduled meeting chat) click **+ Apps**, add **Even or Odd**,
   open it in the side panel, and use **Show on meeting stage** so everyone sees it.

## Player names and photos

- **In Teams**, each player's **Teams display name** is used automatically (via Live
  Share presence) — no nickname box. Locally you type a nickname instead.
- Every player gets a Teams-style **initials avatar**; the winner's avatar is shown big
  on the result with the medal pinned to it.
- **Real profile photos (optional)** — each player's app fetches *their own* 48×48
  photo from Microsoft Graph (`/me/photos/48x48`) and shares that thumbnail with
  the game. This needs a one-time Entra ID app registration (ask IT):
  1. Entra ID → App registrations → **New registration**, single tenant.
  2. **Authentication → Add a platform → Single-page application**, redirect URI
     `brk-multihub://jureperak.github.io` (Teams nested app auth).
  3. API permissions: Microsoft Graph → delegated **User.Read** (the default).
  4. Copy the Application (client) ID into a repository variable named
     `VITE_ENTRA_CLIENT_ID` (Settings → Secrets and variables → Actions → Variables) and
     re-run the deploy. Locally, put it in `.env` (see `.env.example`).

  Without it, or if a user has no photo or declines consent, the initials avatar is used.

## Known limits

- Picks are hidden in the UI until both are locked in, but they travel through the
  shared session, so someone digging in browser dev tools could peek. Fine for fun,
  not for betting lunch money.
- Names and photos are visible only to people in the meeting, and live only as
  long as the meeting's Live Share session.
