# Grid Duel · Solaris vs Noctis

A tactical duel on a 5×4 grid. Play the computer, play on one screen, or send a friend a private link.

## Run it on your computer

Needs Node.js 18 or newer.

```bash
npm install
npm run build
npm start
```

Open http://localhost:3000. To test a private match on one computer, click **Play a Friend**, copy the link, and open it in a private/incognito window.

## Put it online (Render)

1. Push this folder to a GitHub repo.
2. On https://render.com, choose **New → Web Service** and pick the repo.
3. Use these settings:
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`
4. Click **Create Web Service**. When it's live, open the address Render gives you and click **Play a Friend**.

Railway and Fly.io work the same way: any host that runs `npm start` and supports WebSockets will do. The server reads the port from the `PORT` environment variable.

Two things to know about hosting:
- Matches live in the server's memory. A restart or redeploy ends any matches in progress.
- Free plans usually put the server to sleep when nobody is using it, so the first visit after a quiet spell can take a little while to load.

## How it fits together

```
shared/engine.js   the rules and the AI. Used by both the server and the browser.
server/index.js    serves the game and runs private matches over WebSockets.
client/            the game UI (React), bundled into dist/ by build.js.
```

The server is the referee. It keeps the only real copy of each match, checks every move against the shared engine, ignores anything illegal, and runs the Eclipse Mode clock. A browser only shows the match and sends moves, so a player can't cheat by editing the page.

### Private matches
- **Play a Friend** creates a match with a 6-letter code and a link. The creator gets a random side.
- Whoever opens the link first takes the other seat. Anyone after that is told the match is full.
- Reloading or briefly losing connection puts you back in your seat (the browser remembers it).
- A player who stays disconnected for 90 seconds loses. Leaving mid-match also counts as a loss.
- Rematch needs both players to agree, and sides swap each game so the first move alternates.
- Eclipse Mode is set by whoever creates the match.

### Tuning
- Clock: `ECLIPSE_SECONDS`, `ECLIPSE_MIN` and `ECLIPSE_SHRINK` in `shared/engine.js`.
- Disconnect allowance, grace time and room clean-up: constants at the top of `server/index.js`.
- `GET /health` reports the number of open matches.
