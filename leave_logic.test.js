'use strict';
/**
 * Jest 테스트 — leave_logic.js
 * 실행: npm test
 */
const {
  calcAnnualDays,
  calcBoundaryPostDays,
  calcEffectiveRemain,
  calcNewRemainAfterApproval,
  getPayoutTargets,
  getAnniversary,
  parseLocalDate,
} = require('./leave_logic');

// ── 헬퍼 ──────────────────────────────────────────────────────
function makeEmp({ join = '2023-04-17', annual = 15, spRemain = null,
                   lastResetDate = null, payoutDoneDate = null } = {}) {
  return { join, annual, used: 0, spRemain, lastResetDate, payoutDoneDate };
}

function makeReq({ empIdx = 0, days = 1, start = '2026-03-31',
                   end = '2026-03-31', status = 'approved',
                   type = '연차', originalId = null, id = 1 } = {}) {
  return { id, empIdx, days, start, end, status, type, originalId };
}

// ── 연차 발생 계산 ─────────────────────────────────────────────
describe('calcAnnualDays', () => {
  test('1년 미만 — 월 기준', () => {
    const ref = new Date(2026, 2, 1);  // 2026-03-01
    expect(calcAnnualDays('2026-01-01', ref)).toBe(2);
  });

  test('정확히 1년 당일 → 15일', () => {
    const ref = new Date(2026, 3, 10); // 2026-04-10
    expect(calcAnnualDays('2025-04-10', ref)).toBe(15);
  });

  test('기념일 하루 전 → 아직 1년 미만', () => {
    const ref = new Date(2026, 3, 9);  // 2026-04-09
    expect(calcAnnualDays('2025-04-10', ref)).toBe(11);
  });

  test('정확히 3년 → 16일', () => {
    const ref = new Date(2026, 3, 17); // 2026-04-17
    expect(calcAnnualDays('2023-04-17', ref)).toBe(16);
  });

  test('기념일 7일 전 2년 11개월 → 15일', () => {
    const ref = new Date(2026, 3, 10); // 2026-04-10 (기념일 4/17 전)
    expect(calcAnnualDays('2023-04-17', ref)).toBe(15);
  });

  test('26년 근속 → 최대 25일', () => {
    const ref = new Date(2026, 0, 1);
    expect(calcAnnualDays('2000-01-01', ref)).toBe(25);
  });
});

// ── 기념일 계산 ───────────────────────────────────────────────
describe('getAnniversary', () => {
  test('일반 날짜', () => {
    const join = new Date(2023, 3, 17); // 2023-04-17
    const anniv = getAnniversary(join, 2026);
    expect(anniv.toISOString().slice(0, 10)).toBe('2026-04-17');
  });

  test('2월 29일 → 평년엔 2월 28일', () => {
    const join = new Date(2020, 1, 29); // 2020-02-29
    const anniv = getAnniversary(join, 2026); // 2026은 평년
    expect(anniv.toISOString().slice(0, 10)).toBe('2026-02-28');
  });
});

