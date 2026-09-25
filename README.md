# circle.io (made by Emmett)

A tiny multiplayer .io game. Type a name, pick a color, and move around the arena with WASD while you see everyone else who's playing.

## Run it on your own computer

1. Install Node.js (version 18 or newer) from https://nodejs.org
2. Open a terminal in this folder and run:

```
npm install
npm start
```

3. Open http://localhost:3000 in your browser. Open a second tab to see two players at once.

## Put it online for free (Render)

1. Make a free GitHub account and create a new repository called `circle-io`.
2. Upload everything in this folder to it (on the repo page: "Add file" > "Upload files", drag the files and the `public` folder in, then "Commit changes").
3. Make a free account at https://render.com and sign in with GitHub.
4. Click "New" > "Web Service" and pick your `circle-io` repo.
5. Use these settings:
   - Language: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free
6. Click "Deploy". After a couple of minutes you'll get a link like `https://circle-io-xxxx.onrender.com`. Send that to your friends.

Free Render servers go to sleep after 15 minutes with nobody playing. The first person to open the link after that waits about a minute while it wakes up.

## Making changes

Edit the files, upload them to GitHub again, and Render automatically redeploys.

- `server.js` runs the game: player positions, movement speed, arena size.
- `public/index.html` is what players see: the menu, drawing, and controls.

If you change `PLAYER_SPEED` or `WORLD_SIZE`, change it in both files.
