const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const HOST_PIN = '6208';

app.use(express.static(path.join(__dirname, 'public')));

// 라우팅
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html'))); // 메인 허브
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html'))); // 대면 빔프로젝터
app.get('/offline', (req, res) => res.sendFile(path.join(__dirname, 'public', 'offline.html'))); // 대면 스마트폰
app.get('/online', (req, res) => res.sendFile(path.join(__dirname, 'public', 'online.html'))); // 비대면 온라인

// 직업 정의
const ROLES = {
  MAFIA_BOSS: { name: '마피아 보스', team: 'MAFIA', icon: '👑', desc: '마피아의 리더입니다. 경찰 조사 시 [시민]으로 위장됩니다.' },
  MAFIA: { name: '마피아', team: 'MAFIA', icon: '🩸', desc: '밤마다 동료들과 비밀 회의를 통해 제거할 시민을 결정합니다.' },
  POLICE: { name: '경찰', team: 'CITIZEN', icon: '🔍', desc: '밤마다 1명을 조사하여 마피아 여부를 즉시 알아냅니다.' },
  DOCTOR: { name: '의사', team: 'CITIZEN', icon: '💉', desc: '밤마다 1명을 지목해 마피아의 습격으로부터 생명을 지킵니다.' },
  DETECTIVE: { name: '사설탐정', team: 'CITIZEN', icon: '🕵️', desc: '밤마다 1명을 감시하여 누구를 방문했는지 동선을 추적합니다.' },
  CITIZEN: { name: '선량한 시민', team: 'CITIZEN', icon: '🧑‍🌾', desc: '특수 능력은 없지만 낮 토론과 투표로 마피아를 찾아냅니다.' },
  MODERATOR: { name: '사회자(진행/관전)', team: 'SPECTATOR', icon: '🎙️', desc: '게임에 직접 참여하지 않고 전체 진행 및 관전을 총괄합니다.' }
};

// 5~35인 황금 직업 밸런스 공식
function getAutoRoleDeck(total) {
  total = Math.max(5, Math.min(35, total));
  let mafia = 1, police = 1, doctor = 1, detective = 0;

  if (total <= 6) {
    mafia = 1; police = 1; doctor = 1; detective = 0;
  } else if (total <= 9) {
    mafia = 2; police = 1; doctor = 1; detective = 0;
  } else if (total <= 12) {
    mafia = 3; police = 1; doctor = 1; detective = 1;
  } else if (total <= 15) {
    mafia = 4; police = 2; doctor = 1; detective = 1;
  } else if (total <= 19) {
    mafia = 4; police = 2; doctor = 2; detective = 1;
  } else if (total <= 23) {
    mafia = 5; police = 2; doctor = 2; detective = 1;
  } else if (total <= 27) {
    mafia = 6; police = 2; doctor = 2; detective = 1;
  } else if (total <= 31) {
    mafia = 7; police = 2; doctor = 2; detective = 1;
  } else if (total <= 33) {
    mafia = 8; police = 2; doctor = 2; detective = 1;
  } else {
    mafia = 8; police = 3; doctor = 2; detective = 1;
  }
  const citizen = Math.max(1, total - (mafia + police + doctor + detective));
  return { mafia, police, doctor, detective, citizen };
}

// ==============================================================
// [A] 대면 모임용 게임 엔진 (OFFLINE)
// ==============================================================
const offlineState = {
  phase: 'LOBBY',
  round: 1,
  players: [],
  roleDeckConfig: getAutoRoleDeck(5),
  timerSeconds: 0,
  timerInterval: null,
  nominationVotes: {},
  trialCandidate: null,
  tiedCandidateIds: null,
  isReVote: false,
  verdictVotes: { guilty: 0, innocent: 0, votedSockets: new Set() },
  nightActions: { mafiaVotes: {}, doctorTarget: null, policeTarget: null },
  lastNightReport: null,
  winner: null
};

function cleanupDeadOfflineSockets() {
  if (offlineState.phase !== 'LOBBY') return;
  const activeSockets = io.sockets.sockets;
  offlineState.players = offlineState.players.filter(p => {
    const s = activeSockets.get(p.socketId);
    return s && s.connected;
  });
}

function broadcastOfflineState() {
  cleanupDeadOfflineSockets();
  const count = offlineState.players.length;
  offlineState.roleDeckConfig = getAutoRoleDeck(count >= 5 ? count : 5);

  io.to('room_offline').emit('offline:state_update', {
    phase: offlineState.phase,
    round: offlineState.round,
    playerCount: count,
    roleDeckConfig: offlineState.roleDeckConfig,
    timerSeconds: offlineState.timerSeconds,
    players: offlineState.players.map(p => ({
      id: p.id,
      name: p.name,
      isAlive: p.isAlive,
      deathReason: p.deathReason,
      role: offlineState.phase === 'GAME_OVER' ? p.role : null
    })),
    trialCandidate: offlineState.trialCandidate,
    tiedCandidateIds: offlineState.tiedCandidateIds,
    isReVote: offlineState.isReVote,
    nominationVotes: offlineState.nominationVotes,
    verdictVotes: { guilty: offlineState.verdictVotes.guilty, innocent: offlineState.verdictVotes.innocent },
    lastNightReport: offlineState.lastNightReport,
    winner: offlineState.winner
  });
}

function startOfflineTimer(sec, onComplete) {
  clearInterval(offlineState.timerInterval);
  offlineState.timerSeconds = sec;
  io.to('room_offline').emit('offline:timer_tick', offlineState.timerSeconds);

  offlineState.timerInterval = setInterval(() => {
    offlineState.timerSeconds--;
    io.to('room_offline').emit('offline:timer_tick', offlineState.timerSeconds);
    if (offlineState.timerSeconds <= 0) {
      clearInterval(offlineState.timerInterval);
      if (onComplete) onComplete();
    }
  }, 1000);
}

