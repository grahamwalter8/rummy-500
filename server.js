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

// This build uses the standard 52-card, no-joker version described in the setup.
// Aces score 1 in A-2-3... runs, 15 in high-Ace runs and sets, and 15 in a hand.
function baseCardValue(rank) {
  if (rank === "A") return 15;
  if (["J","Q","K"].includes(rank)) return 10;
  return Number(rank);
}
const cardId = c => `${c.rank}${c.suit}`;

function freshDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank:r, suit:s });
  // Cryptographically strong Fisher-Yates shuffle. Every new round/rematch
  // creates a fresh 52-card deck and shuffles all 52 positions independently.
  for (let i=d.length-1;i>0;i--) {
    const j=crypto.randomInt(i+1);
    [d[i],d[j]]=[d[j],d[i]];
  }
  return d;
}

function dealRound() {
  const deck = freshDeck();
  const hands = [[],[]];
  for (let i=0;i<13;i++) {
    hands[0].push(deck.pop());
    hands[1].push(deck.pop());
  }
  return { deck, hands, discard:[deck.pop()] };
}

function newRoom(code) {
  const r = dealRound();
  return {
    code,
    players:[null,null],
    hands:r.hands,
    deck:r.deck,
    discard:r.discard,
    melds:[],
    scores:[0,0],
    roundPoints:[0,0],
    lastRound:null,
    turn:0,
    phase:"playing",
    winner:null,
    lastAction:"Game started",
    turnState:{drawn:false, source:null, drawnIds:[], requiredId:null, requiredUsed:false},
    rummyOpen:false,
    chat:[]
  };
}

function publicState(room, socketId) {
  const p=sockets.get(socketId);
  const me=p?.room===room.code ? p.seat : -1;
  return {
    code:room.code,
    players:room.players.map(x=>x?{name:x.name,connected:x.connected}:null),
    me,
    hand:me>=0?room.hands[me]:[],
    handCount:room.hands.map(h=>h.length),
    deckCount:room.deck.length,
    discard:room.discard,
    melds:room.melds,
    scores:room.scores,
    roundPoints:room.roundPoints,
    lastRound:room.lastRound,
    turn:room.turn,
    phase:room.phase,
    winner:room.winner,
    lastAction:room.lastAction,
    rummyOpen:room.rummyOpen,
    turnState:room.turnState,
    chat:room.chat
  };
}

function broadcast(room) {
  for (const pl of room.players) {
    if (pl?.socketId) io.to(pl.socketId).emit("state",publicState(room,pl.socketId));
  }
}

function playerFor(socketId){return sockets.get(socketId)}
function fail(socket,msg){socket.emit("errorMessage",msg)}
function sameSuit(cards){return cards.length>0 && cards.every(c=>c.suit===cards[0].suit)}

function runOrder(cards) {
  if (!cards.length || !sameSuit(cards)) return null;
  const nums = cards.map(c => RANKS.indexOf(c.rank));
  if (nums.some(n => n < 0) || new Set(nums).size !== nums.length) return null;

  // Ace can be low or high. Test both possibilities independently so a low
  // run such as A-2-3-...-J is not mistaken for a high-Ace run.
  // Ace may not wrap around: K-A-2 is invalid.
  const lowOrder=[...nums].sort((a,b)=>a-b);
  const lowValid=lowOrder.every((v,i)=>i===0 || v===lowOrder[i-1]+1);
  if (lowValid) return lowOrder;

  if (nums.includes(0)) {
    const highOrder=[...nums].map(n=>n===0 ? 13 : n).sort((a,b)=>a-b);
    const highValid=highOrder.every((v,i)=>i===0 || v===highOrder[i-1]+1);
    if (highValid) return highOrder;
  }

  return null;
}

function validMeld(cards) {
  if (!Array.isArray(cards) || cards.length<3) return false;

  const ranks=new Set(cards.map(c=>c.rank));
  const suits=new Set(cards.map(c=>c.suit));

  // Set: 3 or 4 cards of the same rank, with different suits.
  if (ranks.size===1 && suits.size===cards.length && cards.length<=4) return true;

  // Run: 3+ consecutive cards of one suit, including A-2-3 and J-Q-K-A.
  return suits.size===1 && !!runOrder(cards);
}

function meldType(meld) {
  if (!meld?.cards?.length) return null;
  const cards=meld.cards;
  const ranks=new Set(cards.map(c=>c.rank));
  return ranks.size===1 ? "set" : "run";
}

function cardValueInMeld(card,meld) {
  if (card.rank!=="A") return baseCardValue(card.rank);
  if (meldType(meld)!=="run") return 15;
  const order=runOrder(meld.cards);
  if (!order) return 15;
  // In a low-Ace run, Ace is the first card (A-2-3, A-2-3-4, etc.).
  // In a high-Ace run, Ace is the final card (Q-K-A, J-Q-K-A, etc.).
  return order[0]===0 ? 1 : 15;
}

