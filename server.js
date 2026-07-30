// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const GOOGLE_SHEET_URL = "https://script.google.com/macros/s/AKfycbwzhd1IGWLGPs7gUe6tYf4bC5X6xUajAFwEJGH29LU9viXuV2zXvCTfEPaL_1WL8xDZmw/exec";
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

let usersData = {};

async function loadUserDataFromSheet() {
  try {
    const res = await fetch(GOOGLE_SHEET_URL, { redirect: "follow" });
    const text = await res.text();
    usersData = JSON.parse(text);
    console.log("✅ Đã tải dữ liệu từ Google Sheets thành công!");
  } catch (e) {
    console.error("❌ Lỗi khi tải dữ liệu từ Google Sheets:", e.message);
    usersData = {};
  }
}

async function saveUserData() {
  try {
    await fetch(GOOGLE_SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(usersData),
      redirect: "follow"
    });
    console.log("💾 Đã lưu dữ liệu lên Google Sheets thành công!");
  } catch (e) {
    console.error("❌ Lỗi khi lưu lên Google Sheets:", e.message);
  }
}

loadUserDataFromSheet();

function getQuestionsByLesson(lesson) {
  if (fs.existsSync(QUESTIONS_FILE)) {
    try {
      const allQ = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
      return allQ[lesson] || allQ["1"] || [];
    } catch (e) { return []; }
  }
  return [];
}

function getRank(exp) {
  if (exp >= 500) return "🐉 HSK Master";
  if (exp >= 200) return "🥇 Cao thủ HSK";
  if (exp >= 100) return "🥈 Trung cấp";
  if (exp >= 30)  return "🥉 Sơ cấp";
  return "🌱 Tân thủ";
}

function getBasePoints(lesson) {
  let l = parseInt(lesson) || 1;
  return 10 + (l - 1) * 5;
}

function getBotModePoints(lesson, botLevel) {
  let base = getBasePoints(lesson);
  if (botLevel === 'easy') return Math.round(base * 0.5);
  if (botLevel === 'hard') return Math.round(base * 1.5);
  return base;
}

let roomCounter = 5;
let rooms = {};

for (let i = 1; i <= 5; i++) {
  createRoomObject(`Bàn ${i}`, 1);
}

function createRoomObject(roomId, lesson = 1) {
  rooms[roomId] = {
    id: roomId,
    lesson: lesson,
    players: [],
    currentQ: 0,
    matchScores: {},
    answered: false,
    isPractice: false,
    botLevel: 'medium',
    botTimer: null,
    questions: getQuestionsByLesson(lesson)
  };
}

function getPublicRooms() {
  let list = [];
  for (let id in rooms) {
    if (!rooms[id].isPractice) {
      list.push({
        id: id,
        lesson: rooms[id].lesson,
        playerCount: rooms[id].players.length,
        players: rooms[id].players.map(p => p.username)
      });
    }
  }
  return list;
}

function getLeaderboard() {
  return Object.keys(usersData)
    .map(name => ({
      username: name,
      exp: usersData[name].exp || 0,
      wins: usersData[name].wins || 0,
      rank: getRank(usersData[name].exp || 0)
    }))
    .sort((a, b) => b.exp - a.exp)
    .slice(0, 10);
}

function scheduleBotAnswer(roomId) {
  let room = rooms[roomId];
  if (!room || !room.isPractice) return;

  let delay = 6000;
  let level = room.botLevel || 'medium';

  if (level === 'easy') {
    delay = Math.floor(Math.random() * 6000) + 8000;
  } else if (level === 'hard') {
    delay = Math.floor(Math.random() * 1500) + 2500;
  } else {
    delay = Math.floor(Math.random() * 3000) + 5000;
  }

  room.botTimer = setTimeout(() => {
    if (!room || room.answered) return;

    room.answered = true;
    let botName = `🤖 Bot HSK (${level.toUpperCase()})`;
    let q = room.questions[room.currentQ];

    let points = getBotModePoints(room.lesson, level);
    room.matchScores[botName] = (room.matchScores[botName] || 0) + points;

    io.to(roomId).emit('roundResult', { 
      winner: botName, 
      matchScores: room.matchScores,
      correctIndex: q ? q.answer : 0
    });

    setTimeout(() => {
      room.currentQ++;
      if (room.currentQ < room.questions.length) {
        room.answered = false;
        io.to(roomId).emit('nextQuestion', room.questions[room.currentQ]);
        scheduleBotAnswer(roomId);
      } else {
        finishPracticeGame(roomId);
      }
    }, 1500);
  }, delay);
}