// ── 신다정 케이스: 기념일 경계 분할 ──────────────────────────
describe('calcBoundaryPostDays — 신다정 케이스', () => {
  // join: 2023-04-17, anniversary: 2026-04-17
  // 4/16~4/17 연차 2일 → 구연차 1일 + 신연차 1일

  const anniversary = new Date(2026, 3, 17); // 2026-04-17

  test('4/16~4/17 경계 걸친 휴가 → 신연차 1일', () => {
    const reqs = [makeReq({ start: '2026-04-16', end: '2026-04-17', days: 2 })];
    expect(calcBoundaryPostDays(reqs, 0, anniversary)).toBe(1);
  });

  test('4/17 당일만 → 경계 아님 (start < 기념일 조건 불충족)', () => {
    const reqs = [makeReq({ start: '2026-04-17', end: '2026-04-17', days: 1 })];
    expect(calcBoundaryPostDays(reqs, 0, anniversary)).toBe(0);
  });

  test('4/16 이전 휴가 → 해당 없음', () => {
    const reqs = [makeReq({ start: '2026-04-14', end: '2026-04-15', days: 2 })];
    expect(calcBoundaryPostDays(reqs, 0, anniversary)).toBe(0);
  });

  test('취소된 휴가는 제외', () => {
    const reqs = [makeReq({ start: '2026-04-16', end: '2026-04-17',
                            days: 2, status: 'cancelled' })];
    expect(calcBoundaryPostDays(reqs, 0, anniversary)).toBe(0);
  });

  test('리프레시는 차감 제외', () => {
    const reqs = [makeReq({ start: '2026-04-16', end: '2026-04-25',
                            days: 10, type: '리프레시' })];
    expect(calcBoundaryPostDays(reqs, 0, anniversary)).toBe(0);
  });

  test('4/15~4/19 휴가 → 신연차 3일 (4/17, 4/18, 4/19)', () => {
    const reqs = [makeReq({ start: '2026-04-15', end: '2026-04-19', days: 5 })];
    expect(calcBoundaryPostDays(reqs, 0, anniversary)).toBe(3);
  });
});

// ── 잔여연차 계산 (바 차트용) ─────────────────────────────────
describe('calcEffectiveRemain', () => {
  const today = new Date(2026, 3, 10); // 2026-04-10 (기념일 4/17 전)

  test('신다정: SP=2.5 + 경계보정 1 = 3.5일', () => {
    const emp = makeEmp({
      join: '2023-04-17', annual: 15, spRemain: 2.5,
      lastResetDate: '2026-04-17'
    });
    const reqs = [makeReq({ start: '2026-04-16', end: '2026-04-17', days: 2 })];
    expect(calcEffectiveRemain(emp, reqs, 0, today)).toBe(3.5);
  });

  test('SP=null → annual(16) 전체 반환', () => {
    const emp = makeEmp({ annual: 16, spRemain: null });
    expect(calcEffectiveRemain(emp, [], 0, today)).toBe(16);
  });

  test('SP=0 (오류) → 로컬 계산 사용', () => {
    const emp = makeEmp({ annual: 16, spRemain: 0 });
    const reqs = [makeReq({ empIdx: 0, days: 0.5,
                            start: '2026-04-10', end: '2026-04-10' })];
    // local = 16 - 0.5 = 15.5 (기념일 후 기준)
    expect(calcEffectiveRemain(emp, reqs, 0, today)).toBe(15.5);
  });

  test('SP=13.5 (유효) → 그대로 사용', () => {
    const emp = makeEmp({ annual: 16, spRemain: 13.5,
                          lastResetDate: '2026-02-10' });
    expect(calcEffectiveRemain(emp, [], 0, today)).toBe(13.5);
  });

  test('SP가 로컬보다 낮으면 SP 우선', () => {
    // SP=10, local=15.5 → min(10, 15.5) = 10
    const emp = makeEmp({ annual: 16, spRemain: 10,
                          lastResetDate: '2026-02-10' });
    const reqs = [makeReq({ empIdx: 0, days: 0.5,
                            start: '2026-03-01', end: '2026-03-01' })];
    expect(calcEffectiveRemain(emp, reqs, 0, today)).toBe(10);
  });
});

