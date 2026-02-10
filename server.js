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

// === ИМПОРТ ПРАВИЛ ===
// Подключаем файл с правилами из папки public
const { DRAFT_RULES, IMMUNITY_ORDER } = require('./public/draft-rules.js');

const sessions = {};

io.on('connection', (socket) => {
    
    // --- СТВОРЕННЯ ГРИ ---
    socket.on('create_game', ({ nickname, draftType, userId }) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        // Используем новые правила
        const type = draftType || 'gitcg';
        const selectedSchema = DRAFT_RULES[type];

        sessions[roomId] = {
            id: roomId, 
            bluePlayer: socket.id, 
            blueUserId: userId, 
            redPlayer: null,
            redUserId: null,
            spectators: [], 
            blueName: nickname || 'Player 1', 
            redName: 'Waiting...',
            
            draftType: type,
            draftOrder: selectedSchema, 
            
            gameStarted: false,
            immunityPhaseActive: false,
            lastActive: Date.now(), 
            finishedAt: null,       

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

    // --- ПРИЄДНАННЯ ДО ГРИ ---
    socket.on('join_game', ({roomId, nickname, asSpectator, userId}) => {
        const session = sessions[roomId];
        if (!session) {
            socket.emit('error_msg', 'Room not found');
            return;
        }

        session.lastActive = Date.now();

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
            session.redUserId = userId; 
            session.redName = nickname || 'Player 2';
            socket.join(roomId);
            socket.emit('init_game', { 
                roomId, role: 'red', 
                state: getPublicState(session), chars: CHARACTERS_BY_ELEMENT 
            });
            io.to(roomId).emit('update_state', getPublicState(session));
        } 
    });

    // --- ПЕРЕПІДКЛЮЧЕННЯ (RECONNECT) ---
    socket.on('rejoin_game', ({ roomId, userId }) => {
        const session = sessions[roomId];
        if (!session) {
            socket.emit('error_msg', 'Session expired');
            return;
        }

        let role = '';
        if (session.blueUserId === userId) {
            session.bluePlayer = socket.id; 
            role = 'blue';
            session.lastActive = Date.now(); 
        } else if (session.redUserId === userId) {
            session.redPlayer = socket.id; 
            role = 'red';
            session.lastActive = Date.now(); 
        } else {
            role = 'spectator';
            session.spectators.push(socket.id);
        }

        socket.join(roomId);
        socket.emit('init_game', { 
            roomId, role, 
            state: getPublicState(session), chars: CHARACTERS_BY_ELEMENT 
        });
    });

    socket.on('player_ready', (roomId) => {
        const session = sessions[roomId];
        if (!session) return;

        session.lastActive = Date.now();

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

        session.lastActive = Date.now();

        const isBlueTurn = session.currentTeam === 'blue' && socket.id === session.bluePlayer;
        const isRedTurn = session.currentTeam === 'red' && socket.id === session.redPlayer;
        
        if (!isBlueTurn && !isRedTurn) return;

        // === ЛОГІКА ФАЗИ ІМУНІТЕТУ ===
        if (session.immunityPhaseActive) {
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

        // === ЛОГІКА ОСНОВНОГО ДРАФТУ ===
        const currentConfig = session.draftOrder[session.stepIndex];
        const isImmunityTurn = !!currentConfig.immunity;

        const isGlobalBanned = session.bans.some(b => b.id === charId);
        const isPickedByBlue = session.bluePicks.includes(charId);
        const isPickedByRed = session.redPicks.includes(charId);
        const isInImmunityPool = session.immunityPool.includes(charId);

        if (isGlobalBanned) return;
        if (session.currentTeam === 'blue' && isPickedByBlue) return;
        if (session.currentTeam === 'red' && isPickedByRed) return;

        if (isInImmunityPool) {
            if (session.currentAction === 'ban') return;
            if (session.currentAction === 'pick' && !isImmunityTurn) return;
        }

        let isAvailable = !isPickedByBlue && !isPickedByRed;
        if (isImmunityTurn && isInImmunityPool) {
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
        session.finishedAt = Date.now();
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
            if (session.currentTeam === 'blue') session.blueReserve--;
            else session.redReserve--;
            
            if(session.blueReserve < -5 || session.redReserve < -5) {
               autoPick(roomId); 
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

    session.lastActive = Date.now();

    if (session.immunityPhaseActive) {
        const available = allFlat.filter(c => !session.immunityBans.includes(c.id) && !session.immunityPool.includes(c.id));
        if (available.length > 0) {
            const r = available[Math.floor(Math.random() * available.length)];
            if (session.currentAction === 'immunity_ban') session.immunityBans.push(r.id);
            else session.immunityPool.push(r.id);
            nextImmunityStep(roomId);
        }
        return;
    }

    const currentConfig = session.draftOrder[session.stepIndex];
    const isImmunityTurn = !!currentConfig.immunity;

    const available = allFlat.filter(c => {
        const isBanned = session.bans.some(b => b.id === c.id);
        if (isBanned) return false;
        
        const myPicks = session.currentTeam === 'blue' ? session.bluePicks : session.redPicks;
        const oppPicks = session.currentTeam === 'blue' ? session.redPicks : session.bluePicks;
        
        if (myPicks.includes(c.id)) return false;
        
        const isInImmunityPool = session.immunityPool.includes(c.id);

        if (isInImmunityPool) {
            if (session.currentAction === 'ban') return false;
            if (session.currentAction === 'pick' && !isImmunityTurn) return false;
        }

        if (oppPicks.includes(c.id)) {
            if (isImmunityTurn && isInImmunityPool) return true;
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

const CLEANUP_INTERVAL = 60 * 1000; 
const SESSION_TIMEOUT = 60 * 60 * 1000; 

setInterval(() => {
    const now = Date.now();
    const roomIds = Object.keys(sessions);
    let deletedCount = 0;

    roomIds.forEach(roomId => {
        const session = sessions[roomId];
        const room = io.sockets.adapter.rooms.get(roomId);
        const isEmpty = !room || room.size === 0;

        const isOldFinished = session.finishedAt && (now - session.finishedAt > SESSION_TIMEOUT);
        const isAbandoned = isEmpty && (now - session.lastActive > SESSION_TIMEOUT);

        if (isOldFinished || isAbandoned) {
            if (session.timerInterval) clearInterval(session.timerInterval);
            delete sessions[roomId];
            deletedCount++;
        }
    });

    if (deletedCount > 0) {
        console.log(`[Cleanup] Removed ${deletedCount} old sessions.`);
    }
}, CLEANUP_INTERVAL);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server started on :${PORT}`));
