import { UIManager } from './UIManager.js';

const socket = io();
let ui = null;
let currentRoom = null;

// Элементы меню
const lobby = document.getElementById('lobby-screen');
const game = document.getElementById('game-screen');
const nickInput = document.getElementById('nickname-input');
const roomInput = document.getElementById('room-input');

// Кнопки
document.getElementById('btn-create').onclick = () => {
    const nick = nickInput.value;
    if(!nick) return alert('Введите имя!');
    socket.emit('create_game', nick);
};

document.getElementById('btn-join').onclick = () => {
    const nick = nickInput.value;
    const room = roomInput.value;
    if(!nick || !room) return alert('Введите имя и код!');
    socket.emit('join_game', { roomId: room, nickname: nick });
};

// События сокета
socket.on('init_game', ({ roomId, role, state }) => {
    currentRoom = roomId;
    lobby.style.display = 'none';
    game.style.display = 'flex';
    
    ui = new UIManager(socket, roomId);
    
    // Преобразуем данные от сервера для отрисовки пула
    // Сервер (из шага 1) не шлет списки персонажей в init_game, надо добавить!
    // Или мы используем локальные данные из Data.js? 
    // В Data.js у нас только иконки. Нам нужно знать, кто в 'cryo'.
    // Давайте возьмем структуру из Data.js (она там уже есть в ключах).
    
    // ВАЖНОЕ ИСПРАВЛЕНИЕ: Чтобы пул рисовался корректно, нужно знать списки ID по стихиям.
    // Я добавлю hardcoded списки в App.js для надежности, так как server.js мы уже написали.
    
    const CHARS_MAP = {
        cryo: ['ganyu', 'diona', 'kaeya', 'chongyun', 'ayaka', 'eula', 'shenhe', 'qiqi', 'layla', 'charlotte', 'wriothesley', 'freminet', 'rosaria', 'citlali', 'signora', 'cryocicin', 'cryohypo', 'operative', 'skirk', 'escofier'],
        hydro: ['barbara', 'xingqiu', 'mona', 'tartaglia', 'kokomi', 'ayato', 'candace', 'nilou', 'yelan', 'neuvillette', 'furina', 'sigewinne', 'mualani', 'rhodeia', 'mirror', 'herald', 'narwhal', 'hilichurlrogue', 'hydrotulpa', 'crocodile'],
        pyro: ['diluc', 'xiangling', 'bennett', 'amber', 'yoimiya', 'klee', 'hutao', 'yanfei', 'dehya', 'lyney', 'thoma', 'xinyan', 'chevreuse', 'arlecchino', 'mavuika', 'gaming', 'pyroagent', 'pyrolector', 'babel', 'crab', 'gosoytot'],
        electro: ['fischl', 'razor', 'keqing', 'cyno', 'beidou', 'sara', 'raiden', 'yaemiko', 'lisa', 'dori', 'kuki', 'clorinde', 'sethos', 'iansan', 'varesa', 'ororon', 'electrohypo', 'manifestation', 'seahorse', 'electrocicin', 'scorpion', 'electrolector'],
        anemo: ['sucrose', 'jean', 'venti', 'xiao', 'kazuha', 'wanderer', 'sayu', 'lynette', 'faruzan', 'xianyun', 'chasca', 'lanyan', 'heizou', 'mizuki', 'ifa', 'kenki', 'dvalin', 'serpent'],
        geo: ['ningguang', 'noelle', 'zhongli', 'albedo', 'itto', 'gorou', 'yunjin', 'navia', 'chiori', 'kachina', 'xilonen', 'lawachurl', 'azhdaha', 'wolflord', 'knight'],
        dendro: ['collei', 'tighnari', 'nahida', 'yaoyao', 'baizhu', 'alhaitham', 'kirara', 'kaveh', 'kinich', 'emilie', 'shroom', 'apep', 'dancer', 'king']
    };

    ui.initPool(CHARS_MAP, roomId);
    ui.renderGame(state);
    ui.updatePoolStatus(state);
});

socket.on('update_state', (state) => {
    if(ui) {
        ui.renderGame(state);
        ui.updatePoolStatus(state);
    }
});

socket.on('timer_tick', (t) => {
    document.getElementById('timer').innerText = t;
});

socket.on('game_over', (state) => {
    document.getElementById('status').innerText = "ДРАФТ ЗАВЕРШЕН";
    document.getElementById('status').style.color = '#d4af37';
});
