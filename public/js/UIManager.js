import { CHAR_URL_BASE, CHAR_ICONS, POOL_STRUCTURE, STEPS } from './Data.js';

export class UIManager {
    constructor(socket, currentRoom) {
        this.socket = socket;
        this.currentRoom = currentRoom;
    }

    renderGame(state) {
        this.updateHeader(state);
        this.renderBoard(state);
        this.renderPool(state);
    }

    updateHeader(state) {
        document.getElementById('blue-name').innerText = state.blueName;
        document.getElementById('red-name').innerText = state.redName;
        const status = document.getElementById('status');
        const team = state.currentTeam === 'blue' ? 'Синие' : 'Красные';
        const action = state.currentAction === 'ban' ? 'БАНЯТЬ' : 'ПИКАЮТ';
        status.innerText = `${team} ${action}`;
        status.style.color = state.currentTeam === 'blue' ? '#4facfe' : '#ff5555';
    }

    renderBoard(state) {
        // Рендер слотов
        this._fillSlots('blue-bans', state.bans.filter(b => b.team === 'blue'), 5, STEPS.blue_ban, true, state);
        this._fillSlots('red-bans', state.bans.filter(b => b.team === 'red'), 5, STEPS.red_ban, true, state);

        this._fillSlots('blue-picks-1', state.bluePicks.slice(0, 5), 5, STEPS.blue_pick.slice(0, 5), false, state);
        this._fillSlots('blue-picks-2', state.bluePicks.slice(5, 9), 4, STEPS.blue_pick.slice(5, 9), false, state);

        this._fillSlots('red-picks-1', state.redPicks.slice(0, 5), 5, STEPS.red_pick.slice(0, 5), false, state);
        this._fillSlots('red-picks-2', state.redPicks.slice(5, 9), 4, STEPS.red_pick.slice(5, 9), false, state);
    }

    _fillSlots(containerId, items, max, steps, isBan, state) {
        const div = document.getElementById(containerId);
        div.innerHTML = '';
        for (let i = 0; i < max; i++) {
            const slot = document.createElement('div');
            slot.className = isBan ? 'slot ban' : 'slot';
            
            // Если занято
            const charId = items[i] ? (items[i].id || items[i]) : null;
            if (charId) {
                const img = document.createElement('img');
                img.src = CHAR_URL_BASE + CHAR_ICONS[charId];
                slot.appendChild(img);
            } else {
                // Если пусто - номер хода
                const step = steps[i];
                if (step) {
                    slot.innerHTML = `<span class="step-num">${step}</span>`;
                    if (state.stepIndex === step) slot.classList.add('active');
                }
            }
            div.appendChild(slot);
        }
    }

    renderPool(state) {
        const createPoolColumn = (containerId, elements) => {
            const container = document.getElementById(containerId);
            if (container.children.length > 0) {
                // Если пул уже отрисован, просто обновляем статус (disabled)
                this._updatePoolStatus(state);
                return;
            }

            elements.forEach(elem => {
                const row = document.createElement('div');
                row.className = `elem-row ${elem}`;
                
                // Получаем ID персонажей из конфига сервера (косвенно, через ключи иконок)
                // Важно: сервер шлет CHARS, но мы можем использовать CHAR_ICONS, так как ключи совпадают
                // Для чистоты, лучше бы сервер прислал структуру, но мы сделаем умно:
                // Мы знаем что в Data.js ключи CHAR_ICONS - это id персонажей.
                // Но нам нужно знать, кто к какой стихии принадлежит.
                // Хак: мы просим сервер прислать список при ините, но пока сделаем ручной рендер через server data.
            });
        };
        // ВАЖНО: Мы перенесли данные о стихиях в server.js, но не передали их в UIManager.
        // Исправим это в App.js
    }

    // Полный рендер пула (вызывается один раз)
    initPool(charsData, roomId) {
        const leftBox = document.getElementById('pool-left');
        const rightBox = document.getElementById('pool-right');
        leftBox.innerHTML = ''; 
        rightBox.innerHTML = '';

        const buildRow = (element) => {
            const row = document.createElement('div');
            row.className = `elem-row ${element}`;
            
            charsData[element].forEach(charId => {
                const btn = document.createElement('div');
                btn.className = 'char-btn';
                btn.id = `btn-${charId}`;
                btn.innerHTML = `<img src="${CHAR_URL_BASE + CHAR_ICONS[charId]}" loading="lazy">`;
                btn.onclick = () => {
                    this.socket.emit('action', { roomId: roomId, charId: charId });
                };
                row.appendChild(btn);
            });
            return row;
        };

        POOL_STRUCTURE.left.forEach(elem => leftBox.appendChild(buildRow(elem)));
        POOL_STRUCTURE.right.forEach(elem => rightBox.appendChild(buildRow(elem)));
    }

    updatePoolStatus(state) {
        document.querySelectorAll('.char-btn').forEach(btn => btn.classList.remove('disabled'));
        
        // Блокируем забаненных
        state.bans.forEach(b => document.getElementById(`btn-${b.id}`)?.classList.add('disabled'));
        // Блокируем пикнутых
        [...state.bluePicks, ...state.redPicks].forEach(id => {
            document.getElementById(`btn-${id}`)?.classList.add('disabled');
        });
    }
}