async function finishPracticeGame(roomId) {
  let room = rooms[roomId];
  if (!room) return;

  let botName = Object.keys(room.matchScores).find(name => name.startsWith("🤖 Bot HSK"));
  let humanPlayer = room.players.find(p => p.username !== botName);
  let winnerName = "Hòa";

  if (humanPlayer && usersData[humanPlayer.username]) {
    let pScore = room.matchScores[humanPlayer.username] || 0;
    let bScore = room.matchScores[botName] || 0;

    if (pScore > bScore) {
      winnerName = humanPlayer.username;
      usersData[humanPlayer.username].wins = (usersData[humanPlayer.username].wins || 0) + 1;
    } else if (bScore > pScore) {
      winnerName = botName;
    }
    await saveUserData();
  }

  io.to(roomId).emit('gameOver', { winner: winnerName });
  io.emit('leaderboardUpdate', getLeaderboard());
  delete rooms[roomId];
}

io.on('connection', (socket) => {
  socket.emit('roomListUpdate', getPublicRooms());
  socket.emit('leaderboardUpdate', getLeaderboard());

  socket.on('joinPractice', ({ username, lesson, botLevel }) => {
    if (!username) return;

    socket.username = username;
    let practiceRoomId = `Luyện Tập - ${socket.id.substring(0, 4)}`;
    socket.roomId = practiceRoomId;

    if (!usersData[username]) {
      usersData[username] = { exp: 0, wins: 0 };
      saveUserData();
    }

    let selectedLevel = botLevel || 'medium';
    let botName = `🤖 Bot HSK (${selectedLevel.toUpperCase()})`;

    rooms[practiceRoomId] = {
      id: practiceRoomId,
      lesson: lesson || 1,
      players: [socket, { username: botName }],
      currentQ: 0,
      matchScores: { [username]: 0, [botName]: 0 },
      answered: false,
      isPractice: true,
      botLevel: selectedLevel,
      questions: getQuestionsByLesson(lesson || 1)
    };

    socket.join(practiceRoomId);

    let rankLabel = selectedLevel === 'easy' ? '🟢 Dễ' : selectedLevel === 'hard' ? '🔴 Khó' : '🟡 Vừa';

    socket.emit('gameStart', {
      roomId: practiceRoomId,
      lesson: lesson || 1,
      players: [
        { name: username, rank: getRank(usersData[username].exp || 0) },
        { name: botName, rank: `AI ${rankLabel}` }
      ],
      question: rooms[practiceRoomId].questions[0]
    });

    scheduleBotAnswer(practiceRoomId);
  });

  socket.on('createNewRoom', (selectedLesson) => {
    if (Object.keys(rooms).length >= 10) {
      socket.emit('notice', 'Sảnh đã đạt giới hạn tối đa 10 bàn!');
      return;
    }
    roomCounter++;
    let newRoomId = `Bàn ${roomCounter}`;
    createRoomObject(newRoomId, selectedLesson || 1);
    io.emit('roomListUpdate', getPublicRooms());
  });

  socket.on('changeRoomLesson', ({ roomId, lesson }) => {
    if (rooms[roomId] && rooms[roomId].players.length < 2) {
      rooms[roomId].lesson = lesson;
      rooms[roomId].questions = getQuestionsByLesson(lesson);
      io.emit('roomListUpdate', getPublicRooms());
      io.to(roomId).emit('lessonUpdated', lesson);
    }
  });

  socket.on('joinRoom', ({ username, roomId }) => {
    if (!username) return;
    socket.username = username;
    socket.roomId = roomId;

    if (!usersData[username]) {
      usersData[username] = { exp: 0, wins: 0 };
      saveUserData();
    }

    let room = rooms[roomId];
    if (!room) return socket.emit('waiting', 'Bàn không tồn tại!');
    if (room.players.length >= 2) return socket.emit('waiting', `Bàn [${roomId}] đã đầy!`);

    socket.join(roomId);
    room.players.push(socket);
    room.matchScores[username] = 0;

    io.emit('roomListUpdate', getPublicRooms());

    if (room.players.length === 2) {
      room.currentQ = 0;
      room.answered = false;
      io.to(roomId).emit('gameStart', {
        roomId: roomId,
        lesson: room.lesson,
        players: room.players.map(p => ({
          name: p.username,
          rank: getRank(usersData[p.username]?.exp || 0)
        })),
        question: room.questions[room.currentQ]
      });
    } else {
      socket.emit('waitingState', { roomId: roomId, lesson: room.lesson });
    }
  });

  socket.on('leaveRoom', () => {
    let roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      if (rooms[roomId].botTimer) clearTimeout(rooms[roomId].botTimer);
      socket.leave(roomId);
      rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
      socket.roomId = null;
      io.emit('roomListUpdate', getPublicRooms());
      socket.emit('leftRoomSuccess');
    }
  });

  socket.on('submitAnswer', async (optionIndex) => {
    let roomId = socket.roomId;
    let room = rooms[roomId];
    if (!room || room.answered) return;

    let q = room.questions[room.currentQ];

    if (optionIndex === q.answer) {
      room.answered = true;
      if (room.botTimer) clearTimeout(room.botTimer);

      let pointsEarned = 0;

      if (room.isPractice) {
        pointsEarned = getBotModePoints(room.lesson, room.botLevel);
        room.matchScores[socket.username] = (room.matchScores[socket.username] || 0) + pointsEarned;
        
        if (usersData[socket.username]) {
          usersData[socket.username].exp = (usersData[socket.username].exp || 0) + pointsEarned;
        }
      } else {
        pointsEarned = getBasePoints(room.lesson);

        room.matchScores[socket.username] = (room.matchScores[socket.username] || 0) + pointsEarned;
        if (usersData[socket.username]) {
          usersData[socket.username].exp = (usersData[socket.username].exp || 0) + pointsEarned;
        }

        let otherPlayer = room.players.find(p => p.username !== socket.username);
        if (otherPlayer && usersData[otherPlayer.username]) {
          let oldExp = usersData[otherPlayer.username].exp || 0;
          let actualDeduct = Math.min(oldExp, pointsEarned);
          usersData[otherPlayer.username].exp = oldExp - actualDeduct;

          let oldMatchScore = room.matchScores[otherPlayer.username] || 0;
          room.matchScores[otherPlayer.username] = Math.max(0, oldMatchScore - pointsEarned);
        }
      }

      await saveUserData();
      io.emit('leaderboardUpdate', getLeaderboard());

      // Gửi về thông tin correctIndex để đổi màu XANH
      io.to(roomId).emit('roundResult', { 
        winner: socket.username, 
        matchScores: room.matchScores,
        correctIndex: q.answer
      });

      setTimeout(async () => {
        room.currentQ++;
        if (room.currentQ < room.questions.length) {
          room.answered = false;
          io.to(roomId).emit('nextQuestion', room.questions[room.currentQ]);
          if (room.isPractice) scheduleBotAnswer(roomId);
        } else {
          if (room.isPractice) {
            await finishPracticeGame(roomId);
          } else {
            let pNames = room.players.map(p => p.username);
            let p1 = pNames[0], p2 = pNames[1];
            let winnerName = null;

            if (room.matchScores[p1] > room.matchScores[p2]) winnerName = p1;
            else if (room.matchScores[p2] > room.matchScores[p1]) winnerName = p2;

            if (winnerName && usersData[winnerName]) {
              usersData[winnerName].wins = (usersData[winnerName].wins || 0) + 1;
            }

            await saveUserData();

            io.to(roomId).emit('gameOver', { winner: winnerName });
            io.emit('leaderboardUpdate', getLeaderboard());

            createRoomObject(roomId, room.lesson);
            io.emit('roomListUpdate', getPublicRooms());
          }
        }
      }, 1500);
    } else {
      let deductPoints = room.isPractice 
        ? getBotModePoints(room.lesson, room.botLevel) 
        : getBasePoints(room.lesson);

      if (usersData[socket.username]) {
        let oldExp = usersData[socket.username].exp || 0;
        usersData[socket.username].exp = Math.max(0, oldExp - deductPoints);
      }

      let currentScore = room.matchScores[socket.username] || 0;
      room.matchScores[socket.username] = Math.max(0, currentScore - deductPoints);

      await saveUserData();
      io.emit('leaderboardUpdate', getLeaderboard());

      io.to(roomId).emit('roundResult', { winner: null, matchScores: room.matchScores });
      socket.emit('wrongAnswer', `Sai rồi! Bị trừ ${deductPoints} EXP.`);
    }
  });

  socket.on('disconnect', () => {
    let roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      if (rooms[roomId].botTimer) clearTimeout(rooms[roomId].botTimer);
      if (!rooms[roomId].isPractice) {
        io.to(roomId).emit('playerLeft', `${socket.username} đã rời bàn.`);
        createRoomObject(roomId, rooms[roomId].lesson);
        io.emit('roomListUpdate', getPublicRooms());
      } else {
        delete rooms[roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
