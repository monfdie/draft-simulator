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
        { team: 'blue', type: 'pick' }, // Blue Pick 4
        { team: 'red', type: 'pick' }, // Red Pick 4
        { team: 'red', type: 'pick' },
        { team: 'blue', type: 'pick' }, { team: 'blue', type: 'pick' },
        { team: 'red', type: 'ban' }, 
        { team: 'red', type: 'pick' },
        { team: 'blue', type: 'ban' }, 
        { team: 'blue', type: 'pick' },
        { team: 'red', type: 'ban' }, 
        { team: 'red', type: 'pick' },
        { team: 'blue', type: 'pick' }, { team: 'blue', type: 'pick' }, // Blue Pick 9 (index 25)
        { team: 'red', type: 'pick' }, { team: 'red', type: 'pick' }  // Red Pick 9 (index 27)
    ],
    'classic': [
        { team: 'blue', type: 'ban' }, { team: 'red', type: 'ban' },       
        { team: 'red', type: 'pick' }, { team: 'blue', type: 'ban' },      
        { team: 'blue', type: 'pick' }, { team: 'red', type: 'ban' },       
        { team: 'red', type: 'pick' }, { team: 'blue', type: 'pick' },     
        { team: 'blue', type: 'pick' }, { team: 'red', type: 'pick' }       
    ]
};

// Create GITCG CUP 2 by copying GITCG and marking immunity steps
// Blue picks: 5, 8, 9, 13(4th), 16, 17, 21, 24, 25(9th)
// Red picks: 6, 7, 11, 14(4th), 15, 19, 23, 26, 27(9th)
const gitcgSchema = DRAFT_SCHEMAS['gitcg'];
const gitcgCup2Schema = JSON.parse(JSON.stringify(gitcgSchema));

// Mark Immunity Picks
gitcgCup2Schema[13].immunity = true; // Blue Pick 4
gitcgCup2Schema[14].immunity = true; // Red Pick 4
gitcgCup2Schema[25].immunity = true; // Blue Pick 9
gitcgCup2Schema[27].immunity = true; // Red Pick 9

DRAFT_SCHEMAS['gitcg_cup_2'] = gitcgCup2Schema;


const sessions = {};

