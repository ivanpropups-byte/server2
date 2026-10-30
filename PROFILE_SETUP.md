# Bubble profiles and matchmaking

The server keeps a player's nickname, 96×96 avatar, Bubble points, and played-game count under the stable guest profile ID sent by the Godot client. A server-issued token protects that profile from edits by another client.

## Bubble points

- New profiles start at 1,000 Bubble points.
- A win adds 25 points; a loss removes 15 points; a draw leaves points unchanged.
- Matchmaking first prefers an opponent with equal or higher Bubble points.
- The allowed difference starts at 150 points and grows by 200 every five seconds, up to 2,000. If no equal or higher opponent is available, the server can match with the strongest lower-rated player in range.
- The leaderboard shows the top 50 profiles and includes the current player's own rank if they are outside the top 50.

## Render persistence

The server supports PostgreSQL through the `DATABASE_URL` environment variable and creates the profile table automatically. Add a Render Postgres database and set the web service's `DATABASE_URL` to its internal connection string. Do not commit database credentials.

Without `DATABASE_URL`, profiles work in memory for local preview, but Bubble points and profile tokens reset whenever the server restarts. Render's free Postgres databases expire after 30 days, so choose a storage plan that matches how long the game needs to keep player profiles.

Profiles are guest profiles stored on the current installation. Clearing the game's saved data removes the local profile token; there is no account recovery or cross-device sign-in yet.
