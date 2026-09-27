/*
 * Payoff engine.
 *
 * Compares four ways to pay off a mortgage using the SAME monthly cash flow:
 *   standard - pay the scheduled payment; leftover cash sits in checking
 *   extra    - send all leftover cash to the mortgage as extra principal
 *   heloc    - keep the mortgage, add a second-lien HELOC, deposit pay into
 *              it, and move "chunks" from the HELOC onto the mortgage
 *   aio      - replace the mortgage with an all-in-one first-lien HELOC that
 *              doubles as your bank account (income in, spending out)
 *
 * Every dollar is accounted for: income comes in, spending and loan
 * payments go out, interest is charged to the balance it accrues on.
 * Nothing here is advice; it is arithmetic on the inputs given.
 */
(function (root) {
  "use strict";

  const MAX_MONTHS = 600; // 50 years: anything longer is reported as "never"
  const CARD_PAY_DAY = 25; // day the credit card is paid in full (card mode)

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  }

  function monthlyPayment(balance, annualRate, months) {
    if (months <= 0) return balance;
    const r = annualRate / 100 / 12;
    if (r === 0) return balance / months;
    return (balance * r) / (1 - Math.pow(1 + r, -months));
  }

  // Income deposits for one month, as [{day, amount}].
  function paydays(schedule, income, year, month, biweeklyState) {
    const dim = daysInMonth(year, month);
    if (schedule === "monthly") return [{ day: 1, amount: income }];
    if (schedule === "biweekly") {
      // 26 checks a year; each check is income * 12 / 26.
      const check = (income * 12) / 26;
      const out = [];
      while (biweeklyState.nextDay <= dim) {
        out.push({ day: biweeklyState.nextDay, amount: check });
        biweeklyState.nextDay += 14;
      }
      biweeklyState.nextDay -= dim;
      return out;
    }
    // Twice a month: 1st and 15th.
    return [
      { day: 1, amount: income / 2 },
      { day: 15, amount: income / 2 },
    ];
  }

  function normalize(input) {
    const p = Object.assign(
      {
        balance: 0,
        rate: 0,
        yearsLeft: 30,
        homeValue: 0,
        income: 0,
        spending: 0,
        payment: null, // P&I; derived from balance/rate/term when null
        payStrategy: "semimonthly", // monthly | semimonthly | biweekly
        spendTiming: "spread", // spread | card
        helocRate: 8,
        maxCltv: 80,
        helocLimit: 0, // 0 = as much as equity allows
        chunk: 0, // 0 = automatic
        helocAnnualFee: 0,
        aioRate: 7.75,
        aioMaxLtv: 80, // largest loan an all-in-one lender allows, % of home value
        aioCost: 0, // one-time cost to switch (refinance closing costs)
        startYear: null,
        startMonth: null,
      },
      input || {}
    );
    const now = new Date();
    if (p.startYear == null) {
      // First simulated month is next calendar month.
      const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      p.startYear = d.getFullYear();
      p.startMonth = d.getMonth();
    }
    p.termMonths = Math.max(1, Math.round(p.yearsLeft * 12));
    p.scheduledPayment = monthlyPayment(p.balance, p.rate, p.termMonths);
    if (p.payment == null || !(p.payment > 0)) p.payment = p.scheduledPayment;
    p.leftover = p.income - p.spending - p.payment;
    return p;
  }

  function calendar(p, index) {
    const m = p.startMonth + index;
    return { year: p.startYear + Math.floor(m / 12), month: ((m % 12) + 12) % 12 };
  }

  function result(name, months, interest, fees, series, extra) {
    const neverPaysOff = months == null;
    return Object.assign(
      {
        name,
        months: neverPaysOff ? null : months,
        interest,
        fees,
        cost: interest + fees,
        neverPaysOff,
        series, // month-end total debt, index 0 = today
      },
      extra || {}
    );
  }

  // ── Standard and extra payments: ordinary monthly amortization ──────────
  function amortize(p, extraPerMonth) {
    const r = p.rate / 100 / 12;
    let bal = p.balance;
    let interest = 0;
    const series = [bal];
    for (let month = 1; month <= MAX_MONTHS; month++) {
      const i = bal * r;
      interest += i;
      const pay = Math.min(bal + i, p.payment + Math.max(0, extraPerMonth));
      bal = bal + i - pay;
      if (bal < 0.005) bal = 0;
      series.push(bal);
      if (bal === 0) return { months: month, interest, series };
      if (pay <= i && month > 1) break; // payment doesn't cover interest
    }
    return { months: null, interest, series };
  }

  function standard(p) {
    const a = amortize(p, 0);
    return result("standard", a.months, a.interest, 0, a.series);
  }

  function extraPayments(p) {
    const a = amortize(p, p.leftover);
    return result("extra", a.months, a.interest, 0, a.series);
  }

  // ── Shared daily cash-flow driver for HELOC and all-in-one ──────────────
  // `line` is the balance that income pays down and spending draws from.
  // Inflows reduce the line first; anything beyond zero is held as cash.
  // Outflows use held cash first, then draw on the line.
  function makeAccount() {
    return { line: 0, cash: 0 };
  }
  function inflow(acct, amt) {
    const toLine = Math.min(acct.line, amt);
    acct.line -= toLine;
    acct.cash += amt - toLine;
  }
  function outflow(acct, amt) {
    const fromCash = Math.min(acct.cash, amt);
    acct.cash -= fromCash;
    acct.line += amt - fromCash;
  }

  function spendingEvents(p, dim) {
    if (p.spendTiming === "card") return [{ day: Math.min(CARD_PAY_DAY, dim), amount: p.spending }];
    const daily = p.spending / dim;
    const out = [];
    for (let d = 1; d <= dim; d++) out.push({ day: d, amount: daily });
    return out;
  }

  // ── HELOC chunking (second lien) ────────────────────────────────────────
  function availableEquity(p) {
    return Math.max(0, p.homeValue * (p.maxCltv / 100) - p.balance);
  }

  function autoChunk(p, limit) {
    // Default chunk: about six months of leftover cash, capped by the line.
    const six = Math.max(0, p.leftover) * 6;
    return Math.max(0, Math.min(limit, Math.round(six / 1000) * 1000 || six));
  }

  function heloc(p, overrides) {
    const q = Object.assign({}, p, overrides || {});
    const equity = availableEquity(q);
    const limit = q.helocLimit > 0 ? Math.min(q.helocLimit, equity) : equity;
    const chunkSize = q.chunk > 0 ? Math.min(q.chunk, limit) : autoChunk(q, limit);
    if (limit < 1000 || chunkSize < 1000) {
      return result("heloc", null, 0, 0, [q.balance], {
        unavailable: true,
        reason: limit < 1000 ? "equity" : "leftover",
        limit,
        chunkSize,
        equity,
      });
    }
    const mr = q.rate / 100 / 12;
    const dr = q.helocRate / 100 / 365;
    const acct = makeAccount();
    let mort = q.balance;
    let mortInterest = 0;
    let helocInterest = 0;
    let fees = 0;
    let chunks = 0;
    let peakLine = 0;
    let lineSum = 0;
    let lineDays = 0;
    const series = [q.balance];
    const bw = { nextDay: 1 };

    function drawChunk() {
      const room = limit - acct.line;
      const c = Math.min(chunkSize, room, mort);
      if (c < 1) return;
      mort -= c;
      acct.line += c;
      chunks++;
      // Any cash already sitting in checking goes straight onto the line.
      const cash = acct.cash;
      acct.cash = 0;
      inflow(acct, cash);
    }

    drawChunk();

    for (let month = 1; month <= MAX_MONTHS; month++) {
      const { year, month: mo } = calendar(q, month - 1);
      const dim = daysInMonth(year, mo);
      const pays = paydays(q.payStrategy, q.income, year, mo, bw);
      const spends = spendingEvents(q, dim);
      let accrued = 0;
      for (let day = 1; day <= dim; day++) {
        if (day === 1 && mort > 0) {
          const i = mort * mr;
          mortInterest += i;
          const pay = Math.min(mort + i, q.payment);
          mort = mort + i - pay;
          if (mort < 0.005) mort = 0;
          outflow(acct, pay);
        }
        for (const e of pays) if (e.day === day) inflow(acct, e.amount);
        for (const e of spends) if (e.day === day) outflow(acct, e.amount);
        accrued += acct.line * dr;
        lineSum += acct.line;
        lineDays++;
        if (acct.line > peakLine) peakLine = acct.line;
      }
      helocInterest += accrued;
      outflow(acct, accrued); // interest is charged to the line
      if (q.helocAnnualFee > 0 && month % 12 === 0) {
        fees += q.helocAnnualFee;
        outflow(acct, q.helocAnnualFee);
      }
      if (acct.line > limit + 0.5) {
        return result("heloc", null, mortInterest + helocInterest, fees, series.concat([mort + acct.line - acct.cash]), {
          lineMaxed: true,
          limit,
          chunkSize,
          chunks,
          mortInterest,
          helocInterest,
          peakLine,
        });
      }
      // Line back to zero: move the next chunk onto the mortgage.
      if (acct.line <= 0.005 && mort > 0) drawChunk();
      const debt = Math.max(0, mort + acct.line - acct.cash);
      series.push(debt);
      if (mort <= 0 && acct.line <= 0.005) {
        return result("heloc", month, mortInterest + helocInterest, fees, series, {
          limit,
          chunkSize,
          chunks,
          mortInterest,
          helocInterest,
          peakLine,
          avgLine: lineSum / lineDays,
        });
      }
      // Debt still rising after two years: this will never pay off.
      if (month >= 24 && debt > series[month - 12] + 1) break;
    }
    return result("heloc", null, mortInterest + helocInterest, fees, series, {
      limit,
      chunkSize,
      chunks,
      mortInterest,
      helocInterest,
      peakLine,
    });
  }

  // ── All-in-one first-lien HELOC ─────────────────────────────────────────
  function allInOne(p, overrides) {
    const q = Object.assign({}, p, overrides || {});
    const maxLoan = q.homeValue * (q.aioMaxLtv / 100);
    if (q.balance + q.aioCost > maxLoan) {
      return result("aio", null, 0, 0, [q.balance], { unavailable: true, maxLoan });
    }
    const dr = q.aioRate / 100 / 365;
    const acct = makeAccount();
    acct.line = q.balance + q.aioCost; // switching costs are financed
    let interest = 0;
    let lineSum = 0;
    let lineDays = 0;
    const series = [acct.line];
    const bw = { nextDay: 1 };
    for (let month = 1; month <= MAX_MONTHS; month++) {
      const { year, month: mo } = calendar(q, month - 1);
      const dim = daysInMonth(year, mo);
      const pays = paydays(q.payStrategy, q.income, year, mo, bw);
      const spends = spendingEvents(q, dim);
      let accrued = 0;
      for (let day = 1; day <= dim; day++) {
        for (const e of pays) if (e.day === day) inflow(acct, e.amount);
        for (const e of spends) if (e.day === day) outflow(acct, e.amount);
        accrued += acct.line * dr;
        lineSum += acct.line;
        lineDays++;
      }
      interest += accrued;
      outflow(acct, accrued);
      const debt = Math.max(0, acct.line - acct.cash);
      series.push(debt);
      if (acct.line <= 0.005) {
        return result("aio", month, interest, q.aioCost, series, { avgLine: lineSum / lineDays });
      }
      if (month >= 24 && debt > series[month - 12] + 1) break;
    }
    return result("aio", null, interest, q.aioCost, series, {});
  }

  // ── Where does the difference vs extra payments come from? ──────────────
  // Re-run each method at the mortgage's own rate. What remains vs extra
  // payments is the timing (float) effect; the rest is the rate difference.
  function breakdown(p, base, extra) {
    if (!base || base.neverPaysOff || base.unavailable || extra.neverPaysOff) return null;
    const sameRate =
      base.name === "heloc" ? heloc(p, { helocRate: p.rate, helocAnnualFee: 0 }) : allInOne(p, { aioRate: p.rate, aioCost: 0 });
    if (sameRate.neverPaysOff) return null;
    const timing = sameRate.interest - extra.interest; // negative = saves
    const rateCost = base.interest - sameRate.interest; // positive = costs
    return { timing, rateCost, fees: base.fees, net: base.cost - extra.cost };
  }

  function run(input) {
    const p = normalize(input);
    const out = {
      inputs: p,
      standard: standard(p),
      extra: extraPayments(p),
      heloc: heloc(p),
      aio: allInOne(p),
    };
    out.helocBreakdown = breakdown(p, out.heloc, out.extra);
    out.aioBreakdown = breakdown(p, out.aio, out.extra);
    return out;
  }

  // Stress tests for the "what's the catch" section.
  function stress(input) {
    const p = normalize(input);
    const pick = (r) => ({ heloc: r.heloc, aio: r.aio, extra: r.extra });
    return {
      ratesUp2: pick({
        extra: extraPayments(p),
        heloc: heloc(p, { helocRate: p.helocRate + 2 }),
        aio: allInOne(p, { aioRate: p.aioRate + 2 }),
      }),
      incomeDown10: pick(run(Object.assign({}, input, { income: p.income * 0.9, payment: p.payment }))),
      spendingUp10: pick(run(Object.assign({}, input, { spending: p.spending * 1.1, payment: p.payment }))),
    };
  }

  const api = { run, stress, monthlyPayment, normalize, availableEquity, MAX_MONTHS };
  root.PayoffEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
