const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// === CHARACTERS DATA (IMPORTED) ===
// Убедитесь, что файл characters.json лежит в той же папке!
const CHARACTERS_BY_ELEMENT = require('./characters.json');

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
        { team: 'red', type: 'pick' }, { team: 'red', type: 'pick' },
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
        { team: 'blue', type: 'ban' },      
        { team: 'red', type: 'ban' },       
        { team: 'red', type: 'pick' },      
        { team: 'blue', type: 'ban' },      
        { team: 'blue', type: 'pick' },     
        { team: 'red', type: 'ban' },       
        { team: 'red', type: 'pick' },      
        { team: 'blue', type: 'pick' },     
        { team: 'blue', type: 'pick' },     
        { team: 'red', type: 'pick' }       
    ]
};

const sessions = {};

io.on('connection', (socket) => {
    // 1. Создание игры: теперь запоминаем userId
    socket.on('create_game', ({ nickname, draftType, userId }) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        
        const selectedSchema = DRAFT_SCHEMAS[draftType] || DRAFT_SCHEMAS['gitcg'];

        sessions[roomId] = {
            id: roomId, 
            bluePlayer: socket.id, 
            blueUserId: userId,      // <-- ЗАПОМИНАЕМ ID СОЗДАТЕЛЯ
            redPlayer: null,
            redUserId: null,         // <-- ID второго игрока пока пуст
            spectators: [], 
            blueName: nickname || 'Player 1', 
            redName: 'Waiting...',
            stepIndex: 0, 
            draftType: draftType || 'gitcg',
            draftOrder: selectedSchema, 
            currentTeam: selectedSchema[0].team, 
            currentAction: selectedSchema[0].type,
            timer: 60, 
            blueReserve: 300, 
            redReserve: 300, 
            timerInterval: null,
            bans: [], 
            bluePicks: [], redPicks: [],
            ready: { blue: false, red: false },
            gameStarted: false
        };
        socket.join(roomId);
        socket.emit('init_game', { 
            roomId, role: 'blue', 
            state: getPublicState(sessions[roomId]), chars: CHARACTERS_BY_ELEMENT 
        });
    });

    // 2. Вход в игру: проверка userId для реконнекта
    socket.on('join_game', ({roomId, nickname, asSpectator, userId}) => {
        const session = sessions[roomId];
        
        if (!session) {
            socket.emit('error_msg', 'Room not found');
            return;
        }

        // А) ПРОВЕРКА: Это вернулся Player 1 (Blue)?
        if (session.blueUserId === userId) {
            session.bluePlayer = socket.id; // Обновляем сокет
            socket.join(roomId);
            socket.emit('init_game', { 
                roomId, role: 'blue', 
                state: getPublicState(session), chars: CHARACTERS_BY_ELEMENT 
            });
            // Можно уведомить комнату, что игрок вернулся (опционально)
            return;
        }

        // Б) ПРОВЕРКА: Это вернулся Player 2 (Red)?
        if (session.redUserId === userId) {
            session.redPlayer = socket.id; // Обновляем сокет
            socket.join(roomId);
            socket.emit('init_game', { 
                roomId, role: 'red', 
                state: getPublicState(session), chars: CHARACTERS_BY_ELEMENT 
            });
            return;
        }

        // В) Логика Наблюдателя или если комната занята
        // Если место Красного занято (и это не мы), или мы явно хотим быть зрителем
        if (asSpectator || (session.redUserId && session.redUserId !== userId)) {
            session.spectators.push(socket.id);
            socket.join(roomId);
            socket.emit('init_game', { 
                roomId, role: 'spectator', 
                state: getPublicState(session), chars: CHARACTERS_BY_ELEMENT 
            });
            return;
        }

        // Г) Новый игрок заходит как Player 2
        if (!session.redPlayer) {
            session.redPlayer = socket.id;
            session.redUserId = userId; // <-- Запоминаем ID второго игрока
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
            startTimer(roomId);
            io.to(roomId).emit('game_started');
        }
    });

    socket.on('action', ({ roomId, charId }) => {
        const session = sessions[roomId];
        if (!session || !session.redPlayer) return;
        
        if (!session.gameStarted) return;

        const isBlueTurn = session.currentTeam === 'blue' && socket.id === session.bluePlayer;
        const isRedTurn = session.currentTeam === 'red' && socket.id === session.redPlayer;
        
        if (!isBlueTurn && !isRedTurn) return;

        // Validation
        const isBanned = session.bans.some(b => b.id === charId);
        if (isBanned || session.bluePicks.includes(charId) || session.redPicks.includes(charId)) return;

        if (session.currentAction === 'ban') {
            session.bans.push({ id: charId, team: session.currentTeam });
        } else {
            if (session.currentTeam === 'blue') session.bluePicks.push(charId);
            else session.redPicks.push(charId);
        }

        nextStep(roomId);
    });

    socket.on('disconnect', () => {
        // Можно добавить логику пометки "офлайн", но для реконнекта это не обязательно
    });
});

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

    const available = allFlat.filter(c => 
        !session.bans.some(b => b.id === c.id) && 
        !session.bluePicks.includes(c.id) && 
        !session.redPicks.includes(c.id)
    );

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
        currentTeam: session.currentTeam, currentAction: session.currentAction,
        bans: session.bans, bluePicks: session.bluePicks, redPicks: session.redPicks,
        blueName: session.blueName, redName: session.redName,
        draftType: session.draftType,
        ready: session.ready,
        gameStarted: session.gameStarted
    };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server started on :${PORT}`));