// ── 승인 시 차감 계산 ─────────────────────────────────────────
describe('calcNewRemainAfterApproval', () => {
  test('일반 차감 (기념일 이전)', () => {
    const emp = makeEmp({ annual: 15, spRemain: 15 });
    const req = makeReq({ days: 1, start: '2026-03-01', end: '2026-03-01' });
    const { newRemain, newAnnual } = calcNewRemainAfterApproval(
      emp, req, [], 0, new Date(2026, 2, 1));
    expect(newRemain).toBe(14);
    expect(newAnnual).toBe(15);
  });

  test('기념일 경계 (4/16~4/17): 신연차 16일 기준 15일 잔여', () => {
    const emp = makeEmp({ join: '2023-04-17', annual: 13, spRemain: 13 });
    const req = makeReq({ days: 2, start: '2026-04-16', end: '2026-04-17' });
    const { newRemain, newAnnual } = calcNewRemainAfterApproval(
      emp, req, [], 0, new Date(2026, 3, 17));
    expect(newAnnual).toBe(16);  // 3년 완성 → 16일
    expect(newRemain).toBe(15);  // 16 - 1(신연차 1일)
  });

  test('기념일 이후 신연차 차감', () => {
    const emp = makeEmp({ join: '2023-04-17', annual: 13, spRemain: 13 });
    const req = makeReq({ days: 1, start: '2026-04-20', end: '2026-04-20' });
    const { newRemain, newAnnual } = calcNewRemainAfterApproval(
      emp, req, [], 0, new Date(2026, 3, 20));
    expect(newAnnual).toBe(16);
    expect(newRemain).toBe(15); // 16 - 1
  });
});

// ── 미소진 정산 대상 ──────────────────────────────────────────
describe('getPayoutTargets', () => {
  const today = new Date(2026, 3, 10); // 2026-04-10

  test('D-7 → 대상 포함', () => {
    const emp = makeEmp({ join: '2023-04-17', annual: 15, spRemain: 3.5 });
    const targets = getPayoutTargets([emp], [], today);
    expect(targets).toHaveLength(1);
    expect(targets[0].daysLeft).toBe(7);
    expect(targets[0].remain).toBe(3.5);
  });

  test('D-61 (60일 초과) → 제외', () => {
    const emp = makeEmp({ join: '2023-06-10', annual: 15, spRemain: 5 });
    expect(getPayoutTargets([emp], [], today)).toHaveLength(0);
  });

  test('잔여 0 → 제외', () => {
    // spRemain이 없고 사용 = annual
    const emp = makeEmp({ join: '2023-04-17', annual: 15, spRemain: 15 });
    const reqs = [makeReq({ empIdx: 0, days: 15,
                            start: '2025-06-01', end: '2025-06-15' })];
    expect(getPayoutTargets([emp], reqs, today)).toHaveLength(0);
  });

  test('신다정: 경계 보정 포함 3.5일', () => {
    const emp = makeEmp({ join: '2023-04-17', annual: 15, spRemain: 2.5 });
    const reqs = [makeReq({ start: '2026-04-16', end: '2026-04-17', days: 2 })];
    const targets = getPayoutTargets([emp], reqs, today);
    expect(targets).toHaveLength(1);
    expect(targets[0].remain).toBe(3.5);
  });

  test('여러 직원: daysLeft 오름차순 정렬', () => {
    const empA = makeEmp({ join: '2023-04-17', annual: 15, spRemain: 3 }); // D-7
    const empB = makeEmp({ join: '2023-05-10', annual: 15, spRemain: 3 }); // D-30
    const targets = getPayoutTargets([empA, empB], [], today);
    expect(targets[0].daysLeft).toBeLessThan(targets[1].daysLeft);
  });
});

// ── 차감 제외 키워드 ──────────────────────────────────────────
describe('NO_DEDUCT_KW 적용', () => {
  const anniversary = new Date(2026, 3, 17);
  const deductTypes = ['연차', '반차 - 오전', '반반차 - 오후'];
  const noDeductTypes = ['리프레시', '특별유급휴가', '병가', '경조사', '예비군'];

  deductTypes.forEach(type => {
    test(`${type} → 차감 대상`, () => {
      const reqs = [makeReq({ type, start: '2026-04-16', end: '2026-04-17', days: 2 })];
      expect(calcBoundaryPostDays(reqs, 0, anniversary)).toBe(1);
    });
  });

  noDeductTypes.forEach(type => {
    test(`${type} → 차감 제외`, () => {
      const reqs = [makeReq({ type, start: '2026-04-16', end: '2026-04-17', days: 2 })];
      expect(calcBoundaryPostDays(reqs, 0, anniversary)).toBe(0);
    });
  });
});