function roundMeldPoints(room, seat) {
  let total=0;
  for (const meld of room.melds) {
    for (const card of meld.cards) {
      if (card.laidBy===seat) total += cardValueInMeld(card,meld);
    }
  }
  return total;
}

function handPoints(hand) {
  return hand.reduce((sum,c)=>sum+baseCardValue(c.rank),0);
}

function refreshRoundPoints(room) {
  room.roundPoints=[0,1].map(seat=>roundMeldPoints(room,seat)-handPoints(room.hands[seat]));
}

function resetTurn(room) {
  room.turnState={drawn:false,source:null,drawnIds:[],requiredId:null,requiredUsed:false};
}

function finishRound(room, reason) {
  refreshRoundPoints(room);
  const deltas=[...room.roundPoints];
  room.scores[0]+=deltas[0];
  room.scores[1]+=deltas[1];
  room.lastRound={reason,deltas:[...deltas],melded:[0,1].map(s=>roundMeldPoints(room,s)),handPenalties:[0,1].map(s=>handPoints(room.hands[s]))};

  const reached=room.scores.map((s,i)=>s>=500?i:-1).filter(i=>i>=0);
  if (reached.length) {
    // If both reach 500 in the same hand, highest cumulative score wins.
    room.phase="finished";
    room.winner=room.scores[0]===room.scores[1] ? null : (room.scores[0]>room.scores[1]?0:1);
    room.lastAction=room.winner===null ? "Both players reached 500 and are tied." : `${room.players[room.winner]?.name||"Player"} won the game!`;
    room.rummyOpen=false;
    return;
  }

  const r=dealRound();
  room.hands=r.hands;
  room.deck=r.deck;
  room.discard=r.discard;
  room.melds=[];
  room.roundPoints=[0,0];
  room.turn=1-room.turn;
  room.lastAction=`Round over. ${deltas[0]>=0?"+":""}${deltas[0]} for ${room.players[0]?.name||"Player 1"}, ${deltas[1]>=0?"+":""}${deltas[1]} for ${room.players[1]?.name||"Player 2"}.`;
  room.rummyOpen=false;
  resetTurn(room);
}

function cardFromHand(hand,id){return hand.find(c=>cardId(c)===id)}

function drawAllowed(room,p) {
  return room && p && p.seat===room.turn && room.phase==="playing" && !room.turnState.drawn;
}

function useRequiredCard(room,p,chosenCards) {
  const req=room.turnState.requiredId;
  if (req && chosenCards.some(c=>cardId(c)===req)) room.turnState.requiredUsed=true;
}

function canAddToMeld(meld,cards) {
  return validMeld([...meld.cards,...cards]);
}

function startTurnAfterDraw(room, source, taken) {
  room.turnState.drawn=true;
  room.turnState.source=source;
  room.turnState.drawnIds=taken.map(cardId);
  room.turnState.requiredId=source==="discard" && taken.length>1 ? cardId(taken[0]) : null;
  room.turnState.requiredUsed=source==="discard" && taken.length===1 ? false : false;
}

function discardIndex(room,id){return room.discard.findIndex(c=>cardId(c)===id)}

function rummyCandidate(room, callerSeat) {
  if (!room.rummyOpen || room.discard.length===0) return null;

  // Try each discard position. The caller must be able to use the target card
  // immediately, either in a new meld with their hand or by laying it onto a table meld.
  for (let i=0;i<room.discard.length;i++) {
    const target=room.discard[i];
    const taken=room.discard.slice(i);
    const hand=room.hands[callerSeat];

    const targetWithHand=hand.concat(target);
    // New meld with target + any 2+ cards from hand.
    for (let a=0;a<hand.length;a++) {
      for (let b=a+1;b<hand.length;b++) {
        const group=[target,hand[a],hand[b]];
        if (validMeld(group)) return {index:i,taken,mode:"new",cards:group};
      }
    }

    // Add target to an existing meld.
    for (let m=0;m<room.melds.length;m++) {
      if (canAddToMeld(room.melds[m],[target])) return {index:i,taken,mode:"add",meldIndex:m,cards:[target]};
    }

    // A portion of the discard itself can form a meld, starting at target.
    for (let end=i+3;end<=room.discard.length;end++) {
      const group=room.discard.slice(i,end);
      if (validMeld(group)) return {index:i,taken,mode:"newDiscard",cards:group};
    }
  }
  return null;
}

