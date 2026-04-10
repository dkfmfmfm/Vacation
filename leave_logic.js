/**
 * BEYOND EARTH 연차 핵심 로직
 * HTML과 Node.js(Jest) 양쪽에서 동작
 *
 * HTML에서: <script src="js/leave_logic.js"></script>
 * Jest에서:  const L = require('./leave_logic');
 */

// ── 상수 ──────────────────────────────────────────────────────
const NO_DEDUCT_KW = [
  '리프레시','특별유급휴가','산전후','출산',
  '생리','병가','경조사','예비군','난임','배우자출산'
];

const EXEC_EMAILS = {
  YH: 'bobby@beyonder.co.kr',
  JH: 'jay@beyonder.co.kr',
  SA: 'sarah@beyonder.co.kr',
};

const REFRESH_MILESTONES = [5, 8, 11, 14, 17, 20];

// ── 날짜 유틸 ─────────────────────────────────────────────────
/**
 * 특정 연도의 기념일(입사월일) 반환
 * @param {Date} join - 입사일
 * @param {number} year - 대상 연도
 * @returns {Date}
 */
function getAnniversary(join, year) {
  const j = new Date(join);
  const month = j.getMonth();
  const day = j.getDate();
  // 2월 29일 → 평년에는 2월 28일로 처리
  const maxDay = new Date(year, month + 1, 0).getDate(); // 해당 월 마지막 날
  const safeDay = Math.min(day, maxDay);
  const d = new Date(year, month, safeDay);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 날짜 문자열 → Date (자정 로컬 기준, 타임존 오프셋 제거)
 * @param {string} str - 'YYYY-MM-DD' 또는 ISO 문자열
 * @returns {Date}
 */
function parseLocalDate(str) {
  if (!str) return null;
  const s = String(str).slice(0, 10);      // 'YYYY-MM-DD'
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setHours(0, 0, 0, 0);
  return date;
}

// ── 연차 발생 계산 ────────────────────────────────────────────
/**
 * 입사 기념일 기준 연차 발생 일수 (근로기준법)
 * @param {string|Date} joinStr - 입사일
 * @param {Date|null} ref       - 기준일 (null = 오늘)
 * @returns {number}
 */
function calcAnnualDays(joinStr, ref = null) {
  const join = parseLocalDate(typeof joinStr === 'string' ? joinStr
                                                          : joinStr.toISOString());
  const today = ref ? new Date(ref) : new Date();
  today.setHours(0, 0, 0, 0);

  // 올해 기념일 기준으로 정수 근속년수 계산 (365.25 나누기보다 정확)
  const annivThisYear = getAnniversary(join, today.getFullYear());
  const completedYears = annivThisYear <= today
    ? today.getFullYear() - join.getFullYear()
    : today.getFullYear() - join.getFullYear() - 1;

  if (completedYears < 1) {
    const months = (today.getFullYear() - join.getFullYear()) * 12
                 + (today.getMonth() - join.getMonth());
    return Math.min(Math.max(months, 0), 11);
  }
  if (completedYears < 3) return 15;
  return Math.min(15 + Math.floor((completedYears - 1) / 2), 25);
}

// ── 경계 분할 계산 ────────────────────────────────────────────
/**
 * 기념일 경계 걸친 휴가의 신연차 차감분
 * 예: 4/16~4/17 휴가, 기념일 4/17 → 신연차 1일
 *
 * @param {Array}  requests   - LeaveRequest 배열
 * @param {number} empIdx     - 직원 인덱스
 * @param {Date}   anniversary - 기념일
 * @returns {number}
 */
function calcBoundaryPostDays(requests, empIdx, anniversary) {
  const anniv = new Date(anniversary);
  anniv.setHours(0, 0, 0, 0);

  return requests.reduce((total, r) => {
    if (r.empIdx !== empIdx) return total;
    if (r.status !== 'approved' || r.originalId) return total;
    if (NO_DEDUCT_KW.some(kw => (r.type || '').includes(kw))) return total;

    const rStart = parseLocalDate(r.start);
    const rEnd   = parseLocalDate(r.end);
    if (!rStart || !rEnd) return total;

    // start < 기념일 ≤ end  → 경계 걸침
    if (rStart < anniv && rEnd >= anniv) {
      const msPerDay = 24 * 60 * 60 * 1000;
      const daysAfter = Math.round((rEnd - anniv) / msPerDay) + 1;
      return total + daysAfter;
    }
    return total;
  }, 0);
}

// ── 잔여연차 계산 (바 차트용) ────────────────────────────────
/**
 * 직원별 연차 현황 표시용 잔여연차
 * - SP 값 우선 (SP=0이면 오류로 간주 → 로컬 계산 fallback)
 * - 기념일 경계 분할 보정 포함
 *
 * @param {Object} emp      - Employee 객체 (annual, sp_remain, last_reset_date, join)
 * @param {Array}  requests - 전체 요청 배열
 * @param {number} empIdx   - 직원 인덱스
 * @param {Date}   today    - 기준일 (null = 오늘)
 * @returns {number}
 */
function calcEffectiveRemain(emp, requests, empIdx, today = null) {
  const todayDate = today ? new Date(today) : new Date();
  todayDate.setHours(0, 0, 0, 0);

  const join = parseLocalDate(emp.join instanceof Date
    ? emp.join.toISOString() : emp.join);
  const anniversary = getAnniversary(join, todayDate.getFullYear());

  // 로컬 계산: 기념일(또는 lastResetDate) 이후 사용분
  const cutoff = emp.lastResetDate
    ? (() => { const d = parseLocalDate(emp.lastResetDate instanceof Date
        ? emp.lastResetDate.toISOString() : emp.lastResetDate); return d; })()
    : null;

  const localUsed = requests.reduce((s, r) => {
    if (r.empIdx !== empIdx) return s;
    if (r.status !== 'approved' || r.originalId) return s;
    if (NO_DEDUCT_KW.some(kw => (r.type || '').includes(kw))) return s;
    if (cutoff) {
      const rStart = parseLocalDate(r.start instanceof Date
        ? r.start.toISOString() : r.start);
      if (rStart && rStart < cutoff) return s;
    }
    return s + (r.days || 0);
  }, 0);

  const localRemain = Math.round((emp.annual - localUsed) * 100) / 100;

  // SP 값: 0은 오류로 간주, 유효하면 사용
  const spBase = (emp.spRemain !== undefined && emp.spRemain !== null && emp.spRemain > 0)
    ? Math.round(emp.spRemain * 100) / 100
    : localRemain;

  // SP와 로컬 중 작은 값 (SP 미업데이트 시 로컬 우선)
  const base = Math.min(spBase, localRemain);

  // 경계 분할 보정 (항상 적용)
  const boundaryPost = calcBoundaryPostDays(requests, empIdx, anniversary);

  return Math.max(0, Math.round((base + boundaryPost) * 100) / 100);
}

// ── 미소진 정산 대상 목록 ─────────────────────────────────────
/**
 * 미소진 연차 현금 지급 대상 계산
 * @param {Array} employees - 직원 배열
 * @param {Array} requests  - 요청 배열
 * @param {Date}  today     - 기준일
 * @param {number} alertDays - 사전 알림 일수 (기본 60)
 * @returns {Array} 정렬된 대상 목록
 */
function getPayoutTargets(employees, requests, today = null, alertDays = 60) {
  const todayDate = today ? new Date(today) : new Date();
  todayDate.setHours(0, 0, 0, 0);

  const targets = [];

  employees.forEach((emp, idx) => {
    if (!emp.join || emp.annual <= 0) return;

    const join = parseLocalDate(emp.join instanceof Date
      ? emp.join.toISOString() : emp.join);
    const msPerYear = 1000 * 60 * 60 * 24 * 365.25;
    if ((todayDate - join) / msPerYear < 1) return;

    const anniversary = getAnniversary(join, todayDate.getFullYear());
    const isPast = anniversary < todayDate;

    // 정산완료 처리됐으면 제외
    if (isPast && emp.payoutDoneDate) {
      const pdd = parseLocalDate(emp.payoutDoneDate instanceof Date
        ? emp.payoutDoneDate.toISOString() : emp.payoutDoneDate);
      if (pdd && pdd >= anniversary) return;
    }

    // 올해 기념일이 이미 지났으면 정산 완료로 간주
    const janFirst = new Date(todayDate.getFullYear(), 0, 1);
    janFirst.setHours(0, 0, 0, 0);
    if (isPast && anniversary >= janFirst) return;

    // 60일 이내 필터
    const msPerDay = 1000 * 60 * 60 * 24;
    if (!isPast) {
      const daysLeft = Math.ceil((anniversary - todayDate) / msPerDay);
      if (daysLeft > alertDays) return;
    }

    // calcEffectiveRemain 재사용 (SP fallback + 경계 보정 포함)
    const remain = calcEffectiveRemain(emp, requests, idx, todayDate);

    if (remain <= 0) return;

    const daysLeft = isPast
      ? -Math.ceil((todayDate - anniversary) / msPerDay)
      : Math.ceil((anniversary - todayDate) / msPerDay);

    targets.push({ emp, empIdx: idx, remain, daysLeft, anniversary, isPast });
  });

  return targets.sort((a, b) => a.daysLeft - b.daysLeft);
}

// ── 승인 시 새 잔여연차 계산 ─────────────────────────────────
/**
 * 휴가 승인 시 차감 후 잔여연차, 신 연차 반환
 * @returns {{ newRemain: number, newAnnual: number }}
 */
function calcNewRemainAfterApproval(emp, req, requests, empIdx, today = null) {
  const todayDate = today ? new Date(today) : new Date();
  todayDate.setHours(0, 0, 0, 0);

  const join = parseLocalDate(emp.join instanceof Date
    ? emp.join.toISOString() : emp.join);
  const reqStart = parseLocalDate(req.start instanceof Date
    ? req.start.toISOString() : req.start);
  const reqEnd   = parseLocalDate(req.end instanceof Date
    ? req.end.toISOString() : req.end);

  const anniversary = getAnniversary(join, reqStart.getFullYear());
  const notYetReset = !emp.lastResetDate || (() => {
    const lrd = parseLocalDate(emp.lastResetDate instanceof Date
      ? emp.lastResetDate.toISOString() : emp.lastResetDate);
    return lrd < anniversary;
  })();

  const msPerDay = 24 * 60 * 60 * 1000;

  // 케이스 1: 기념일 경계 걸침 (start < 기념일 ≤ end)
  if (notYetReset && reqStart < anniversary && reqEnd >= anniversary) {
    const daysAfter = Math.round((reqEnd - anniversary) / msPerDay) + 1;
    const newAnnual = calcAnnualDays(emp.join, anniversary);
    const usedAfter = requests.reduce((s, r) => {
      if (r.empIdx !== empIdx || r.id === req.id) return s;
      if (r.status !== 'approved' || r.originalId) return s;
      if (NO_DEDUCT_KW.some(kw => (r.type || '').includes(kw))) return s;
      const rs = parseLocalDate(r.start instanceof Date ? r.start.toISOString() : r.start);
      return rs >= anniversary ? s + r.days : s;
    }, 0);
    return {
      newRemain: Math.max(0, Math.round((newAnnual - usedAfter - daysAfter) * 100) / 100),
      newAnnual,
    };
  }

  // 케이스 2: 기념일 이후 (신연차 차감)
  if (notYetReset && reqStart >= anniversary) {
    const newAnnual = calcAnnualDays(emp.join, anniversary);
    const usedAfter = requests.reduce((s, r) => {
      if (r.empIdx !== empIdx || r.id === req.id) return s;
      if (r.status !== 'approved' || r.originalId) return s;
      if (NO_DEDUCT_KW.some(kw => (r.type || '').includes(kw))) return s;
      const rs = parseLocalDate(r.start instanceof Date ? r.start.toISOString() : r.start);
      return rs >= anniversary ? s + r.days : s;
    }, 0);
    const current = Math.round((newAnnual - usedAfter) * 100) / 100;
    return {
      newRemain: Math.max(0, Math.round((current - req.days) * 100) / 100),
      newAnnual,
    };
  }

  // 케이스 3: 기념일 이전 (구연차 차감)
  const current = (emp.spRemain !== undefined && emp.spRemain !== null && emp.spRemain > 0)
    ? emp.spRemain
    : Math.round((emp.annual - emp.used) * 100) / 100;
  return {
    newRemain: Math.max(0, Math.round((current - req.days) * 100) / 100),
    newAnnual: emp.annual,
  };
}

// ── 리프레시 ─────────────────────────────────────────────────
function calcRefreshInfo(joinStr) {
  const join = parseLocalDate(joinStr);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let last = '없음', next = '';
  for (const y of REFRESH_MILESTONES) {
    const d = getAnniversary(join, join.getFullYear() + y);
    if (d <= today) last = `만${y}년 (${d.toISOString().slice(0,10)})`;
    if (d > today && !next) {
      const dl = Math.ceil((d - today) / 86400000);
      next = `만${y}년 (${d.toISOString().slice(0,10)}, ${dl}일 후)`;
    }
  }
  return { last, next };
}

// ── Node.js(Jest) exports / 브라우저 양쪽 지원 ───────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    calcAnnualDays,
    calcBoundaryPostDays,
    calcEffectiveRemain,
    calcNewRemainAfterApproval,
    getPayoutTargets,
    getAnniversary,
    parseLocalDate,
    calcRefreshInfo,
    NO_DEDUCT_KW,
    EXEC_EMAILS,
  };
}
