const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Phục vụ file tĩnh từ thư mục hiện tại
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Đọc file câu hỏi
let questionsData = [];
try {
  const rawData = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');
  questionsData = JSON.parse(rawData);
} catch (err) {
  console.error("Lỗi đọc file questions.json:", err);
}

// Quản lý phòng chơi và hàng chờ
let waitingPlayer = null;
const rooms = {};

// Hàm xáo trộn mảng
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ------------------- SOCKET ENGINE -------------------
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Tìm trận đấu
  socket.on('find_match', (data) => {
    const playerName = data.name || 'Người chơi';

    if (waitingPlayer && waitingPlayer.id !== socket.id) {
      // Ghép cặp thành công
      const roomId = `room_${waitingPlayer.id}_${socket.id}`;
      const player1 = waitingPlayer;
      const player2 = { id: socket.id, name: playerName };

      // Chọn ngẫu nhiên 5 câu hỏi cho trận đấu
      const selectedQuestions = shuffleArray(questionsData).slice(0, 5);

      rooms[roomId] = {
        players: {
          [player1.id]: { name: player1.name, score: 0, answered: false },
          [player2.id]: { name: player2.name, score: 0, answered: false }
        },
        questions: selectedQuestions,
        currentQuestionIndex: 0,
        timer: null
      };

      player1.socket.join(roomId);
      socket.join(roomId);

      waitingPlayer = null;

      // Bắt đầu game
      io.to(roomId).emit('match_found', {
        roomId: roomId,
        players: rooms[roomId].players
      });

      sendQuestion(roomId);
    } else {
      // Đưa vào hàng chờ
      waitingPlayer = { id: socket.id, name: playerName, socket: socket };
      socket.emit('waiting_for_match');
    }
  });

  // Xử lý gửi câu hỏi và đếm ngược
  function sendQuestion(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.currentQuestionIndex >= room.questions.length) {
      // Hết câu hỏi -> Kết thúc game
      endGame(roomId);
      return;
    }

    // Reset trạng thái trả lời của người chơi
    Object.keys(room.players).forEach(pId => {
      room.players[pId].answered = false;
    });

    const q = room.questions[room.currentQuestionIndex];

    io.to(roomId).emit('next_question', {
      questionIndex: room.currentQuestionIndex + 1,
      totalQuestions: room.questions.length,
      type: q.type || 'General',
      question: q.question,
      options: q.options
    });

    // Đếm ngược 15s
    let timeLeft = 15;
    clearInterval(room.timer);
    room.timer = setInterval(() => {
      io.to(roomId).emit('timer_update', { timeLeft });
      timeLeft--;

      if (timeLeft < 0) {
        clearInterval(room.timer);
        // Hết giờ -> Chuyển câu kế tiếp
        nextQuestionStep(roomId);
      }
    }, 1000);
  }

  // Xử lý khi người chơi chọn đáp án
  socket.on('submit_answer', ({ roomId, answer }) => {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players[socket.id];
    if (!player || player.answered) return;

    player.answered = true;
    const q = room.questions[room.currentQuestionIndex];
    const isCorrect = answer === q.answer;

    if (isCorrect) {
      player.score += 10;
    }

    // Thông báo cho riêng người chơi kết quả câu đó
    socket.emit('answer_result', {
      isCorrect,
      correctAnswer: q.answer,
      explanation: q.explanation
    });

    // Cập nhật điểm cho toàn phòng
    io.to(roomId).emit('update_scores', room.players);

    // Nếu cả 2 đều đã trả lời -> Chuyển câu tiếp theo luôn
    const allAnswered = Object.values(room.players).every(p => p.answered);
    if (allAnswered) {
      clearInterval(room.timer);
      setTimeout(() => {
        nextQuestionStep(roomId);
      }, 1500);
    }
  });

  function nextQuestionStep(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.currentQuestionIndex++;
    sendQuestion(roomId);
  }

  function endGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    clearInterval(room.timer);

    io.to(roomId).emit('game_over', {
      players: room.players
    });

    delete rooms[roomId];
  }

  // Ngắt kết nối
  socket.on('disconnect', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) {
      waitingPlayer = null;
    }

    // Tìm xem socket thuộc phòng nào để xử lý ngắt kết nối
    Object.keys(rooms).forEach(roomId => {
      const room = rooms[roomId];
      if (room.players[socket.id]) {
        clearInterval(room.timer);
        io.to(roomId).emit('player_disconnected', { id: socket.id });
        delete rooms[roomId];
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
