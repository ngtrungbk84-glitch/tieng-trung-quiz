// 3. Xử lý Trả lời
  socket.on('submitAnswer', (answer) => {
    const room = rooms[socket.roomId];
    if (!room || !room.isStarted) return;

    const activePlayer = room.players[room.currentTurnIndex];
    if (!activePlayer || activePlayer.name !== socket.username) return;

    const currentQ = questionsData[room.lesson] ? questionsData[room.lesson][room.currentQuestionIndex] : null;
    if (!currentQ) return;

    let isCorrect = false;

    // Chuẩn hóa so sánh chuỗi (không phân biệt hoa/thường)
    const userAns = String(answer).trim().toLowerCase();
    const correctAns = String(currentQ.answer).trim().toLowerCase();

    isCorrect = (userAns === correctAns);

    if (isCorrect) {
      room.scores[socket.username] = (room.scores[socket.username] || 0) + 10;
      io.to(room.id).emit('roundResult', {
        winner: socket.username,
        correctIndex: currentQ.answer,
        matchScores: room.scores
      });
      setTimeout(() => { nextQuestion(room); }, 1500);
    } else {
      room.scores[socket.username] = Math.max(0, (room.scores[socket.username] || 0) - 5);
      io.to(room.id).emit('wrongAnswer', {
        index: answer,
        msg: `❌ ${socket.username} trả lời chưa chính xác! (-5đ)`
      });
      switchTurn(room);
    }
  });
