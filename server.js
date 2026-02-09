const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// === CHARACTERS DATA ===
const CHARACTERS_BY_ELEMENT = require('./characters.json');

// === IMMUNITY PHASE ORDER ===
const IMMUNITY_ORDER = [
    { team: 'blue', type: 'immunity_ban' },
    { team: 'red', type: 'immunity_ban' },
    { team: 'blue', type: 'immunity_pick' },
    { team: 'red', type: 'immunity_pick' }
];

// === DRAFT SCHEMAS ===
const DRAFT_SCHEMAS = {
    'gitcg': [
        { team: 'blue', type: 'ban' }, { team: 'blue', type: 'ban' },
        { team: 'red', type: 'ban' },  { team: 'red', type: 'ban' },
        { team: 'blue', type: 'ban' }, 
        { team: 'blue', type: 'pick' },
        { team: 'red', type: 'pick' }, { team: 'red', type: 'pick' },
        { team: 'blue', type: 'pick' }, { team: 'blue', type: 'pick' },
        { team: 'red', type: 'ban' }, 
        { team: 'red', type: 'pick' },
        { team: 'blue', type: 'ban' }, 
        { team: 'blue', type: 'pick' }, 
        { team: 'red', type: 'pick' }, 
        { team: 'red', type: 'pick' },
        { team: 'blue', type: 'pick' }, { team: 'blue', type: 'pick' },
        { team: 'red', type: 'ban' }, 
        { team: 'red', type: 'pick' },
        { team: 'blue', type: 'ban' }, 
        { team: 'blue', type: 'pick' },
        { team: 'red', type: 'ban' }, 
        { team: 'red', type: 'pick' },
        { team: 'blue', type: 'pick' }, { team: 'blue', type: 'pick' },
        { team: 'red', type: 'pick' }, { team: 'red', type: 'pick' }
    ],
    'classic': [
        { team: 'blue', type: 'ban' }, { team: 'red', type: 'ban' },       
        { team: 'red', type: 'pick' }, { team: 'blue', type: 'ban' },      
        { team: 'blue', type: 'pick' }, { team: 'red', type: 'ban' },       
        { team: 'red', type: 'pick' }, { team: 'blue', type: 'pick' },     
        { team: 'blue', type: 'pick' }, { team: 'red', type: 'pick' }       
    ]
};

// Create GITCG CUP 2
const gitcgCup2Schema = JSON.parse(JSON.stringify(DRAFT_SCHEMAS['gitcg']));
// Mark Immunity Picks (indices are 0-based from server perspective)
gitcgCup2Schema[13].immunity = true; // Blue Pick 4
gitcgCup2Schema[14].immunity = true; // Red Pick 4
gitcgCup2Schema[25].immunity = true; // Blue Pick 9
gitcgCup2Schema[27].immunity = true; // Red Pick 9

DRAFT_SCHEMAS['gitcg_cup_2'] = gitcgCup2Schema;

const sessions = {};

