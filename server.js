const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// === CHARACTERS DATA (IMPORTED) ===
// Переконайтеся, що файл characters.json лежить поруч
const CHARACTERS_BY_ELEMENT = require('./characters.json');

// === ПОРЯДОК ФАЗИ ІМУНІТЕТУ ===
const IMMUNITY_ORDER = [
    { team: 'blue', type: 'immunity_ban' },
    { team: 'red', type: 'immunity_ban' },
    { team: 'blue', type: 'immunity_pick' },
    { team: 'red', type: 'immunity_pick' }
];

// === СХЕМИ ДРАФТУ ===
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

// Створення схеми GITCG CUP 2 на основі звичайної
const gitcgCup2Schema = JSON.parse(JSON.stringify(DRAFT_SCHEMAS['gitcg']));
// Позначаємо імунітетні піки (індекси масиву починаються з 0)
// Blue Pick 4 -> індекс 13
gitcgCup2Schema[13].immunity = true; 
// Red Pick 4 -> індекс 14
gitcgCup2Schema[14].immunity = true; 
// Blue Pick 9 -> індекс 25
gitcgCup2Schema[25].immunity = true; 
// Red Pick 9 -> індекс 27
gitcgCup2Schema[27].immunity = true; 

DRAFT_SCHEMAS['gitcg_cup_2'] = gitcgCup2Schema;

const sessions = {};

io.on('connection', (socket) => {
    
    // --- СТВОРЕННЯ ГРИ ---
    socket.on('create_game', ({ nickname, draftType, userId }) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        const type = draftType || 'gitcg';
        const selectedSchema = DRAFT_SCHEMAS[type];

        sessions[roomId] = {
            id: roomId, 
            
            // Зберігаємо userId для реконнекту
            bluePlayer: socket.id, 
            blueUserId: userId, 
            
            redPlayer: null,
            redUserId: null,
            
            spectators: [], 
            blueName: nickname || 'Player 1', 
            redName: 'Waiting...',
            
            draftType: type,
            draftOrder: selectedSchema, 
            
            // Стан фаз
            gameStarted: false,
            immunityPhaseActive: false,
            
            // Основний драфт
            stepIndex: 0, 
            currentTeam: null, 
            currentAction: null,
            
            // Імунітети
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
            session.redUserId = userId; // Зберігаємо ID другого гравця
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
        
        // Перевіряємо, чи це один з гравців
        if (session.blueUserId === userId) {
            session.bluePlayer = socket.id; // Оновлюємо сокет
            role = 'blue';
        } else if (session.redUserId === userId) {
            session.redPlayer = socket.id; // Оновлюємо сокет
            role = 'red';
        } else {
            // Якщо ні, кидаємо в глядачі
            role = 'spectator';
            session.spectators.push(socket.id);
        }

        socket.join(roomId);
        
        // Відправляємо актуальний стан
        socket.emit('init_game', { 
            roomId, role, 
            state: getPublicState(session), chars: CHARACTERS_BY_ELEMENT 
        });
    });

    socket.on('player_ready', (roomId) => {
        const session = sessions[roomId];
        if (!session) return;

        if (socket.id === session.bluePlayer) session.ready.blue = true;
        if (socket.id === session.redPlayer) session.ready.red = true;

        io.to(roomId).emit('update_state', getPublicState(session));

        if (session.ready.blue && session.ready.red && !session.gameStarted) {
            session.gameStarted = true;
            
            // Якщо режим з імунітетом - починаємо з фази імунітету
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

        // === ЛОГІКА ФАЗИ ІМУНІТЕТУ ===
        if (session.immunityPhaseActive) {
            const isImmunityBanned = session.immunityBans.includes(charId);
            const isImmunityPicked = session.immunityPool.includes(charId);
            // Не можна вибрати вже забаненого або пікнутого в імунітет
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

        // Перевірки
        if (isGlobalBanned) return;
        if (session.currentTeam === 'blue' && isPickedByBlue) return;
        if (session.currentTeam === 'red' && isPickedByRed) return;

        // Захист імунітетних персонажів
        if (isInImmunityPool) {
            // Не можна банити персонажа з пулу імунітету
            if (session.currentAction === 'ban') return;
            // Не можна пікати персонажа з пулу, якщо це НЕ імунітетний хід
            if (session.currentAction === 'pick' && !isImmunityTurn) return;
        }

        let isAvailable = !isPickedByBlue && !isPickedByRed;

        // Дозвіл на дублікат, якщо хід імунітетний і персонаж в пулі
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
        // Кінець фази імунітету -> перехід до основи
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
            // Зменшуємо резерв
            if (session.currentTeam === 'blue') session.blueReserve--;
            else session.redReserve--;
            
            // Якщо резерв вичерпано - автопік
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

    // Автопік для фази імунітету
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

    // Автопік для основи
    const currentConfig = session.draftOrder[session.stepIndex];
    const isImmunityTurn = !!currentConfig.immunity;

    const available = allFlat.filter(c => {
        const isBanned = session.bans.some(b => b.id === c.id);
        if (isBanned) return false;
        
        const myPicks = session.currentTeam === 'blue' ? session.bluePicks : session.redPicks;
        const oppPicks = session.currentTeam === 'blue' ? session.redPicks : session.bluePicks;
        
        if (myPicks.includes(c.id)) return false;
        
        const isInImmunityPool = session.immunityPool.includes(c.id);

        // Якщо перс в імун-пулі, його не можна банити або пікати в невідповідний час
        if (isInImmunityPool) {
            if (session.currentAction === 'ban') return false;
            if (session.currentAction === 'pick' && !isImmunityTurn) return false;
        }

        // Якщо перс у ворога
        if (oppPicks.includes(c.id)) {
            // Можна тільки якщо це імунітет
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server started on :${PORT}`));