io.on("connection",socket=>{
  sockets.set(socket.id,{socket});

  socket.on("createRoom",({name})=>{
    let code;
    do code=crypto.randomBytes(3).toString("hex").toUpperCase(); while(rooms.has(code));
    const room=newRoom(code);
    room.players[0]={name:(name||"Player 1").slice(0,24),socketId:socket.id,connected:true};
    rooms.set(code,room);
    sockets.get(socket.id).room=code;
    sockets.get(socket.id).seat=0;
    socket.join(code);
    socket.emit("roomCreated",{code});
    broadcast(room);
  });

  socket.on("joinRoom",({code,name})=>{
    code=(code||"").trim().toUpperCase();
    const room=rooms.get(code);
    if(!room)return fail(socket,"Room not found.");
    const seat=room.players[0] ? (room.players[1] ? -1:1) : 0;
    if(seat<0)return fail(socket,"That room already has two players.");
    room.players[seat]={name:(name||`Player ${seat+1}`).slice(0,24),socketId:socket.id,connected:true};
    sockets.get(socket.id).room=code;
    sockets.get(socket.id).seat=seat;
    socket.join(code);
    socket.emit("joined",{code});
    room.lastAction=`${room.players[seat].name} joined.`;
    broadcast(room);
  });

  socket.on("drawDeck",()=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room);
    if(!drawAllowed(room,p))return;
    if(!room.deck.length)return fail(socket,"The stock is empty. You can end the round or take from the discard pile.");
    const c=room.deck.pop();
    room.hands[p.seat].push(c);
    startTurnAfterDraw(room,"deck",[c]);
    room.lastAction=`${room.players[p.seat].name} drew from the deck.`;
    refreshRoundPoints(room);
    broadcast(room);
  });

  socket.on("takeDiscard",({index})=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room);
    if(!drawAllowed(room,p))return;
    index=Number(index);
    if(!Number.isInteger(index)||index<0||index>=room.discard.length)return fail(socket,"Choose a card in the discard pile.");
    const taken=room.discard.slice(index);
    room.discard=room.discard.slice(0,index);
    room.hands[p.seat].push(...taken);
    startTurnAfterDraw(room,"discard",taken);
    room.lastAction=`${room.players[p.seat].name} took ${taken.length} card${taken.length===1?"":"s"} from the discard pile.`;
    refreshRoundPoints(room);
    broadcast(room);
  });

  socket.on("meld",({cardIds:chosen})=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room);
    if(!room||p.seat!==room.turn||room.phase!=="playing")return;
    if(!room.turnState.drawn)return fail(socket,"Draw first.");
    const hand=room.hands[p.seat];
    const cards=chosen.map(id=>cardFromHand(hand,id)).filter(Boolean);
    if(cards.length!==chosen.length||new Set(chosen).size!==chosen.length||!validMeld(cards))return fail(socket,"That is not a legal set or run.");
    room.hands[p.seat]=hand.filter(c=>!chosen.includes(cardId(c)));
    room.melds.push({player:p.seat,cards:cards.map(c=>({...c,laidBy:p.seat}))});
    useRequiredCard(room,p,cards);
    room.lastAction=`${room.players[p.seat].name} melded ${cards.map(cardId).join(" ")}.`;
    refreshRoundPoints(room);
    broadcast(room);
  });

  socket.on("addToMeld",({meldIndex,cardIds:chosen})=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room);
    if(!room||p.seat!==room.turn||room.phase!=="playing")return;
    if(!room.turnState.drawn)return fail(socket,"Draw first.");
    const m=room.melds[Number(meldIndex)];
    if(!m)return fail(socket,"Meld not found.");
    const hand=room.hands[p.seat];
    const cards=chosen.map(id=>cardFromHand(hand,id)).filter(Boolean);
    if(cards.length!==chosen.length||cards.length<1)return fail(socket,"Choose at least one card.");
    if(!canAddToMeld(m,cards))return fail(socket,"Those cards cannot be added to that meld.");
    room.hands[p.seat]=hand.filter(c=>!chosen.includes(cardId(c)));
    m.cards=[...m.cards,...cards.map(c=>({...c,laidBy:p.seat}))];
    useRequiredCard(room,p,cards);
    room.lastAction=`${room.players[p.seat].name} added ${cards.map(cardId).join(" ")} to a meld.`;
    refreshRoundPoints(room);
    broadcast(room);
  });

  socket.on("discard",({cardId:id})=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room);
    if(!room||p.seat!==room.turn||room.phase!=="playing")return;
    if(!room.turnState.drawn)return fail(socket,"Draw first.");
    if(room.turnState.requiredId && !room.turnState.requiredUsed)return fail(socket,"You must use the card you took from deeper in the discard pile in a meld before discarding.");
    const hand=room.hands[p.seat];
    const at=hand.findIndex(c=>cardId(c)===id);
    if(at<0)return fail(socket,"Card not in your hand.");
    if(room.turnState.source==="discard" && room.turnState.drawnIds.length===1 && room.turnState.drawnIds[0]===id){
      return fail(socket,"You cannot discard the single card you just drew from the discard pile.");
    }
    if(room.turnState.requiredId===id)return fail(socket,"You must use that card in a meld.");
    const [c]=hand.splice(at,1);
    room.discard.push(c);
    room.rummyOpen=true;
    room.lastAction=`${room.players[p.seat].name} discarded ${cardId(c)}.`;
    refreshRoundPoints(room);

    if(hand.length===0){
      finishRound(room,"hand emptied");
    } else {
      room.turn=1-p.seat;
      resetTurn(room);
    }
    broadcast(room);
  });

  socket.on("endRound",()=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room);
    if(!room||p.seat!==room.turn||room.phase!=="playing")return;
    if(room.deck.length>0)return fail(socket,"The stock is not empty yet.");
    if(room.turnState.drawn)return fail(socket,"Finish your turn by discarding, or use the discard pile.");
    finishRound(room,"stock empty");
    broadcast(room);
  });

  socket.on("callRummy",()=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room);
    if(!room||room.phase!=="playing"||p.seat===room.turn||!room.rummyOpen)return;
    const candidate=rummyCandidate(room,p.seat);
    if(!candidate)return fail(socket,"There is no legal Rummy call available right now.");

    const taken=candidate.taken;
    room.discard=room.discard.slice(0,candidate.index);
    room.hands[p.seat].push(...taken);

    const target=taken[0];
    if(candidate.mode==="add"){
      const m=room.melds[candidate.meldIndex];
      room.hands[p.seat]=room.hands[p.seat].filter(c=>cardId(c)!==cardId(target));
      m.cards.push({...target,laidBy:p.seat});
      room.lastAction=`${room.players[p.seat].name} called Rummy and laid off ${cardId(target)}.`;
    } else {
      let group;
      if(candidate.mode==="newDiscard") {
        group=candidate.cards;
        const idsToRemove=new Set(group.map(cardId));
        room.hands[p.seat]=room.hands[p.seat].filter(c=>!idsToRemove.has(cardId(c)));
      } else {
        group=candidate.cards;
        const idsToRemove=new Set(group.map(cardId));
        room.hands[p.seat]=room.hands[p.seat].filter(c=>!idsToRemove.has(cardId(c)));
      }
      room.melds.push({player:p.seat,cards:group.map(c=>({...c,laidBy:p.seat}))});
      room.lastAction=`${room.players[p.seat].name} called Rummy and made a meld.`;
    }

    refreshRoundPoints(room);
    room.rummyOpen=false;

    // Calling Rummy transfers the turn to the caller. The claimed card(s) count
    // as the caller's draw for this turn, so they may continue melding/laying off
    // and then must discard without drawing again.
    room.turn=p.seat;
    room.turnState={
      drawn:true,
      source:"rummy",
      drawnIds:taken.map(cardId),
      requiredId:null,
      requiredUsed:true
    };

    if(room.hands[p.seat].length===0){
      finishRound(room,"hand emptied by Rummy");
    }
    broadcast(room);
  });

  socket.on("reorderHand",({order})=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room);
    if(!room || !Array.isArray(order) || p.seat<0)return;
    const hand=room.hands[p.seat];
    const byId=new Map(hand.map(c=>[cardId(c),c]));
    if(order.length!==hand.length || order.some(id=>!byId.has(id)) || new Set(order).size!==order.length)return;
    room.hands[p.seat]=order.map(id=>byId.get(id));
    broadcast(room);
  });

  socket.on("chatMessage",({message})=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room);
    if(!room)return;
    const text=String(message||"").trim().slice(0,500);
    if(!text)return;
    room.chat.push({name:room.players[p.seat]?.name||"Player",message:text,seat:p.seat,time:Date.now()});
    if(room.chat.length>100)room.chat.splice(0,room.chat.length-100);
    broadcast(room);
  });

  socket.on("rematch",()=>{
    const p=playerFor(socket.id), room=p&&rooms.get(p.room);
    if(!room)return;
    const oldPlayers=room.players;
    const r=newRoom(room.code);
    r.players=oldPlayers;
    r.scores=[0,0];
    rooms.set(room.code,r);
    broadcast(r);
  });

  socket.on("disconnect",()=>{
    const p=sockets.get(socket.id);
    if(p?.room){
      const room=rooms.get(p.room);
      if(room?.players[p.seat]){
        room.players[p.seat].connected=false;
        room.lastAction=`${room.players[p.seat].name} disconnected. Please reconnect by refreshing.`;
        broadcast(room);
      }
    }
    sockets.delete(socket.id);
  });
});

const port=process.env.PORT||3000;
httpServer.listen(port,()=>console.log(`Rummy 500 running on http://localhost:${port}`));