io.on('connection', (socket) => {
    socket.on('create_game', ({ nickname, draftType, userId }) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        const type = draftType || 'gitcg';
        const selectedSchema = DRAFT_SCHEMAS[type];

        // Determine if we start with immunity phase
        const hasImmunityPhase = (type === 'gitcg_cup_2');

        sessions[roomId] = {
            id: roomId, 
            bluePlayer: socket.id, 
            redPlayer: null,
            spectators: [], 
            blueName: nickname || 'Player 1', 
            redName: 'Waiting...',
            
            draftType: type,
            draftOrder: selectedSchema, 
            
            // Phase Management
            gameStarted: false,
            immunityPhaseActive: false, // Will activate on game start
            
            // Main Draft State
            stepIndex: 0, 
            currentTeam: null, 
            currentAction: null,
            
            // Immunity State
            immunityStepIndex: 0,
            immunityPool: [], // Characters selected for immunity
            immunityBans: [], // Characters banned from immunity
            
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

    socket.on('join_game', ({roomId, nickname, asSpectator, userId}) => {
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
            
            // Check if we need to run Immunity Phase first
            if (session.draftType === 'gitcg_cup_2') {
                session.immunityPhaseActive = true;
                session.currentTeam = IMMUNITY_ORDER[0].team;
                session.currentAction = IMMUNITY_ORDER[0].type;
            } else {
                // Classic start
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

        // === IMMUNITY PHASE LOGIC ===
        if (session.immunityPhaseActive) {
            // Validation
            const isImmunityBanned = session.immunityBans.includes(charId);
            const isImmunityPicked = session.immunityPool.includes(charId);
            // Cannot pick banned-for-immunity chars
            // Cannot pick already picked-for-immunity chars
            if (isImmunityBanned || isImmunityPicked) return;

            if (session.currentAction === 'immunity_ban') {
                session.immunityBans.push(charId);
            } else if (session.currentAction === 'immunity_pick') {
                session.immunityPool.push(charId);
            }
            
            nextImmunityStep(roomId);
            return;
        }

        // === MAIN DRAFT LOGIC ===
        const currentConfig = session.draftOrder[session.stepIndex];
        const isImmunityTurn = !!currentConfig.immunity;

        // Validation
        const isGlobalBanned = session.bans.some(b => b.id === charId);
        const isPickedByBlue = session.bluePicks.includes(charId);
        const isPickedByRed = session.redPicks.includes(charId);
        
        // Basic check: never pick global bans
        if (isGlobalBanned) return;

        // Self check: cannot have duplicate in own team
        if (session.currentTeam === 'blue' && isPickedByBlue) return;
        if (session.currentTeam === 'red' && isPickedByRed) return;

        // Availability check
        let isAvailable = !isPickedByBlue && !isPickedByRed;

        // IMMUNITY EXCEPTION:
        // If it's an immunity turn, AND the char is in immunity pool,
        // we can pick it even if the OTHER team has it.
        if (isImmunityTurn && session.immunityPool.includes(charId)) {
            // We already checked self-ownership above. 
            // So if opponent has it, isAvailable is false, but we allow it here.
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
        // Immunity phase over, start main draft
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
            if (session.currentTeam === 'blue') {
                session.blueReserve--;
                if (session.blueReserve < 0) return autoPick(roomId);
            } else {
                session.redReserve--;
                if (session.redReserve < 0) return autoPick(roomId);
            }
        }

        io.to(roomId).emit('timer_tick', {
            main: session.timer,
            blueReserve: session.blueReserve,
            redReserve: session.redReserve
        });
    }, 1000);
}

function autoPick(roomId) {
    const session = sessions[roomId];
    let allFlat = [];
    Object.values(CHARACTERS_BY_ELEMENT).forEach(arr => allFlat.push(...arr));

    // Handle Immunity Phase Auto Pick
    if (session.immunityPhaseActive) {
        const available = allFlat.filter(c => 
            !session.immunityBans.includes(c.id) && !session.immunityPool.includes(c.id)
        );
        if (available.length > 0) {
            const r = available[Math.floor(Math.random() * available.length)];
            if (session.currentAction === 'immunity_ban') session.immunityBans.push(r.id);
            else session.immunityPool.push(r.id);
            nextImmunityStep(roomId);
        }
        return;
    }

    // Main Draft Auto Pick
    // Needs updated logic for immunity picks
    const currentConfig = session.draftOrder[session.stepIndex];
    const isImmunityTurn = !!currentConfig.immunity;

    const available = allFlat.filter(c => {
        const isBanned = session.bans.some(b => b.id === c.id);
        if (isBanned) return false;
        
        const myPicks = session.currentTeam === 'blue' ? session.bluePicks : session.redPicks;
        const oppPicks = session.currentTeam === 'blue' ? session.redPicks : session.bluePicks;
        
        if (myPicks.includes(c.id)) return false;
        
        // Immunity Logic for Auto Pick
        if (oppPicks.includes(c.id)) {
            // Allowed ONLY if immunity turn AND char in pool
            if (isImmunityTurn && session.immunityPool.includes(c.id)) return true;
            return false;
        }
        return true;
    });

    if (available.length > 0) {
        const randomChar = available[Math.floor(Math.random() * available.length)];
        if (session.currentAction === 'ban') {
            session.bans.push({ id: randomChar.id, team: session.currentTeam });
        } else {
            if (session.currentTeam === 'blue') session.bluePicks.push(randomChar.id);
            else session.redPicks.push(randomChar.id);
        }
        nextStep(roomId);
    }
}

function getPublicState(session) {
    // Determine effective step index for UI
    let uiStepIndex = session.stepIndex + 1;
    
    return {
        // Main State
        stepIndex: uiStepIndex,
        currentTeam: session.currentTeam, 
        currentAction: session.currentAction,
        
        // Lists
        bans: session.bans, 
        bluePicks: session.bluePicks, 
        redPicks: session.redPicks,
        
        // Immunity State
        immunityPhaseActive: session.immunityPhaseActive,
        immunityPool: session.immunityPool,
        immunityBans: session.immunityBans,
        
        // Meta
        blueName: session.blueName, 
        redName: session.redName,
        draftType: session.draftType,
        ready: session.ready,
        gameStarted: session.gameStarted
    };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server started on :${PORT}`));
