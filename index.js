require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.NEXON_API_KEY;
const PORT = process.env.PORT || 3000;
const SERVERS = ['류트', '만돌린', '하프', '울프'];

console.log(`[디버그] API_KEY 앞 10자: ${API_KEY ? API_KEY.slice(0, 10) : '없음 (!!)'}`);
console.log(`[디버그] 수집 서버: ${SERVERS.join(', ')}`);

// DB 초기화 — server_name 컬럼 추가
const db = new Database('erin.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS horn (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_name TEXT,
    character_name TEXT,
    message TEXT,
    date_send TEXT,
    category TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_date_send ON horn(date_send);
  CREATE INDEX IF NOT EXISTS idx_category ON horn(category);
  CREATE INDEX IF NOT EXISTS idx_server ON horn(server_name);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_unique ON horn(server_name, character_name, message, date_send);
`);

// 카테고리 분류
function classify(msg) {
  // 길드 모집은 파티 모집보다 먼저 체크
  if (/길드원|길원/.test(msg)) return 'guild';
  if (/파티|구함|모집|인원|\/\d|[0-9]\/[0-9]/.test(msg)) return 'party';
  if (/팝니다|팝|판매|삽니다|구매|구입|얼마|골드|가격/.test(msg)) return 'trade';
  return 'etc';
}

// 단일 서버 수집
async function fetchServer(serverName) {
  try {
    const url = `https://open.api.nexon.com/mabinogi/v1/horn-bugle-world/history?server_name=${encodeURIComponent(serverName)}`;
    const res = await fetch(url, {
      headers: { 'x-nxopen-api-key': API_KEY }
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      console.error(`[${serverName}] API 오류 HTTP ${res.status}`, JSON.stringify(errData));
      return 0;
    }

    const data = await res.json();
    const items = data.horn_bugle_world_history || [];

    const insert = db.prepare(`
      INSERT OR IGNORE INTO horn (server_name, character_name, message, date_send, category)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((rows) => {
      let count = 0;
      for (const item of rows) {
        try {
          const info = insert.run(
            serverName,
            item.character_name,
            item.message,
            item.date_send,
            classify(item.message)
          );
          if (info.changes > 0) count++;
        } catch (e) {
          // 중복 무시
        }
      }
      return count;
    });

    const newCount = insertMany(items);
    console.log(`[${serverName}] ${items.length}건 조회, ${newCount}건 신규 저장`);
    return newCount;

  } catch (e) {
    console.error(`[${serverName}] 오류:`, e.message);
    return 0;
  }
}

// 전 서버 수집
async function fetchAll() {
  const now = new Date().toLocaleTimeString('ko-KR');
  console.log(`\n[${now}] 전 서버 수집 시작...`);
  // 순차 호출 (API 부하 방지)
  for (const server of SERVERS) {
    await fetchServer(server);
    await new Promise(r => setTimeout(r, 500)); // 0.5초 간격
  }
  console.log(`[${now}] 전 서버 수집 완료\n`);
}

// ─── API 엔드포인트 ───────────────────────────────

// 최근 메시지 피드
app.get('/api/feed', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const category = req.query.category;
  const keyword = req.query.keyword;
  const server = req.query.server; // 'all' 또는 특정 서버명

  let query = 'SELECT * FROM horn';
  const params = [];
  const conditions = [];

  if (server && server !== 'all') {
    conditions.push('server_name = ?');
    params.push(server);
  }

  if (category && category !== 'all') {
    conditions.push('category = ?');
    params.push(category);
  }

  if (keyword) {
    conditions.push('(message LIKE ? OR character_name LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY date_send DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(query).all(...params);
  res.json({ items: rows, count: rows.length });
});

// 시간대별 활동량
app.get('/api/stats/hourly', (req, res) => {
  const days = parseInt(req.query.days) || 1;
  const server = req.query.server;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let query = `
    SELECT 
      CAST((CAST(strftime('%H', date_send) AS INTEGER) + 9) % 24 AS INTEGER) as hour,
      COUNT(*) as count
    FROM horn
    WHERE date_send >= ?
  `;
  const params = [since];

  if (server && server !== 'all') {
    query += ' AND server_name = ?';
    params.push(server);
  }

  query += ' GROUP BY hour ORDER BY hour';

  const rows = db.prepare(query).all(...params);
  const hourly = new Array(24).fill(0);
  rows.forEach(r => { hourly[r.hour] = r.count; });

  res.json({ hourly, since, days, server: server || 'all' });
});

// 카테고리 분포
app.get('/api/stats/category', (req, res) => {
  const days = parseInt(req.query.days) || 1;
  const server = req.query.server;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let query = `SELECT category, COUNT(*) as count FROM horn WHERE date_send >= ?`;
  const params = [since];

  if (server && server !== 'all') {
    query += ' AND server_name = ?';
    params.push(server);
  }

  query += ' GROUP BY category';

  const rows = db.prepare(query).all(...params);
  const result = { party: 0, trade: 0, etc: 0 };
  rows.forEach(r => { result[r.category] = r.count; });

  res.json(result);
});

// ── 마비노기 약어 정규화 테이블
const NORMALIZE_MAP = {
  // 채널
  '1채': '채널1', '2채': '채널2', '3채': '채널3', '4채': '채널4',
  '5채': '채널5', '6채': '채널6', '7채': '채널7', '8채': '채널8',
  '9채': '채널9', '10채': '채널10',
  // 브리 레흐
  '브레': '브리레흐', '브트팟': '브리트라이', '브리트팟': '브리트라이',
  '구구': '구슬구매', '정코억분': '정코억분배', '정코분배': '정코억분배',
  // 크롬바스
  '크일': '크롬일반', '크쉬': '크롬쉬움',
  '크롬일': '크롬일반', '크롬쉬': '크롬쉬움',
  '상독화분': '상자독식화살분배',
  // 글렌베르나
  '글렌': '글렌베르나', '글매': '글렌일반', '글쉬': '글렌쉬움',
  '글렴': '글렌일반', '매어': '매우어려움',
  '헤분': '헤일로분배', '독식': '독식', '올독식': '올독식',
  // 파티 용어
  '풀팟': '풀파티', '풀파': '풀파티',
  '중탈': '중도탈주가능',
  // 아르카나
  '엘나': '엘레멘탈나이트', '세바': '세인트바드', '닼메': '다크메이지',
  '알스': '알케믹스팅어', '세가': '세이크리드가드', '거너': '배리어블거너',
  '포알': '포비든알케미스트', '멜퍼': '펠로딕퍼피티어',
  '퓨파': '퓨리파이터', '뜌따': '퓨리파이터',
};

// ── 불용어 목록 (확장)
const STOP_WORDS = new Set([
  // 조사/어미
  '이', '가', '은', '는', '을', '를', '에', '의', '와', '과', '도', '로', '으로',
  '에서', '하고', '이고', '그', '저', '것', '수', '있', '없',
  // 서술어
  '합니다', '합니다.', '해요', '해요.', '임', '임.', '입니다', '입니다.',
  '모집합니다', '모집해요', '모집중', '모집', '구합니다', '구해요', '구인',
  '있습니다', '없습니다', '됩니다', '합니다', '드립니다', '드려요',
  '가능', '가능합니다', '가능해요', '불가', '환영', '환영합니다',
  '부탁', '부탁드립니다', '부탁해요', '감사합니다', '감사',
  '참여', '참여해요', '참여합니다', '출발', '출발합니다',
  '합시다', '하실', '하시는', '하세요', '해주세요',
  // 숫자/기호만
  '00', '11', '22', '33',
  // 기타 노이즈
  '같이', '같이요', '같이해요', '같이하실', '같이하실분',
  '하실분', '하실분들', '분들', '분이요', '분만',
  '지금', '바로', '현재', '오늘', '오후', '오전', '저녁',
]);

// 닉네임 패턴 감지 (영문+숫자 혼합, 특수문자 포함 등)
function looksLikeNickname(word, allMessages) {
  // 메시지 발신자 닉네임 목록과 대조
  return false; // DB에서 character_name으로 필터링하므로 여기선 패스
}

function normalizeWord(w) {
  return NORMALIZE_MAP[w] || w;
}

// 키워드 트렌드
app.get('/api/stats/keywords', (req, res) => {
  const days = parseInt(req.query.days) || 1;
  const server = req.query.server;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let query = `SELECT character_name, message FROM horn WHERE date_send >= ?`;
  const params = [since];

  if (server && server !== 'all') {
    query += ' AND server_name = ?';
    params.push(server);
  }

  const rows = db.prepare(query).all(...params);

  // 발신자 닉네임 집합 (키워드에서 제외)
  const nicknames = new Set(rows.map(r => r.character_name));

  const freq = {};

  rows.forEach(({ message }) => {
    // 채널 표기 정규화 (숫자+채 패턴)
    const normalized = message
      .replace(/(\d{1,2})(채널|채)/g, '채널$1')
      .replace(/채널(\d{1,2})/g, '채널$1');

    const words = normalized
      .split(/[\s\[\]\(\)#:,.!?~ㅋㅎ/\\]+/)
      .map(w => w.trim())
      .filter(w => w.length >= 2);

    words.forEach(raw => {
      const w = normalizeWord(raw);
      // 불용어, 닉네임, 숫자만인 것 제외
      if (STOP_WORDS.has(w)) return;
      if (STOP_WORDS.has(raw)) return;
      if (nicknames.has(w) || nicknames.has(raw)) return;
      if (/^[0-9]+$/.test(w)) return;
      if (/^[a-zA-Z]{1,2}$/.test(w)) return; // 짧은 영문 제외
      freq[w] = (freq[w] || 0) + 1;
    });
  });

  const sorted = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word, count]) => ({ word, count }));

  res.json({ keywords: sorted });
});

// 파티 모집 현황
app.get('/api/stats/party', (req, res) => {
  const days = parseInt(req.query.days) || 1;
  const server = req.query.server;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let query = `SELECT message, date_send FROM horn WHERE category = 'party' AND date_send >= ?`;
  const params = [since];

  if (server && server !== 'all') {
    query += ' AND server_name = ?';
    params.push(server);
  }

  const rows = db.prepare(query).all(...params);

  // 던전별 분류 (순서 중요 — 위에서부터 매칭)
  const dungeons = {
    '브리레흐 4관':   { keywords: ['4관'], count: 0, recent: [] },
    '브리레흐 1-3관': { keywords: ['1-3관', '1관', '2관', '3관', '브리트팟', '브트팟', '정코억분', '정코분배', '구구', '구슬구매', '브리레흐', '브레', '브리'], count: 0, recent: [] },
    '크롬바스 일반':  { keywords: ['크일', '크롬일반', '크롬일', '크롬'], count: 0, recent: [] },
    '크롬바스 쉬움':  { keywords: ['크쉬', '크롬쉬움', '크롬쉬'], count: 0, recent: [] },
    '글렌베르나 일반':{ keywords: ['글매', '글렌일반', '헤분', '헤일로분배', '독식', '올독식', '글렴', '매어', '글렌매우어려움'], count: 0, recent: [] },
    '글렌베르나 쉬움':{ keywords: ['글쉬', '글렌쉬움'], count: 0, recent: [] },
    '기타': { keywords: [], count: 0, recent: [] },
  };

  // 길드 모집 메시지 앱 레벨에서 제외
  const filteredRows = rows.filter(r => !/길드원|길원/.test(r.message));

  filteredRows.forEach(({ message, date_send }) => {
    // 메시지 정규화 적용
    let normalizedMsg = message;
    for (const [abbr, full] of Object.entries(NORMALIZE_MAP)) {
      normalizedMsg = normalizedMsg.replace(new RegExp(abbr, 'g'), full);
    }

    let matched = false;
    for (const [name, info] of Object.entries(dungeons)) {
      if (name === '기타') continue;
      if (info.keywords.some(kw => message.includes(kw) || normalizedMsg.includes(kw))) {
        info.count++;
        if (info.recent.length < 5) info.recent.push({ message, date_send });
        matched = true;
        break;
      }
    }
    if (!matched) {
      dungeons['기타'].count++;
      if (dungeons['기타'].recent.length < 5) dungeons['기타'].recent.push({ message, date_send });
    }
  });

  // 인원 패턴 분석
  const memberPatterns = { '1인': 0, '2인': 0, '3인': 0, '4인': 0, '5인': 0, '6인': 0, '7인': 0, '풀파티': 0 };
  filteredRows.forEach(({ message }) => {
    if (/풀팟|풀파/.test(message)) { memberPatterns['풀파티']++; return; }
    const m = message.match(/([1-8])\s*\/\s*[1-8]/) || message.match(/([1-8])인/);
    if (m) {
      const key = `${m[1]}인`;
      if (memberPatterns[key] !== undefined) memberPatterns[key]++;
    }
  });

  const colorMap = {
    '브리레흐 4관': 'blue', '브리레흐 1-3관': 'blue',
    '크롬바스 일반': 'red', '크롬바스 쉬움': 'red',
    '글렌베르나 일반': 'teal', '글렌베르나 쉬움': 'teal', '글렌베르나 매어': 'purple',
    '기타': 'etc',
  };

  const dungeonList = Object.entries(dungeons).map(([name, info]) => ({
    name,
    count: info.count,
    recent: info.recent,
    color: colorMap[name] || 'etc',
  })).sort((a, b) => b.count - a.count);

  res.json({
    total: rows.length,
    dungeons: dungeonList,
    memberPatterns,
  });
});

// 전체 통계 요약
app.get('/api/stats/summary', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM horn').get();
  const today = db.prepare(`SELECT COUNT(*) as count FROM horn WHERE date_send >= datetime('now', '-24 hours')`).get();
  const oldest = db.prepare('SELECT MIN(date_send) as d FROM horn').get();
  const newest = db.prepare('SELECT MAX(date_send) as d FROM horn').get();

  // 서버별 카운트
  const serverCounts = {};
  SERVERS.forEach(s => {
    const row = db.prepare('SELECT COUNT(*) as count FROM horn WHERE server_name = ?').get(s);
    serverCounts[s] = row.count;
  });

  res.json({
    total: total.count,
    today: today.count,
    oldest: oldest.d,
    newest: newest.d,
    servers: serverCounts
  });
});

// ─── 서버 시작 ───────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🎺 지금 에린에서는 — 백엔드 서버 시작`);
  console.log(`   포트: ${PORT}`);
  console.log(`   수집 서버: ${SERVERS.join(', ')}`);
  console.log(`   http://localhost:${PORT}\n`);

  fetchAll();
});

cron.schedule('*/10 * * * *', () => {
  fetchAll();
});

console.log('⏰ 10분마다 자동 수집 스케줄 등록 완료');