function checkOfflineVictory() {
  const alive = offlineState.players.filter(p => p.isAlive);
  const m = alive.filter(p => p.role && ROLES[p.role]?.team === 'MAFIA');
  const c = alive.filter(p => p.role && ROLES[p.role]?.team === 'CITIZEN');
  if (m.length === 0) return 'CITIZEN';
  if (m.length >= c.length) return 'MAFIA';
  return null;
}

function sendOfflineSecretRoles() {
  offlineState.players.forEach(p => {
    if (!p.socketId) return;
    const roleObj = ROLES[p.role] || ROLES.CITIZEN;
    let teammates = [];
    if (roleObj.team === 'MAFIA') {
      teammates = offlineState.players.filter(tm => tm.id !== p.id && ROLES[tm.role]?.team === 'MAFIA').map(tm => ({ name: tm.name }));
    }
    io.to(p.socketId).emit('offline:secret_role', {
      role: p.role,
      roleName: roleObj.name,
      team: roleObj.team,
      icon: roleObj.icon,
      desc: roleObj.desc,
      teammates: teammates
    });
  });
}

// ==============================================================
// [B] 비대면 온라인용 게임 엔진 (ONLINE)
// ==============================================================
const onlineState = {
  phase: 'LOBBY',
  round: 1,
  players: [], // { token, socketId, id, name, role, isAlive, isHost, isModerator, deathReason }
  roleDeckConfig: getAutoRoleDeck(5),
  timerSeconds: 0,
  timerInterval: null,
  isTimerPaused: false,
  nominationVotes: {},
  trialCandidate: null,
  tiedCandidateIds: null,
  isReVote: false,
  verdictVotes: { guilty: 0, innocent: 0, votedSockets: new Set() },
  nightActions: { mafiaVotes: {}, doctorTarget: null, policeTarget: null },
  lastNightReport: null,
  winner: null
};

function cleanupDeadOnlineSockets() {
  if (onlineState.phase !== 'LOBBY') return;
  const activeSockets = io.sockets.sockets;
  onlineState.players = onlineState.players.filter(p => {
    const s = activeSockets.get(p.socketId);
    return s && s.connected;
  });
  // 1번째 입장자 자동 방장 승격 기능 완전히 제거됨 (비밀번호 입력자만 방장 유지)
}

function broadcastOnlineSystemMsg(text, channel = 'all') {
  const msgObj = {
    id: crypto.randomUUID(),
    sender: '📢 시스템',
    text: text,
    channel: channel,
    isSystem: true,
    time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
  };

  if (channel === 'all') {
    io.to('room_online').emit('online:chat_message', msgObj);
  } else if (channel === 'mafia') {
    onlineState.players.filter(p => ROLES[p.role]?.team === 'MAFIA').forEach(p => {
      io.to(p.socketId).emit('online:chat_message', msgObj);
    });
  } else if (channel === 'dead') {
    onlineState.players.filter(p => !p.isAlive).forEach(p => {
      io.to(p.socketId).emit('online:chat_message', msgObj);
    });
  }
}

function broadcastOnlineState() {
  cleanupDeadOnlineSockets();
  // 사회자(isModerator)를 제외한 실제 게임 참가자 수 기준으로 직업 덱 계산
  const playingCount = onlineState.players.filter(p => !p.isModerator).length;
  onlineState.roleDeckConfig = getAutoRoleDeck(playingCount >= 5 ? playingCount : 5);

  io.to('room_online').emit('online:state_update', {
    phase: onlineState.phase,
    round: onlineState.round,
    playerCount: onlineState.players.length,
    playingCount: playingCount,
    roleDeckConfig: onlineState.roleDeckConfig,
    timerSeconds: onlineState.timerSeconds,
    isTimerPaused: onlineState.isTimerPaused,
    players: onlineState.players.map(p => ({
      id: p.id,
      name: p.name,
      isAlive: p.isAlive,
      isHost: p.isHost,
      isModerator: p.isModerator,
      deathReason: p.deathReason,
      role: onlineState.phase === 'GAME_OVER' || p.isModerator ? p.role : null
    })),
    trialCandidate: onlineState.trialCandidate,
    nominationVotes: onlineState.nominationVotes,
    verdictVotes: { guilty: onlineState.verdictVotes.guilty, innocent: onlineState.verdictVotes.innocent },
    lastNightReport: onlineState.lastNightReport,
    winner: onlineState.winner
  });
}

function startOnlineTimer(sec, onComplete) {
  clearInterval(onlineState.timerInterval);
  onlineState.timerSeconds = sec;
  onlineState.isTimerPaused = false;
  io.to('room_online').emit('online:timer_tick', { seconds: onlineState.timerSeconds, isPaused: false });

  onlineState.timerInterval = setInterval(() => {
    if (!onlineState.isTimerPaused) {
      onlineState.timerSeconds--;
      io.to('room_online').emit('online:timer_tick', { seconds: onlineState.timerSeconds, isPaused: false });
      if (onlineState.timerSeconds <= 0) {
        clearInterval(onlineState.timerInterval);
        if (onComplete) onComplete();
      }
    }
  }, 1000);
}

function checkOnlineVictory() {
  const alivePlaying = onlineState.players.filter(p => p.isAlive && !p.isModerator);
  const m = alivePlaying.filter(p => p.role && ROLES[p.role]?.team === 'MAFIA');
  const c = alivePlaying.filter(p => p.role && ROLES[p.role]?.team === 'CITIZEN');
  if (m.length === 0) return 'CITIZEN';
  if (m.length >= c.length) return 'MAFIA';
  return null;
}

function sendOnlineSecretRoles() {
  onlineState.players.forEach(p => {
    if (!p.socketId) return;

    if (p.isModerator) {
      io.to(p.socketId).emit('online:secret_role', {
        role: 'MODERATOR',
        roleName: '진행 사회자',
        team: 'SPECTATOR',
        icon: '🎙️',
        desc: '게임에 직접 참여하지 않으며, 토론 시간 일시정지, 시간 연장 등 전체 진행을 총괄합니다.',
        teammates: []
      });
      return;
    }

    const roleObj = ROLES[p.role] || ROLES.CITIZEN;
    let teammates = [];
    if (roleObj.team === 'MAFIA') {
      teammates = onlineState.players
        .filter(tm => tm.id !== p.id && !tm.isModerator && ROLES[tm.role]?.team === 'MAFIA')
        .map(tm => ({ name: tm.name }));
    }
    io.to(p.socketId).emit('online:secret_role', {
      role: p.role,
      roleName: roleObj.name,
      team: roleObj.team,
      icon: roleObj.icon,
      desc: roleObj.desc,
      teammates: teammates
    });
  });
}