io.on('connection', (socket) => {
    socket.on('create_game', ({ nickname, draftType }) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        const type = draftType || 'gitcg';
        const selectedSchema = DRAFT_SCHEMAS[type];

        sessions[roomId] = {
            id: roomId, 
            bluePlayer: socket.id, 
            redPlayer: null,
            spectators: [], 
            blueName: nickname || 'Player 1', 
            redName: 'Waiting...',
            
            draftType: type,
            draftOrder: selectedSchema, 
            
            gameStarted: false,
            immunityPhaseActive: false,
            
            stepIndex: 0, 
            currentTeam: null, 
            currentAction: null,
            
            immunityStepIndex: 0,
            immunityPool: [], 
            immunityBans: [], 
            
            timer: 60, 
            blueReserve: 300, 
            redReserve: 300, 
            timerInterval: null,
            
            bans: [], 
            bluePicks: [], redPicks: [],
            ready: { blue: false, red: false }
        };
        
        socket.join(roomId);
        socket.emit('init_game', { 
            roomId, role: 'blue', 
            state: getPublicState(sessions[roomId]), chars: CHARACTERS_BY_ELEMENT 
        });
    });

    socket.on('join_game', ({roomId, nickname, asSpectator}) => {
        const session = sessions[roomId];
        if (!session) {
            socket.emit('error_msg', 'Room not found');
            return;
        }

        if (asSpectator || (session.bluePlayer && session.redPlayer)) {
            session.spectators.push(socket.id);
            socket.join(roomId);
            socket.emit('init_game', { 
                roomId, role: 'spectator', 
                state: getPublicState(session), chars: CHARACTERS_BY_ELEMENT 
            });
            return;
        }

        if (!session.redPlayer) {
            session.redPlayer = socket.id;
            session.redName = nickname || 'Player 2';
            socket.join(roomId);
            socket.emit('init_game', { 
                roomId, role: 'red', 
                state: getPublicState(session), chars: CHARACTERS_BY_ELEMENT 
            });
            io.to(roomId).emit('update_state', getPublicState(session));
        } 
    });

    socket.on('player_ready', (roomId) => {
        const session = sessions[roomId];
        if (!session) return;

        if (socket.id === session.bluePlayer) session.ready.blue = true;
        if (socket.id === session.redPlayer) session.ready.red = true;

        io.to(roomId).emit('update_state', getPublicState(session));

        if (session.ready.blue && session.ready.red && !session.gameStarted) {
            session.gameStarted = true;
            
            if (session.draftType === 'gitcg_cup_2') {
                session.immunityPhaseActive = true;
                session.currentTeam = IMMUNITY_ORDER[0].team;
                session.currentAction = IMMUNITY_ORDER[0].type;
            } else {
                session.currentTeam = session.draftOrder[0].team;
                session.currentAction = session.draftOrder[0].type;
            }
            
            startTimer(roomId);
            io.to(roomId).emit('game_started');
            io.to(roomId).emit('update_state', getPublicState(session));
        }
    });

    socket.on('action', ({ roomId, charId }) => {
        const session = sessions[roomId];
        if (!session || !session.redPlayer || !session.gameStarted) return;

        const isBlueTurn = session.currentTeam === 'blue' && socket.id === session.bluePlayer;
        const isRedTurn = session.currentTeam === 'red' && socket.id === session.redPlayer;
        
        if (!isBlueTurn && !isRedTurn) return;

        // === IMMUNITY PHASE ===
        if (session.immunityPhaseActive) {
            // Cannot pick characters already in immunity pool or banned from immunity
            const isImmunityBanned = session.immunityBans.includes(charId);
            const isImmunityPicked = session.immunityPool.includes(charId);
            
            if (isImmunityBanned || isImmunityPicked) return;

            if (session.currentAction === 'immunity_ban') {
                session.immunityBans.push(charId);
            } else if (session.currentAction === 'immunity_pick') {
                session.immunityPool.push(charId);
            }
            
            nextImmunityStep(roomId);
            return;
        }

        // === MAIN DRAFT ===
        const currentConfig = session.draftOrder[session.stepIndex];
        const isImmunityTurn = !!currentConfig.immunity;

        const isGlobalBanned = session.bans.some(b => b.id === charId);
        const isPickedByBlue = session.bluePicks.includes(charId);
        const isPickedByRed = session.redPicks.includes(charId);
        
        // Basic check: Global Bans (from MAIN draft) block everything
        if (isGlobalBanned) return;

        // Self check: cannot have duplicate in OWN team
        if (session.currentTeam === 'blue' && isPickedByBlue) return;
        if (session.currentTeam === 'red' && isPickedByRed) return;

        let isAvailable = !isPickedByBlue && !isPickedByRed;

        // IMMUNITY RULE: 
        // If it's an immunity turn, AND char is in immunity pool -> available even if taken by opponent
        if (isImmunityTurn && session.immunityPool.includes(charId)) {
            isAvailable = true; 
        }

        if (!isAvailable) return;

        if (session.currentAction === 'ban') {
            session.bans.push({ id: charId, team: session.currentTeam });
        } else {
            if (session.currentTeam === 'blue') session.bluePicks.push(charId);
            else session.redPicks.push(charId);
        }

        nextStep(roomId);
    });

    socket.on('disconnect', () => {});
});

function nextImmunityStep(roomId) {
    const session = sessions[roomId];
    session.immunityStepIndex++;
    session.timer = 60;

    if (session.immunityStepIndex >= IMMUNITY_ORDER.length) {
        session.immunityPhaseActive = false;
        session.stepIndex = 0;
        session.currentTeam = session.draftOrder[0].team;
        session.currentAction = session.draftOrder[0].type;
    } else {
        const config = IMMUNITY_ORDER[session.immunityStepIndex];
        session.currentTeam = config.team;
        session.currentAction = config.type;
    }
    
    io.to(roomId).emit('update_state', getPublicState(session));
}

function nextStep(roomId) {
    const session = sessions[roomId];
    session.stepIndex++;
    session.timer = 60; 

    if (session.stepIndex >= session.draftOrder.length) {
        io.to(roomId).emit('game_over', getPublicState(session));
        clearInterval(session.timerInterval);
        return;
    }

    const config = session.draftOrder[session.stepIndex];
    session.currentTeam = config.team;
    session.currentAction = config.type;

    io.to(roomId).emit('update_state', getPublicState(session));
}

function startTimer(roomId) {
    const session = sessions[roomId];
    if (session.timerInterval) clearInterval(session.timerInterval);
    
    session.timerInterval = setInterval(() => {
        if (session.timer > 0) {
            session.timer--;
        } else {
            // Simple logic: if timer runs out, auto-pick logic (simplified)
            // Ideally we auto-pick/ban
            if (session.currentTeam === 'blue') session.blueReserve--;
            else session.redReserve--;
        }

        io.to(roomId).emit('timer_tick', {
            main: session.timer,
            blueReserve: session.blueReserve,
            redReserve: session.redReserve
        });
    }, 1000);
}

function getPublicState(session) {
    return {
        stepIndex: session.stepIndex + 1,
        currentTeam: session.currentTeam, 
        currentAction: session.currentAction,
        bans: session.bans, 
        bluePicks: session.bluePicks, 
        redPicks: session.redPicks,
        immunityPhaseActive: session.immunityPhaseActive,
        immunityPool: session.immunityPool,
        immunityBans: session.immunityBans,
        blueName: session.blueName, 
        redName: session.redName,
        draftType: session.draftType,
        ready: session.ready,
        gameStarted: session.gameStarted
    };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server started on :${PORT}`));
