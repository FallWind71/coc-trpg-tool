const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DB_FILE = path.join(__dirname, 'db.json');

let gameState = {
    users: {}, 
    logs: []
};

// 加载数据
if (fs.existsSync(DB_FILE)) {
    try {
        const raw = fs.readFileSync(DB_FILE);
        gameState = JSON.parse(raw);
        for(let u in gameState.users) {
            gameState.users[u].active = false;
        }
    } catch (e) {
        console.error('读取存档失败，重置数据');
    }
}

const saveState = () => {
    fs.writeFileSync(DB_FILE, JSON.stringify(gameState, null, 2));
};

const addLog = (user, charName, msg, type = 'info') => {
    const logEntry = {
        time: new Date().toLocaleTimeString(),
        user,
        charName,
        msg,
        type 
    };
    gameState.logs.push(logEntry);
    if (gameState.logs.length > 200) gameState.logs.shift();
    saveState();
    io.emit('log_update', logEntry);
};

app.use(express.static('public'));

io.on('connection', (socket) => {
    // --- 基础连接与管理 ---
    socket.on('login', (username) => {
        socket.username = username;
        if (!gameState.users[username]) {
            gameState.users[username] = { sheets: {}, currentSheetId: null, active: true, socketId: socket.id };
        } else {
            gameState.users[username].active = true;
            gameState.users[username].socketId = socket.id;
        }
        saveState();
        socket.emit('init_state', gameState);
        io.emit('users_update', gameState.users);
        addLog('System', '', `${username} 上线了。`);
    });

    socket.on('upload_sheet', (sheetData) => {
        if (!socket.username) return;
        const user = gameState.users[socket.username];
        const sheetId = sheetData.info.id || Date.now().toString();
        // 补全可能缺失的字段
        if(!sheetData.background) sheetData.background = {};
        if(!sheetData.weapons) sheetData.weapons = [];
        if(!sheetData.equips) sheetData.equips = [];
        
        user.sheets[sheetId] = sheetData;
        user.currentSheetId = sheetId;
        saveState();
        io.emit('users_update', gameState.users);
        addLog(socket.username, sheetData.info.first_name, `导入了新调查员卡。`);
    });

    socket.on('switch_sheet', (sheetId) => {
        if (!socket.username) return;
        const user = gameState.users[socket.username];
        if(user.sheets[sheetId]) {
            user.currentSheetId = sheetId;
            saveState();
            io.emit('users_update', gameState.users);
        }
    });

    socket.on('delete_sheet', (sheetId) => {
        if (!socket.username) return;
        const user = gameState.users[socket.username];
        if(user.sheets[sheetId]) {
            delete user.sheets[sheetId];
            if(user.currentSheetId === sheetId) user.currentSheetId = Object.keys(user.sheets)[0] || null;
            saveState();
            io.emit('users_update', gameState.users);
        }
    });

    // --- 数据更新接口 (HP, Background, Items) ---
    socket.on('update_data', ({ type, data }) => {
        if (!socket.username) return;
        const user = gameState.users[socket.username];
        if(!user.currentSheetId) return;
        const sheet = user.sheets[user.currentSheetId];

        if (type === 'attr') {
            // data: { key: 'hp', value: 12 }
            sheet.attr[data.key] = data.value;
        } else if (type === 'background') {
            // data: { key: 'personalDescription', value: '...' }
            sheet.background[data.key] = data.value;
        } else if (type === 'items') {
            // data: { weapons: [...], equips: [...] }
            sheet.weapons = data.weapons;
            sheet.equips = data.equips;
        }

        saveState();
        io.emit('users_update', gameState.users); // 实时同步
    });

    // --- 技能检定 (支持奖励/惩罚骰) ---
    socket.on('roll_check', ({ skillName, targetValue, isAttr, bpLevel }) => {
        // bpLevel: 0=正常, 1=奖励1, 2=奖励2, -1=惩罚1, -2=惩罚2
        if (!socket.username) return;
        const user = gameState.users[socket.username];
        if(!user.currentSheetId) return;
        const sheet = user.sheets[user.currentSheetId];
        const charName = sheet.info.first_name;

        // 计算带奖励/惩罚的骰点
        const { finalRoll, detailStr } = rollDiceWithBP(bpLevel || 0);

        let resultLevel = getCoCResult(finalRoll, targetValue);
        let canGrow = false;

        if (['大成功', '极难成功', '困难成功', '成功'].includes(resultLevel) && !isAttr) {
            canGrow = true;
            markSkillGrowth(user, skillName);
        }

        // 动画触发 (注意：前端会根据 resultLevel 决定最终颜色，但初始是未知的)
        io.emit('trigger_roll_anim', { 
            user: socket.username, 
            charName, 
            skill: skillName, 
            roll: finalRoll, 
            result: resultLevel 
        });

        setTimeout(() => {
            let bpText = "";
            if (bpLevel > 0) bpText = `[奖励${bpLevel}]`;
            if (bpLevel < 0) bpText = `[惩罚${Math.abs(bpLevel)}]`;

            const msg = `进行 <b>${skillName}(${targetValue})</b> ${bpText}: ${detailStr} 🎲<b>${finalRoll}</b> -> <span class="res-${resultLevel}">${resultLevel}</span>`;
            addLog(socket.username, charName, msg, resultLevel.includes('成功') ? 'success' : 'failure');
            
            if(canGrow) {
                 io.emit('users_update', gameState.users);
                 saveState();
            }
        }, 2000); // 动画时长增加以制造悬念
    });

    // --- 通用投骰 (2d6+1 等) ---
    socket.on('generic_roll', ({ expression }) => {
        if (!socket.username) return;
        const user = gameState.users[socket.username];
        const charName = user.currentSheetId ? user.sheets[user.currentSheetId].info.first_name : 'User';

        try {
            const { total, detail } = parseGenericDice(expression);
            
            // 触发动画 (Result 设为 Total，颜色设为中性)
            io.emit('trigger_roll_anim', { 
                user: socket.username, 
                charName, 
                skill: "Roll", 
                roll: total, 
                result: "Result", // 特殊标记，前端不显示成功失败
                isGeneric: true 
            });

            setTimeout(() => {
                const msg = `投掷 <b>${expression}</b>: ${detail} = <b>${total}</b>`;
                addLog(socket.username, charName, msg, 'info');
            }, 2000);

        } catch (e) {
            socket.emit('toast', '骰子公式错误');
        }
    });

    // --- SAN Check ---
    socket.on('san_check', ({ currentSan, successExpr, failExpr }) => {
        if (!socket.username) return;
        const user = gameState.users[socket.username];
        const sheet = user.sheets[user.currentSheetId];
        
        const roll = Math.floor(Math.random() * 100) + 1;
        const isSuccess = roll <= currentSan;
        const resultStr = isSuccess ? "成功" : "失败";
        const rollResultStr = isSuccess ? successExpr : failExpr;
        
        // 解析通用骰子公式
        const { total: lost } = parseGenericDice(rollResultStr);
        
        sheet.attr.san = parseInt(sheet.attr.san) - lost;

        io.emit('trigger_roll_anim', { user: socket.username, charName: sheet.info.first_name, skill: "SAN Check", roll, result: resultStr });

        setTimeout(() => {
            const msg = `SC(当前${currentSan}): 🎲${roll} [${resultStr}]。 损失 ${rollResultStr} => <b>-${lost}</b> 点SAN。剩余: ${sheet.attr.san}`;
            addLog(socket.username, sheet.info.first_name, msg, 'san');
            saveState();
            io.emit('users_update', gameState.users);
        }, 2000);
    });

    // --- 成长与清理 ---
    socket.on('execute_growth', () => {
        if (!socket.username) return;
        const user = gameState.users[socket.username];
        const sheet = user.sheets[user.currentSheetId];
        if(!sheet) return;

        let growthLog = [];
        sheet.skills.forEach(group => {
            group.forEach(skill => {
                if(skill.marked) {
                    const roll = Math.floor(Math.random() * 100) + 1;
                    let gained = 0;
                    let currentVal = parseInt(skill.desc) || 0; 
                    if (roll > currentVal || roll > 95) {
                        gained = Math.floor(Math.random() * 10) + 1;
                        skill.desc = currentVal + gained;
                        growthLog.push(`${skill.name}: 🎲${roll}(> ${currentVal}) 成长 +${gained} => ${skill.desc}`);
                    } else {
                        growthLog.push(`${skill.name}: 🎲${roll} (未成长)`);
                    }
                    skill.marked = false;
                }
            });
        });

        if (growthLog.length > 0) {
            addLog(socket.username, sheet.info.first_name, "执行幕间成长:<br>" + growthLog.join('<br>'), 'grow');
            saveState();
            io.emit('users_update', gameState.users);
        }
    });

    socket.on('clear_logs', () => {
        gameState.logs = [];
        saveState();
        io.emit('logs_cleared');
        addLog('System', '', '日志已被清除。');
    });

    socket.on('disconnect', () => {
        if (socket.username && gameState.users[socket.username]) {
            gameState.users[socket.username].active = false;
            io.emit('users_update', gameState.users);
        }
    });
});