// ==============================================================
// SOCKET.IO 라우팅 & 이벤트
// ==============================================================
io.on('connection', (socket) => {

  // -------------------------------------------------------------
  // [1] 대면 오프라인 이벤트
  // -------------------------------------------------------------
    // 호스트 전광판 전용 직업 실시간 토글 요청
  socket.on('offline:request_host_roles', () => {
    socket.emit('offline:host_roles', offlineState.players.map(p => ({ id: p.id, role: p.role })));
  });

  socket.on('offline:init', () => {
    socket.join('room_offline');
    broadcastOfflineState();
  });

    socket.on('offline:request_role', () => {
    const p = offlineState.players.find(pl => pl.socketId === socket.id);
    if (!p || !p.role) return;
    const roleObj = ROLES[p.role] || ROLES.CITIZEN;
    let teammates = [];
    if (roleObj.team === 'MAFIA') {
      teammates = offlineState.players.filter(tm => tm.id !== p.id && ROLES[tm.role]?.team === 'MAFIA').map(tm => ({ name: tm.name }));
    }
    socket.emit('offline:secret_role', {
      role: p.role,
      roleName: roleObj.name,
      team: roleObj.team,
      icon: roleObj.icon,
      desc: roleObj.desc,
      teammates: teammates
    });
  });

  socket.on('offline:player_join', ({ name, token }) => {
    socket.join('room_offline');
    cleanupDeadOfflineSockets();
    let cleanName = (name || '').trim();
    if (!cleanName) cleanName = `참가자_${offlineState.players.length + 1}`;

    let existing = offlineState.players.find(p => (token && p.token === token) || p.socketId === socket.id || p.name === cleanName);
    if (existing) {
      existing.socketId = socket.id;
      if (token) existing.token = token;
      socket.emit('offline:joined_success', { token: existing.token, id: existing.id, name: existing.name });
      if (existing.role) sendOfflineSecretRoles();
      broadcastOfflineState();
      return;
    }

    if (offlineState.phase !== 'LOBBY') {
      socket.emit('error_message', '이미 게임이 진행 중입니다. 관전 모드로 접속합니다.');
      return;
    }

    const assignedToken = token || crypto.randomUUID();
    const newPlayer = {
      token: assignedToken,
      socketId: socket.id,
      id: crypto.randomUUID().slice(0, 8),
      name: cleanName,
      role: null,
      isAlive: true,
      deathReason: null
    };

    offlineState.players.push(newPlayer);
    socket.emit('offline:joined_success', { token: newPlayer.token, id: newPlayer.id, name: newPlayer.name });
    broadcastOfflineState();
  });

  socket.on('offline:host_start_game', () => {
    if (offlineState.phase !== 'LOBBY') return;
    cleanupDeadOfflineSockets();
    const total = offlineState.players.length;
    if (total < 5) {
      socket.emit('error_message', `현재 ${total}명입니다. 최소 5명 이상 접속해야 합니다.`);
      return;
    }

    offlineState.roleDeckConfig = getAutoRoleDeck(total);
    const cfg = offlineState.roleDeckConfig;
    const deck = [];
    if (cfg.mafia > 0) {
      deck.push('MAFIA_BOSS');
      for (let i = 0; i < cfg.mafia - 1; i++) deck.push('MAFIA');
    }
    for (let i = 0; i < cfg.police; i++) deck.push('POLICE');
    for (let i = 0; i < cfg.doctor; i++) deck.push('DOCTOR');
    for (let i = 0; i < cfg.detective; i++) deck.push('DETECTIVE');
    while (deck.length < total) deck.push('CITIZEN');

    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    offlineState.players.forEach((p, idx) => {
      p.role = deck[idx] || 'CITIZEN';
      p.isAlive = true;
      p.deathReason = null;
    });

    sendOfflineSecretRoles();
    offlineState.phase = 'FIRST_NIGHT';
    offlineState.round = 1;
    broadcastOfflineState();

    startOfflineTimer(45, () => offlineDayDiscuss());
  });

  function offlineDayDiscuss() {
    offlineState.phase = 'DAY_DISCUSS';
    offlineState.tiedCandidateIds = null;
    offlineState.isReVote = false;
    broadcastOfflineState();
    startOfflineTimer(120, () => offlineNominate());
  }

  function offlineNominate() {
    offlineState.phase = 'DAY_NOMINATE';
    offlineState.nominationVotes = {};
    offlineState.nominationVoters = {};
    broadcastOfflineState();
    startOfflineTimer(30, () => resolveOfflineNominate());
  }

  socket.on('offline:nominate', ({ targetId }) => {
    const voter = offlineState.players.find(p => p.socketId === socket.id);
    if (!voter || !voter.isAlive || offlineState.phase !== 'DAY_NOMINATE') return;
    
    // 유권자 1인당 1표만 인정 (중복 투표 방지)
    if (!offlineState.nominationVoters) offlineState.nominationVoters = {};
    offlineState.nominationVoters[voter.id] = targetId;

    const tally = {};
    Object.values(offlineState.nominationVoters).forEach(tid => {
      tally[tid] = (tally[tid] || 0) + 1;
    });
    offlineState.nominationVotes = tally;
    broadcastOfflineState();
  });

  function resolveOfflineNominate() {
    const alive = offlineState.players.filter(p => p.isAlive);
    const candidatePool = offlineState.tiedCandidateIds
      ? alive.filter(p => offlineState.tiedCandidateIds.includes(p.id))
      : alive;

    let maxV = -1;
    candidatePool.forEach(p => {
      const cnt = offlineState.nominationVotes[p.id] || 0;
      if (cnt > maxV) maxV = cnt;
    });

    let topCandidates = candidatePool.filter(p => (offlineState.nominationVotes[p.id] || 0) === maxV);

    // 동률 발생 검사: 최다 득표자가 2명 이상이고 득표수가 1표 이상인 경우
    if (topCandidates.length > 1 && maxV > 0) {
      offlineState.tiedCandidateIds = topCandidates.map(c => c.id);
      offlineState.nominationVotes = {};
      offlineState.nominationVoters = {};
      offlineState.isReVote = true;
      offlineState.phase = 'DAY_NOMINATE';
      broadcastOfflineState();
      startOfflineTimer(25, () => resolveOfflineNominate());
      return;
    }

    // 단독 1위 확정 시 최후 변론으로 이동
    offlineState.trialCandidate = topCandidates.length === 1 ? topCandidates[0] : candidatePool[0];
    offlineState.tiedCandidateIds = null;
    offlineState.isReVote = false;
    offlineState.phase = 'DAY_TRIAL';
    broadcastOfflineState();
    startOfflineTimer(30, () => offlineVerdict());
  }

  function offlineVerdict() {
    offlineState.phase = 'DAY_VERDICT';
    offlineState.verdictVotes = { guilty: 0, innocent: 0, votedSockets: new Set() };
    broadcastOfflineState();
    startOfflineTimer(15, () => resolveOfflineVerdict());
  }

  socket.on('offline:verdict', ({ vote }) => {
    const voter = offlineState.players.find(p => p.socketId === socket.id);
    if (!voter || !voter.isAlive || offlineState.phase !== 'DAY_VERDICT') return;
    if (offlineState.verdictVotes.votedSockets.has(socket.id)) return;
    offlineState.verdictVotes.votedSockets.add(socket.id);
    if (vote === 'guilty') offlineState.verdictVotes.guilty++;
    else if (vote === 'innocent') offlineState.verdictVotes.innocent++;
    broadcastOfflineState();
  });

  function resolveOfflineVerdict() {
    const aliveCount = offlineState.players.filter(p => p.isAlive).length;
    const isGuilty = offlineState.verdictVotes.guilty > offlineState.verdictVotes.innocent && offlineState.verdictVotes.guilty >= Math.floor(aliveCount / 2);

    if (isGuilty && offlineState.trialCandidate) {
      offlineState.trialCandidate.isAlive = false;
      offlineState.trialCandidate.deathReason = '투표로 처형됨';
    }
    broadcastOfflineState();

    setTimeout(() => {
      const victory = checkOfflineVictory();
      if (victory) {
        offlineState.phase = 'GAME_OVER';
        offlineState.winner = victory;
        broadcastOfflineState();
      } else {
        offlineNight();
      }
    }, 4000);
  }

  function offlineNight() {
    offlineState.phase = 'NIGHT';
    offlineState.nightActions = { mafiaVotes: {}, doctorTarget: null, policeTarget: null };
    broadcastOfflineState();
    startOfflineTimer(40, () => resolveOfflineNight());
  }

  socket.on('offline:night_action', ({ action, targetId }) => {
    const player = offlineState.players.find(p => p.socketId === socket.id);
    if (!player || !player.isAlive || offlineState.phase !== 'NIGHT') return;

    if (action === 'mafia_kill' && ROLES[player.role]?.team === 'MAFIA') {
      offlineState.nightActions.mafiaVotes[targetId] = (offlineState.nightActions.mafiaVotes[targetId] || 0) + 1;
      const mafiaSockets = offlineState.players.filter(p => ROLES[p.role]?.team === 'MAFIA' && p.isAlive).map(p => p.socketId);
      mafiaSockets.forEach(sId => io.to(sId).emit('offline:mafia_sync', offlineState.nightActions.mafiaVotes));
    } else if (action === 'doctor_heal' && player.role === 'DOCTOR') {
      offlineState.nightActions.doctorTarget = targetId;
      socket.emit('action_confirmed', '치료 대상이 설정되었습니다.');
    } else if (action === 'police_check' && player.role === 'POLICE') {
      const target = offlineState.players.find(p => p.id === targetId);
      const isMafia = target && ROLES[target.role]?.team === 'MAFIA' && target.role !== 'MAFIA_BOSS';
      socket.emit('offline:police_result', { targetName: target ? target.name : '알 수 없음', isMafia });
    }
  });

  function resolveOfflineNight() {
    let mafiaTargetId = null, maxV = -1;
    Object.entries(offlineState.nightActions.mafiaVotes).forEach(([id, cnt]) => {
      if (cnt > maxV) { maxV = cnt; mafiaTargetId = id; }
    });

    const doctorSaved = offlineState.nightActions.doctorTarget === mafiaTargetId;
    let victim = null;
    if (mafiaTargetId && !doctorSaved) {
      victim = offlineState.players.find(p => p.id === mafiaTargetId);
      if (victim) {
        victim.isAlive = false;
        victim.deathReason = '마피아의 습격으로 사망';
      }
    }

    offlineState.lastNightReport = { victim, doctorSaved };
    offlineState.round++;
    offlineState.phase = 'MORNING_REPORT';
    broadcastOfflineState();

    const victory = checkOfflineVictory();
    if (victory) {
      setTimeout(() => {
        offlineState.phase = 'GAME_OVER';
        offlineState.winner = victory;
        broadcastOfflineState();
      }, 5000);
    } else {
      // 아침 사건 발표 후 7초 뒤 자동으로 다음 날 낮 토론으로 진행!
      startOfflineTimer(7, () => {
        offlineDayDiscuss();
      });
    }
  }

  socket.on('offline:next_phase', () => {
    clearInterval(offlineState.timerInterval);
    if (offlineState.phase === 'FIRST_NIGHT') offlineDayDiscuss();
    else if (offlineState.phase === 'DAY_DISCUSS') offlineNominate();
    else if (offlineState.phase === 'DAY_NOMINATE') resolveOfflineNominate();
    else if (offlineState.phase === 'DAY_TRIAL') offlineVerdict();
    else if (offlineState.phase === 'DAY_VERDICT') resolveOfflineVerdict();
    else if (offlineState.phase === 'NIGHT') resolveOfflineNight();
    else if (offlineState.phase === 'MORNING_REPORT') offlineDayDiscuss();
  });

  socket.on('offline:reset_game', () => {
    clearInterval(offlineState.timerInterval);
    offlineState.phase = 'LOBBY';
    offlineState.round = 1;
    cleanupDeadOfflineSockets();
    offlineState.players.forEach(p => { p.role = null; p.isAlive = true; p.deathReason = null; });
    offlineState.trialCandidate = null;
    offlineState.tiedCandidateIds = null;
    offlineState.isReVote = false;
    offlineState.nominationVotes = {};
    offlineState.verdictVotes = { guilty: 0, innocent: 0, votedSockets: new Set() };
    offlineState.nightActions = { mafiaVotes: {}, doctorTarget: null, policeTarget: null };
    offlineState.lastNightReport = null;
    offlineState.winner = null;
    io.to('room_offline').emit('offline:player_reset');
    broadcastOfflineState();
  });

  socket.on('offline:cleanup_dead', () => {
    cleanupDeadOfflineSockets();
    broadcastOfflineState();
  });

  socket.on('offline:kick_player', ({ id }) => {
    const idx = offlineState.players.findIndex(p => p.id === id);
    if (idx !== -1) {
      const kicked = offlineState.players.splice(idx, 1)[0];
      if (kicked && kicked.socketId) io.to(kicked.socketId).emit('offline:force_kick');
      broadcastOfflineState();
    }
  });

  socket.on('offline:kick_all', () => {
    clearInterval(offlineState.timerInterval);
    offlineState.phase = 'LOBBY';
    offlineState.round = 1;
    offlineState.players = [];
    io.to('room_offline').emit('offline:force_kick');
    broadcastOfflineState();
  });

  // -------------------------------------------------------------
  // [2] 비대면 온라인 이벤트 (사회자 모드 & 비밀번호 방장 승인)
  // -------------------------------------------------------------
  socket.on('online:init', () => {
    socket.join('room_online');
    broadcastOnlineState();
  });

  socket.on('online:player_join', ({ name, token }) => {
    socket.join('room_online');
    cleanupDeadOnlineSockets();
    let cleanName = (name || '').trim();
    if (!cleanName) cleanName = `참가자_${onlineState.players.length + 1}`;

    let existing = onlineState.players.find(p => (token && p.token === token) || p.socketId === socket.id || p.name === cleanName);
    if (existing) {
      existing.socketId = socket.id;
      if (token) existing.token = token;
      socket.emit('online:joined_success', {
        token: existing.token,
        id: existing.id,
        name: existing.name,
        isHost: existing.isHost,
        isModerator: existing.isModerator
      });
      if (existing.role) sendOnlineSecretRoles();
      broadcastOnlineState();
      return;
    }

    if (onlineState.phase !== 'LOBBY') {
      socket.emit('error_message', '이미 게임이 진행 중입니다. 관전 모드로 입장합니다.');
      return;
    }

    const assignedToken = token || crypto.randomUUID();
    const newPlayer = {
      token: assignedToken,
      socketId: socket.id,
      id: crypto.randomUUID().slice(0, 8),
      name: cleanName,
      role: null,
      isAlive: true,
      isHost: false, // 1번째 입장자 자동 방장 기능 완전 제거 (모두 일반 플레이어로 시작)
      isModerator: false,
      deathReason: null
    };

    onlineState.players.push(newPlayer);
    socket.emit('online:joined_success', {
      token: newPlayer.token,
      id: newPlayer.id,
      name: newPlayer.name,
      isHost: false,
      isModerator: false
    });
    broadcastOnlineSystemMsg(`${cleanName} 님이 입장하셨습니다. (현재 ${onlineState.players.length}명)`);
    broadcastOnlineState();
  });

  // 비밀번호(2146)를 입력해야만 방장 승인
  socket.on('online:claim_host', ({ pin }) => {
    if (pin === HOST_PIN) {
      const p = onlineState.players.find(pl => pl.socketId === socket.id);
      if (p) {
        p.isHost = true;
        socket.emit('online:host_verified', { isHost: true, isModerator: p.isModerator });
        broadcastOnlineSystemMsg(`👑 [${p.name}] 님이 관리자 비밀번호를 인증하여 방장 권한을 획득하셨습니다.`);
        broadcastOnlineState();
      }
    } else {
      socket.emit('error_message', '방장 비밀번호(2146)가 올바르지 않습니다.');
    }
  });

  // 방장의 역할 모드 변경 (사회자/관전 vs 참가자/플레이어)
  socket.on('online:set_host_mode', ({ isModerator }) => {
    const p = onlineState.players.find(pl => pl.socketId === socket.id);
    if (!p || !p.isHost) return;

    p.isModerator = !!isModerator;
    if (p.isModerator) {
      p.role = 'MODERATOR';
      broadcastOnlineSystemMsg(`🎙️ 방장 [${p.name}] 님이 게임에 직접 참여하지 않고 [진행 사회자] 모드를 선택하셨습니다.`);
    } else {
      p.role = null;
      broadcastOnlineSystemMsg(`🎮 방장 [${p.name}] 님이 [일반 참가자]로 직접 게임에 참여합니다.`);
    }
    broadcastOnlineState();
  });

  // 사회자 / 방장 타이머 일시정지 & 재개
  socket.on('online:timer_toggle', () => {
    const p = onlineState.players.find(pl => pl.socketId === socket.id);
    if (!p || !p.isHost) return;

    onlineState.isTimerPaused = !onlineState.isTimerPaused;
    io.to('room_online').emit('online:timer_tick', { seconds: onlineState.timerSeconds, isPaused: onlineState.isTimerPaused });

    if (onlineState.isTimerPaused) {
      broadcastOnlineSystemMsg(`⏸️ 방장(사회자)이 토론 시간을 일시정지했습니다.`);
    } else {
      broadcastOnlineSystemMsg(`▶️ 방장(사회자)이 타이머를 재개했습니다.`);
    }
    broadcastOnlineState();
  });

  // 사회자 / 방장 시간 연장 (+30초, +60초)
  socket.on('online:timer_add', ({ seconds }) => {
    const p = onlineState.players.find(pl => pl.socketId === socket.id);
    if (!p || !p.isHost) return;

    onlineState.timerSeconds += parseInt(seconds) || 30;
    io.to('room_online').emit('online:timer_tick', { seconds: onlineState.timerSeconds, isPaused: onlineState.isTimerPaused });
    broadcastOnlineSystemMsg(`⏱️ 방장(사회자)이 토론 시간을 ${seconds}초 연장했습니다.`);
    broadcastOnlineState();
  });

  // 실시간 다채널 채팅
  socket.on('online:chat_send', ({ text, channel }) => {
    const sender = onlineState.players.find(p => p.socketId === socket.id);
    if (!sender || !text.trim()) return;

    const cleanText = text.trim().slice(0, 150);
    const msgObj = {
      id: crypto.randomUUID(),
      sender: sender.name,
      text: cleanText,
      channel: channel || 'public',
      isSystem: false,
      isHost: sender.isHost,
      isModerator: sender.isModerator,
      time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    };

    if (sender.isModerator) {
      msgObj.sender = `🎙️ [사회자] ${sender.name}`;
      io.to('room_online').emit('online:chat_message', msgObj);
      return;
    }

    if (channel === 'public') {
      if (!sender.isAlive) {
        socket.emit('error_message', '사망자는 유령 관전 채널을 이용해 주세요.');
        return;
      }
      if (onlineState.phase === 'NIGHT') {
        socket.emit('error_message', '밤에는 전체 대화를 할 수 없습니다.');
        return;
      }
      if (onlineState.phase === 'DAY_TRIAL') {
        if (!onlineState.trialCandidate || onlineState.trialCandidate.id !== sender.id) {
          socket.emit('error_message', '최후 변론 중에는 피고인만 발언할 수 있습니다.');
          return;
        }
      }
      io.to('room_online').emit('online:chat_message', msgObj);
    } else if (channel === 'mafia') {
      if (!sender.isAlive || ROLES[sender.role]?.team !== 'MAFIA') return;
      msgObj.sender = `🩸 ${sender.name}`;
      onlineState.players.filter(p => ROLES[p.role]?.team === 'MAFIA').forEach(p => {
        io.to(p.socketId).emit('online:chat_message', msgObj);
      });
    } else if (channel === 'dead') {
      if (sender.isAlive) return;
      msgObj.sender = `👻 ${sender.name}`;
      onlineState.players.filter(p => !p.isAlive).forEach(p => {
        io.to(p.socketId).emit('online:chat_message', msgObj);
      });
    }
  });

  // 게임 시작 (사회자 제외 플레이어 수 기준으로 직업 배분)
  socket.on('online:start_game', () => {
    const sender = onlineState.players.find(p => p.socketId === socket.id);
    if (!sender || !sender.isHost || onlineState.phase !== 'LOBBY') return;
    cleanupDeadOnlineSockets();

    const playingPlayers = onlineState.players.filter(p => !p.isModerator);
    const totalPlaying = playingPlayers.length;

    if (totalPlaying < 5) {
      socket.emit('error_message', `실제 게임 참여 인원이 ${totalPlaying}명입니다. 사회자를 제외하고 최소 5명 이상이어야 시작할 수 있습니다.`);
      return;
    }

    onlineState.roleDeckConfig = getAutoRoleDeck(totalPlaying);
    const cfg = onlineState.roleDeckConfig;
    const deck = [];
    if (cfg.mafia > 0) {
      deck.push('MAFIA_BOSS');
      for (let i = 0; i < cfg.mafia - 1; i++) deck.push('MAFIA');
    }
    for (let i = 0; i < cfg.police; i++) deck.push('POLICE');
    for (let i = 0; i < cfg.doctor; i++) deck.push('DOCTOR');
    for (let i = 0; i < cfg.detective; i++) deck.push('DETECTIVE');
    while (deck.length < totalPlaying) deck.push('CITIZEN');

    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    playingPlayers.forEach((p, idx) => {
      p.role = deck[idx] || 'CITIZEN';
      p.isAlive = true;
      p.deathReason = null;
    });

    sendOnlineSecretRoles();
    onlineState.phase = 'FIRST_NIGHT';
    onlineState.round = 1;
    broadcastOnlineState();

    broadcastOnlineSystemMsg(`🎮 게임이 시작되었습니다! (참가자 ${totalPlaying}인: 마피아 ${cfg.mafia}명, 경찰 ${cfg.police}명, 의사 ${cfg.doctor}명, 탐정 ${cfg.detective}명, 시민 ${cfg.citizen}명)`);
    broadcastOnlineSystemMsg(`🤫 첫째 날 밤입니다. 자신의 비밀 직업을 확인하세요. (45초)`);

    startOnlineTimer(45, () => onlineDayDiscuss());
  });

  function onlineDayDiscuss() {
    onlineState.phase = 'DAY_DISCUSS';
    broadcastOnlineState();
    broadcastOnlineSystemMsg(`☀️ 제 ${onlineState.round}일 차 낮이 밝았습니다. 자유롭게 토론하세요!`);
    startOnlineTimer(120, () => onlineNominate());
  }

  function onlineNominate() {
    onlineState.phase = 'DAY_NOMINATE';
    onlineState.nominationVotes = {};
    onlineState.nominationVoters = {};
    broadcastOnlineState();
    broadcastOnlineSystemMsg(`🗳️ 토론이 종료되었습니다. 처형할 의심 인물을 지목하세요! (30초)`);
    startOnlineTimer(30, () => resolveOnlineNominate());
  }

  socket.on('online:nominate', ({ targetId }) => {
    const voter = onlineState.players.find(p => p.socketId === socket.id);
    if (!voter || !voter.isAlive || voter.isModerator || onlineState.phase !== 'DAY_NOMINATE') return;
    
    // 유권자 1인당 1표만 인정
    if (!onlineState.nominationVoters) onlineState.nominationVoters = {};
    onlineState.nominationVoters[voter.id] = targetId;

    const tally = {};
    Object.values(onlineState.nominationVoters).forEach(tid => {
      tally[tid] = (tally[tid] || 0) + 1;
    });
    onlineState.nominationVotes = tally;
    broadcastOnlineState();
  });

  function resolveOnlineNominate() {
    let topId = null, maxV = -1;
    Object.entries(onlineState.nominationVotes).forEach(([id, cnt]) => {
      if (cnt > maxV) { maxV = cnt; topId = id; }
    });
    const alivePlaying = onlineState.players.filter(p => p.isAlive && !p.isModerator);
    onlineState.trialCandidate = alivePlaying.find(p => p.id === topId) || alivePlaying[0];
    onlineState.phase = 'DAY_TRIAL';
    broadcastOnlineState();
    broadcastOnlineSystemMsg(`⚖️ [${onlineState.trialCandidate.name}] 님의 최후 변론석입니다. 30초간 피고인만 발언할 수 있습니다.`);
    startOnlineTimer(30, () => onlineVerdict());
  }

  function onlineVerdict() {
    onlineState.phase = 'DAY_VERDICT';
    onlineState.verdictVotes = { guilty: 0, innocent: 0, votedSockets: new Set() };
    broadcastOnlineState();
    broadcastOnlineSystemMsg(`🔨 [${onlineState.trialCandidate.name}] 님에 대한 찬반 투표가 시작되었습니다. (15초)`);
    startOnlineTimer(15, () => resolveOnlineVerdict());
  }

  socket.on('online:verdict', ({ vote }) => {
    const voter = onlineState.players.find(p => p.socketId === socket.id);
    if (!voter || !voter.isAlive || voter.isModerator || onlineState.phase !== 'DAY_VERDICT') return;
    if (onlineState.verdictVotes.votedSockets.has(socket.id)) return;
    onlineState.verdictVotes.votedSockets.add(socket.id);
    if (vote === 'guilty') onlineState.verdictVotes.guilty++;
    else if (vote === 'innocent') onlineState.verdictVotes.innocent++;
    broadcastOnlineState();
  });

  function resolveOnlineVerdict() {
    const alivePlaying = onlineState.players.filter(p => p.isAlive && !p.isModerator).length;
    const isGuilty = onlineState.verdictVotes.guilty > onlineState.verdictVotes.innocent && onlineState.verdictVotes.guilty >= Math.floor(alivePlaying / 2);

    if (isGuilty && onlineState.trialCandidate) {
      onlineState.trialCandidate.isAlive = false;
      onlineState.trialCandidate.deathReason = '투표로 처형됨';
      broadcastOnlineSystemMsg(`☠️ 투표 결과, 유죄 ${onlineState.verdictVotes.guilty}표로 [${onlineState.trialCandidate.name}] 님이 처형되었습니다.`);
    } else {
      broadcastOnlineSystemMsg(`🕊️ 과반수 유죄에 미달하여 [${onlineState.trialCandidate.name}] 님이 무죄 방면되었습니다.`);
    }
    broadcastOnlineState();

    setTimeout(() => {
      const victory = checkOnlineVictory();
      if (victory) {
        onlineState.phase = 'GAME_OVER';
        onlineState.winner = victory;
        broadcastOnlineVictory(victory);
        broadcastOnlineState();
      } else {
        onlineNight();
      }
    }, 4000);
  }

  function onlineNight() {
    onlineState.phase = 'NIGHT';
    onlineState.nightActions = { mafiaVotes: {}, doctorTarget: null, policeTarget: null };
    broadcastOnlineState();
    broadcastOnlineSystemMsg(`🌃 밤이 찾아왔습니다. 전체 채팅이 잠기고 마피아 비밀 채널이 열립니다. (40초)`);
    startOnlineTimer(40, () => resolveOnlineNight());
  }

  socket.on('online:night_action', ({ action, targetId }) => {
    const player = onlineState.players.find(p => p.socketId === socket.id);
    if (!player || !player.isAlive || player.isModerator || onlineState.phase !== 'NIGHT') return;

    if (action === 'mafia_kill' && ROLES[player.role]?.team === 'MAFIA') {
      onlineState.nightActions.mafiaVotes[targetId] = (onlineState.nightActions.mafiaVotes[targetId] || 0) + 1;
      const target = onlineState.players.find(p => p.id === targetId);
      broadcastOnlineSystemMsg(`🩸 [${player.name}] 님이 [${target?.name}] 님을 지목했습니다.`, 'mafia');
      const mafiaSockets = onlineState.players.filter(p => ROLES[p.role]?.team === 'MAFIA' && p.isAlive).map(p => p.socketId);
      mafiaSockets.forEach(sId => io.to(sId).emit('online:mafia_sync', onlineState.nightActions.mafiaVotes));
    } else if (action === 'doctor_heal' && player.role === 'DOCTOR') {
      onlineState.nightActions.doctorTarget = targetId;
      socket.emit('action_confirmed', '치료 대상이 설정되었습니다.');
    } else if (action === 'police_check' && player.role === 'POLICE') {
      const target = onlineState.players.find(p => p.id === targetId);
      const isMafia = target && ROLES[target.role]?.team === 'MAFIA' && target.role !== 'MAFIA_BOSS';
      socket.emit('online:police_result', { targetName: target ? target.name : '알 수 없음', isMafia });
    }
  });

  function resolveOnlineNight() {
    let mafiaTargetId = null, maxV = -1;
    Object.entries(onlineState.nightActions.mafiaVotes).forEach(([id, cnt]) => {
      if (cnt > maxV) { maxV = cnt; mafiaTargetId = id; }
    });

    const doctorSaved = onlineState.nightActions.doctorTarget === mafiaTargetId;
    let victim = null;
    if (mafiaTargetId && !doctorSaved) {
      victim = onlineState.players.find(p => p.id === mafiaTargetId);
      if (victim) {
        victim.isAlive = false;
        victim.deathReason = '마피아의 습격으로 사망';
      }
    }

    onlineState.lastNightReport = { victim, doctorSaved };
    onlineState.round++;
    onlineState.phase = 'MORNING_REPORT';
    broadcastOnlineState();

    if (victim) {
      broadcastOnlineSystemMsg(`🩸 지난밤, 마피아의 습격으로 [${victim.name}] 님이 목숨을 잃었습니다.`);
    } else {
      broadcastOnlineSystemMsg(`🕊️ 의사의 헌신적인 치료로 지난밤 아무도 목숨을 잃지 않았습니다!`);
    }

    const victory = checkOnlineVictory();
    if (victory) {
      setTimeout(() => {
        onlineState.phase = 'GAME_OVER';
        onlineState.winner = victory;
        broadcastOnlineVictory(victory);
        broadcastOnlineState();
      }, 5000);
    } else {
      setTimeout(() => onlineDayDiscuss(), 6000);
    }
  }

  function broadcastOnlineVictory(victory) {
    if (victory === 'MAFIA') {
      broadcastOnlineSystemMsg(`🏆 마피아 진영의 승리! 마피아가 마을을 장악했습니다.`);
    } else {
      broadcastOnlineSystemMsg(`🏆 시민 진영의 승리! 모든 마피아를 소탕했습니다.`);
    }
    const roleList = onlineState.players.filter(p => !p.isModerator).map(p => `[${p.name}: ${ROLES[p.role]?.name || '시민'}]`).join(', ');
    broadcastOnlineSystemMsg(`📜 최종 직업 공개: ${roleList}`);
  }

  socket.on('online:next_phase', () => {
    const sender = onlineState.players.find(p => p.socketId === socket.id);
    if (!sender || !sender.isHost) return;
    clearInterval(onlineState.timerInterval);
    broadcastOnlineSystemMsg(`⏩ 방장(사회자)이 다음 단계로 진행했습니다.`);
    if (onlineState.phase === 'FIRST_NIGHT') onlineDayDiscuss();
    else if (onlineState.phase === 'DAY_DISCUSS') onlineNominate();
    else if (onlineState.phase === 'DAY_NOMINATE') resolveOnlineNominate();
    else if (onlineState.phase === 'DAY_TRIAL') onlineVerdict();
    else if (onlineState.phase === 'DAY_VERDICT') resolveOnlineVerdict();
    else if (onlineState.phase === 'NIGHT') resolveOnlineNight();
    else if (onlineState.phase === 'MORNING_REPORT') onlineDayDiscuss();
  });

  socket.on('online:reset_game', () => {
    const sender = onlineState.players.find(p => p.socketId === socket.id);
    if (!sender || !sender.isHost) return;
    clearInterval(onlineState.timerInterval);
    onlineState.phase = 'LOBBY';
    onlineState.round = 1;
    onlineState.isTimerPaused = false;
    cleanupDeadOnlineSockets();

    onlineState.players.forEach(p => {
      p.role = p.isModerator ? 'MODERATOR' : null;
      p.isAlive = true;
      p.deathReason = null;
    });

    onlineState.trialCandidate = null;
    onlineState.nominationVotes = {};
    onlineState.verdictVotes = { guilty: 0, innocent: 0, votedSockets: new Set() };
    onlineState.nightActions = { mafiaVotes: {}, doctorTarget: null, policeTarget: null };
    onlineState.lastNightReport = null;
    onlineState.winner = null;

    io.to('room_online').emit('online:player_reset');
    broadcastOnlineSystemMsg(`🔄 방장이 다음 판을 준비했습니다. 직업이 초기화되었습니다.`);
    broadcastOnlineState();
  });

    socket.on('online:kick_all', () => {
    const sender = onlineState.players.find(p => p.socketId === socket.id);
    if (!sender || !sender.isHost) return;
    clearInterval(onlineState.timerInterval);
    onlineState.phase = 'LOBBY';
    onlineState.round = 1;
    onlineState.isTimerPaused = false;
    onlineState.players = [];
    onlineState.trialCandidate = null;
    onlineState.nominationVotes = {};
    onlineState.verdictVotes = { guilty: 0, innocent: 0, votedSockets: new Set() };
    onlineState.nightActions = { mafiaVotes: {}, doctorTarget: null, policeTarget: null };
    onlineState.lastNightReport = null;
    onlineState.winner = null;
    onlineState.roleDeckConfig = getAutoRoleDeck(5);

    io.to('room_online').emit('online:force_kick');
    broadcastOnlineState();
  });

  socket.on('online:kick_player', ({ id }) => {
    const sender = onlineState.players.find(p => p.socketId === socket.id);
    if (!sender || !sender.isHost) return;
    const idx = onlineState.players.findIndex(p => p.id === id);
    if (idx !== -1) {
      const kicked = onlineState.players.splice(idx, 1)[0];
      if (kicked && kicked.socketId) io.to(kicked.socketId).emit('online:force_kick');
      broadcastOnlineSystemMsg(`${kicked.name} 님이 퇴장되었습니다.`);
      broadcastOnlineState();
    }
  });

  socket.on('disconnect', () => {
    cleanupDeadOfflineSockets();
    broadcastOfflineState();
    cleanupDeadOnlineSockets();
    broadcastOnlineState();
  });
});

server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`🚀 대면 & 비대면 통합 마피아 플랫폼 실행 완료!`);
  console.log(`🌐 메인 홈 허브:       http://localhost:${PORT}`);
  console.log(`🏢 대면 빔프로젝터:     http://localhost:${PORT}/host`);
  console.log(`📱 대면 스마트폰:       http://localhost:${PORT}/offline`);
  console.log(`💬 비대면 온라인 게임:  http://localhost:${PORT}/online`);
  console.log(`=================================================`);
});
