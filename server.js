
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import crypto from "crypto";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
app.use(express.static("public"));

const rooms = new Map();
const sockets = new Map();

const SUITS = ["♣","♦","♥","♠"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const rankValue = r => r==="A"?1:["J","Q","K"].includes(r)?10:Number(r);
const cardId = c => `${c.rank}${c.suit}`;

function freshDeck() {
  const d=[];
  for (const s of SUITS) for (const r of RANKS) d.push({rank:r,suit:s});
  for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}
  return d;
}
function newRoom(code) {
  const deck=freshDeck(), hands=[[],[]];
  for(let i=0;i<13;i++){hands[0].push(deck.pop());hands[1].push(deck.pop());}
  return {code, players:[null,null], hands, deck, discard:[deck.pop()], melds:[], scores:[0,0], turn:0, phase:"playing", lastAction:"Game started", winner:null};
}
function publicState(room, socketId) {
  const p=sockets.get(socketId);
  const me=p?.room===room.code ? p.seat : -1;
  return {
    code:room.code, players:room.players.map(x=>x?{name:x.name,connected:x.connected}:null),
    hand:me>=0?room.hands[me]:[],
    handCount:room.hands.map(h=>h.length),
    deckCount:room.deck.length, discard:room.discard, melds:room.melds,
    scores:room.scores, turn:room.turn, phase:room.phase, winner:room.winner,
    lastAction:room.lastAction
  };
}
function broadcast(room) {
  for (let i=0;i<room.players.length;i++) {
    const pl=room.players[i];
    if(pl?.socketId) io.to(pl.socketId).emit("state",publicState(room,pl.socketId));
  }
}
function playerFor(socketId){return sockets.get(socketId)}
function fail(socket, msg){socket.emit("errorMessage",msg)}

function ids(cards){return cards.map(cardId)}
function sameSuit(cards){return cards.every(c=>c.suit===cards[0].suit)}
function consecutive(cards){
  const vals=cards.map(c=>rankValue(c.rank));
  const normal=[...vals].sort((a,b)=>a-b);
  if(new Set(normal).size!==cards.length) return false;
  if(normal.every((v,i)=>i===0||v===normal[i-1]+1)) return true;
  if(normal.includes(1) && normal.includes(10) && normal.includes(11) && normal.includes(12) && normal.includes(13)) return true;
  return false;
}
function validMeld(cards){
  if(cards.length<3) return false;
  const ranks=new Set(cards.map(c=>c.rank));
  const suits=new Set(cards.map(c=>c.suit));
  if(ranks.size===1 && suits.size===cards.length) return true;
  return suits.size===1 && consecutive(cards);
}
function scoreCard(c){ return rankValue(c.rank) }

