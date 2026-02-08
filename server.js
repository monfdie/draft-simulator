const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Данные о персонажах (Кратко, полные ссылки на клиенте для оптимизации, но для надежности оставим тут)
const CHARS = {
    cryo: ['ganyu', 'diona', 'kaeya', 'chongyun', 'ayaka', 'eula', 'shenhe', 'qiqi', 'layla', 'charlotte', 'wriothesley', 'freminet', 'rosaria', 'citlali', 'signora', 'cryocicin', 'cryohypo', 'operative', 'skirk', 'escofier'],
    hydro: ['barbara', 'xingqiu', 'mona', 'tartaglia', 'kokomi', 'ayato', 'candace', 'nilou', 'yelan', 'neuvillette', 'furina', 'sigewinne', 'mualani', 'rhodeia', 'mirror', 'herald', 'narwhal', 'hilichurlrogue', 'hydrotulpa', 'crocodile'],
    pyro: ['diluc', 'xiangling', 'bennett', 'amber', 'yoimiya', 'klee', 'hutao', 'yanfei', 'dehya', 'lyney', 'thoma', 'xinyan', 'chevreuse', 'arlecchino', 'mavuika', 'gaming', 'pyroagent', 'pyrolector', 'babel', 'crab', 'gosoytot'],
    electro: ['fischl', 'razor', 'keqing', 'cyno', 'beidou', 'sara', 'raiden', 'yaemiko', 'lisa', 'dori', 'kuki', 'clorinde', 'sethos', 'iansan', 'varesa', 'ororon', 'electrohypo', 'manifestation', 'seahorse', 'electrocicin', 'scorpion', 'electrolector'],
    anemo: ['sucrose', 'jean', 'venti', 'xiao', 'kazuha', 'wanderer', 'sayu', 'lynette', 'faruzan', 'xianyun', 'chasca', 'lanyan', 'heizou', 'mizuki', 'ifa', 'kenki', 'dvalin', 'serpent'],
    geo: ['ningguang', 'noelle', 'zhongli', 'albedo', 'itto', 'gorou', 'yunjin', 'navia', 'chiori', 'kachina', 'xilonen', 'lawachurl', 'azhdaha', 'wolflord', 'knight'],
    dendro: ['collei', 'tighnari', 'nahida', 'yaoyao', 'baizhu', 'alhaitham', 'kirara', 'kaveh', 'kinich', 'emilie', 'shroom', 'apep', 'dancer', 'king']
};

const DRAFT_ORDER = [
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
];

const sessions = {};

io.on('connection', (socket) => {
    socket.on('create_game', (nickname) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        sessions[roomId] = createSession(roomId, socket.id, nickname);
        socket.join(roomId);
        socket.emit('init_game', { 
            roomId, role: 'blue', 
            state: sessions[roomId].publicState 
        });
    });

    socket.on('join_game', ({roomId, nickname}) => {
        const session = sessions[roomId];
        if (session && !session.redPlayer) {
            session.redPlayer = socket.id;
            session.publicState.redName = nickname || 'Player 2';
            socket.join(roomId);
            socket.emit('init_game', { 
                roomId, role: 'red', 
                state: session.publicState 
            });
            io.to(roomId).emit('update_state', session.publicState);
            startTimer(roomId);
        } else {
            socket.emit('error_msg', 'Ошибка доступа');
        }
    });

    socket.on('action', ({ roomId, charId }) => {
        const session = sessions[roomId];
        if (!session || !session.redPlayer) return;
        
        const isBlueTurn = session.publicState.currentTeam === 'blue' && socket.id === session.bluePlayer;
        const isRedTurn = session.publicState.currentTeam === 'red' && socket.id === session.redPlayer;
        
        if (isBlueTurn || isRedTurn) {
            handleAction(roomId, charId);
        }
    });
});

function createSession(id, hostId, hostName) {
    return {
        id, bluePlayer: hostId, redPlayer: null,
        stepIndex: 0, timer: 60, timerInterval: null,
        publicState: {
            blueName: hostName || 'Player 1', redName: 'Ожидание...',
            currentTeam: 'blue', currentAction: 'ban',
            stepIndex: 0,
            bans: [], bluePicks: [], redPicks: []
        }
    };
}

function handleAction(roomId, charId) {
    const session = sessions[roomId];
    const state = session.publicState;

    // Проверка на дубликаты
    const isUsed = state.bans.some(b => b.id === charId) || 
                   state.bluePicks.includes(charId) || 
                   state.redPicks.includes(charId);
    if (isUsed) return;

    // Запись действия
    if (state.currentAction === 'ban') {
        state.bans.push({ id: charId, team: state.currentTeam });
    } else {
        if (state.currentTeam === 'blue') state.bluePicks.push(charId);
        else state.redPicks.push(charId);
    }

    nextStep(roomId);
}

function nextStep(roomId) {
    const session = sessions[roomId];
    session.stepIndex++;
    
    if (session.stepIndex >= DRAFT_ORDER.length) {
        clearInterval(session.timerInterval);
        io.to(roomId).emit('game_over', session.publicState);
        return;
    }

    const config = DRAFT_ORDER[session.stepIndex];
    session.publicState.currentTeam = config.team;
    session.publicState.currentAction = config.type;
    session.publicState.stepIndex = session.stepIndex;
    
    session.timer = 60;
    io.to(roomId).emit('update_state', session.publicState);
}

function startTimer(roomId) {
    const session = sessions[roomId];
    if (session.timerInterval) clearInterval(session.timerInterval);
    session.timerInterval = setInterval(() => {
        session.timer--;
        io.to(roomId).emit('timer_tick', session.timer);
        if (session.timer <= 0) autoPick(roomId);
    }, 1000);
}

function autoPick(roomId) {
    const session = sessions[roomId];
    // Собираем всех доступных
    let all = [];
    Object.values(CHARS).forEach(arr => all.push(...arr));
    
    // Фильтруем
    const state = session.publicState;
    const available = all.filter(id => 
        !state.bans.some(b => b.id === id) && 
        !state.bluePicks.includes(id) && 
        !state.redPicks.includes(id)
    );

    if (available.length > 0) {
        const randomId = available[Math.floor(Math.random() * available.length)];
        handleAction(roomId, randomId);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server started on :${PORT}`));