// --- 辅助函数 ---

// CoC 7版 判定逻辑
function getCoCResult(roll, target) {
    if (roll === 1) return '大成功';
    if (roll <= Math.floor(target / 5)) return '极难成功';
    if (roll <= Math.floor(target / 2)) return '困难成功';
    if (roll <= target) return '成功';
    if (roll >= 96 && target < 50) return '大失败';
    if (roll === 100 && target >= 50) return '大失败';
    return '失败';
}

// 奖励/惩罚骰计算
function rollDiceWithBP(bpLevel) {
    // 0: normal, >0: bonus, <0: penalty
    const units = Math.floor(Math.random() * 10); // 个位 0-9
    const tensMain = Math.floor(Math.random() * 10); // 十位 0-9
    
    let tensList = [tensMain];
    // 投掷额外的十位
    const count = Math.abs(bpLevel);
    for(let i=0; i<count; i++) {
        tensList.push(Math.floor(Math.random() * 10));
    }

    let possibleRolls = tensList.map(t => {
        let val = t * 10 + units;
        if (val === 0) val = 100; // 00 0 => 100
        return val;
    });

    let finalRoll = possibleRolls[0];
    if (bpLevel > 0) {
        finalRoll = Math.min(...possibleRolls); // 奖励骰取最小
    } else if (bpLevel < 0) {
        finalRoll = Math.max(...possibleRolls); // 惩罚骰取最大
    }

    // 格式化输出: "85[50, 80]"
    const detailStr = `[${possibleRolls.join(', ')}]`;
    
    return { finalRoll, detailStr };
}