io.on("connection", socket=>{
  sockets.set(socket.id,{socket});
  socket.on("createRoom", ({name})=>{
    let code;
    do code=crypto.randomBytes(3).toString("hex").toUpperCase(); while(rooms.has(code));
    const room=newRoom(code); room.players[0]={name:(name||"Player 1").slice(0,24),socketId:socket.id,connected:true};
    rooms.set(code,room); sockets.get(socket.id).room=code; sockets.get(socket.id).seat=0; socket.join(code);
    socket.emit("roomCreated",{code}); broadcast(room);
  });
  socket.on("joinRoom", ({code,name})=>{
    code=(code||"").trim().toUpperCase(); const room=rooms.get(code);
    if(!room)return fail(socket,"Room not found.");
    const seat=room.players[0]? (room.players[1]? -1:1):0;
    if(seat<0)return fail(socket,"That room already has two players.");
    room.players[seat]={name:(name||`Player ${seat+1}`).slice(0,24),socketId:socket.id,connected:true};
    sockets.get(socket.id).room=code; sockets.get(socket.id).seat=seat; socket.join(code);
    socket.emit("joined",{code}); room.lastAction=`${room.players[seat].name} joined.`;
    broadcast(room);
  });
  socket.on("drawDeck",()=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room); if(!room||p.seat!==room.turn||room.phase!=="playing")return;
    if(!room.deck.length)return fail(socket,"The deck is empty.");
    room.hands[p.seat].push(room.deck.pop()); room.lastAction=`${room.players[p.seat].name} drew from the deck.`; broadcast(room);
  });
  socket.on("takeDiscard",({index})=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room); if(!room||p.seat!==room.turn||room.phase!=="playing")return;
    index=Number(index); if(!Number.isInteger(index)||index<0||index>=room.discard.length)return fail(socket,"Choose a card in the discard pile.");
    const taken=room.discard.slice(index);
    room.hands[p.seat].push(...taken); room.discard=room.discard.slice(0,index);
    if(!room.discard.length) room.discard=[]; 
    room.lastAction=`${room.players[p.seat].name} took ${taken.length} card${taken.length===1?"":"s"} from the discard pile.`;
    broadcast(room);
  });
  socket.on("meld",({cardIds:chosen})=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room); if(!room||p.seat!==room.turn||room.phase!=="playing")return;
    const hand=room.hands[p.seat]; const cards=chosen.map(id=>hand.find(c=>cardId(c)===id)).filter(Boolean);
    if(cards.length!==chosen.length||new Set(chosen).size!==chosen.length||!validMeld(cards))return fail(socket,"That is not a legal set or run.");
    room.hands[p.seat]=hand.filter(c=>!chosen.includes(cardId(c)));
    room.melds.push({player:p.seat,cards}); room.lastAction=`${room.players[p.seat].name} melded ${cards.map(cardId).join(" ")}.`; broadcast(room);
  });
  socket.on("addToMeld",({meldIndex,cardIds:chosen})=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room); if(!room||p.seat!==room.turn||room.phase!=="playing")return;
    const m=room.melds[Number(meldIndex)]; if(!m)return fail(socket,"Meld not found.");
    const hand=room.hands[p.seat]; const cards=chosen.map(id=>hand.find(c=>cardId(c)===id)).filter(Boolean);
    if(cards.length!==chosen.length||cards.length<1)return fail(socket,"Choose at least one card.");
    const combined=[...m.cards,...cards];
    if(!validMeld(combined))return fail(socket,"Those cards cannot be added to that meld.");
    room.hands[p.seat]=hand.filter(c=>!chosen.includes(cardId(c))); m.cards=combined;
    room.lastAction=`${room.players[p.seat].name} added ${cards.map(cardId).join(" ")} to a meld.`; broadcast(room);
  });
  socket.on("discard",({cardId:id})=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room); if(!room||p.seat!==room.turn||room.phase!=="playing")return;
    const hand=room.hands[p.seat], at=hand.findIndex(c=>cardId(c)===id); if(at<0)return fail(socket,"Card not in your hand.");
    const [c]=hand.splice(at,1); room.discard.push(c);
    room.lastAction=`${room.players[p.seat].name} discarded ${cardId(c)}.`;
    const roundPoints=room.melds.filter(m=>m.player===p.seat).flatMap(m=>m.cards).reduce((a,c)=>a+scoreCard(c),0);
    if(hand.length===0){
      room.scores[p.seat]+=roundPoints;
      const other=room.hands[1-p.seat].reduce((a,c)=>a-scoreCard(c),0);
      room.scores[1-p.seat]+=other;
      if(room.scores[p.seat]>=500){room.phase="finished";room.winner=p.seat;}
      else { const d=freshDeck(); room.deck=d; room.hands=[[],[]]; for(let i=0;i<13;i++){room.hands[0].push(d.pop());room.hands[1].push(d.pop());} room.discard=[d.pop()]; room.melds=[]; }
    }
    room.turn=1-p.seat; broadcast(room);
  });
  socket.on("rematch",()=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room); if(!room)return;
    const oldPlayers=room.players; const r=newRoom(room.code); r.players=oldPlayers; r.scores=[0,0]; rooms.set(room.code,r); broadcast(r);
  });
  socket.on("disconnect",()=>{
    const p=sockets.get(socket.id); if(p?.room){const room=rooms.get(p.room); if(room?.players[p.seat]){room.players[p.seat].connected=false; room.lastAction=`${room.players[p.seat].name} disconnected. Please reconnect by refreshing.`; broadcast(room);}}
    sockets.delete(socket.id);
  });
});

const port=process.env.PORT||3000;
httpServer.listen(port,()=>console.log(`Rummy 500 running on http://localhost:${port}`));
