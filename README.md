# Rummy 500 for Two ❤️

A private 2-player online Rummy 500 game built with Node.js, Express, and Socket.IO.

## What is included

- Room creation with 6-character code and shareable URL
- Two-player real-time multiplayer
- Server-owned deck and hands
- Private hands
- Draw deck / take from any point in discard pile
- Click-to-select cards
- Sets and same-suit runs
- Add cards to existing melds
- Server-side move validation
- Automatic scoring
- First player to 500 wins
- Rematch
- Disconnect/reconnect status
- Responsive phone layout
- Cute minimal pink/felt theme

## Run it on your computer

1. Install Node.js 20+.
2. Open a terminal in this folder.
3. Run:
   npm install
4. Start it:
   npm start
5. Open:
   http://localhost:3000

## Put it online

For the easiest public deployment, use a Node-capable host that supports persistent WebSockets. Vercel now supports WebSockets on Functions, but multi-instance state needs shared storage such as Redis. For a tiny two-person game, a single persistent Node service is simpler.

Deploy this folder to a host that runs `npm start`, then send your girlfriend:

https://YOUR-DOMAIN/?room=ROOMCODE

## Important rules note

This implementation uses a deliberately simple standard variant:
- 13 cards each
- 52-card deck
- no jokers
- sets require 3+ cards of the same rank
- runs require 3+ consecutive cards of one suit
- A can be low or high
- you may take the discard pile from any card onward
- server validates melds and turn order
- round scoring is based on cards successfully melded by the player, with the opponent's remaining hand subtracted when a player goes out

Rummy 500 has house-rule variations. Adjust the rules in server.js if you want a different scoring or discard-pile rule.

## Security

The server is authoritative for the game state. Do not move deck generation or hidden hands into the browser if you later add accounts, spectators, or persistence.