// 通用骰子解析 (支持 1d100, 2d6+3, 1d4+1d4)
function parseGenericDice(expr) {
    // 移除空格，统一小写
    expr = expr.replace(/\s/g, '').toLowerCase();
    
    // 分割加号 (暂不支持减号作为运算符，只支持加法连接，如 1d4+1d6)
    // 如果需要支持 1d6-1，逻辑会稍微复杂点，这里简化处理 + 
    const parts = expr.split('+');
    let total = 0;
    let details = [];

    parts.forEach(part => {
        if (part.includes('d')) {
            const [numStr, faceStr] = part.split('d');
            const num = numStr === '' ? 1 : parseInt(numStr) || 1;
            const face = parseInt(faceStr) || 6;
            let subTotal = 0;
            let subRolls = [];
            for(let i=0; i<num; i++) {
                const r = Math.floor(Math.random() * face) + 1;
                subTotal += r;
                subRolls.push(r);
            }
            total += subTotal;
            if(num > 1) details.push(`(${subRolls.join(',')})`);
            else details.push(subTotal);
        } else {
            // 固定数值
            const val = parseInt(part) || 0;
            total += val;
            details.push(val);
        }
    });

    return { total, detail: details.join('+') };
}

function markSkillGrowth(user, skillName) {
    const sheet = user.sheets[user.currentSheetId];
    if(!sheet) return;
    sheet.skills.forEach(group => {
        group.forEach(skill => {
            if(skill.name === skillName) skill.marked = true;
        });
    });
}

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
