// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../src/engine.js");

const base = {
  balance: 300000,
  rate: 6.5,
  yearsLeft: 28,
  homeValue: 450000,
  income: 8000,
  spending: 3500,
  helocRate: 8.5,
  aioRate: 7.75,
  startYear: 2026,
  startMonth: 9,
};

function near(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected} ± ${tol}, got ${actual}`);
}

test("scheduled payment matches the standard amortization formula", () => {
  near(E.monthlyPayment(300000, 6.5, 360), 1896.2, 0.01, "30-yr P&I");
  near(E.monthlyPayment(300000, 6.5, 336), 1941.05, 0.01, "28-yr P&I");
  near(E.monthlyPayment(120000, 0, 120), 1000, 1e-9, "0% rate");
});

test("standard schedule pays off on the loan's own term", () => {
  const r = E.run(base);
  assert.equal(r.standard.months, 336);
  near(r.standard.interest, 352192, 5, "28-yr interest");
});

test("every method accounts for every dollar", () => {
  for (const payStrategy of ["monthly", "semimonthly"]) {
    for (const spendTiming of ["spread", "card"]) {
      const r = E.run(Object.assign({}, base, { payStrategy, spendTiming }));
      for (const key of ["extra", "heloc", "aio"]) {
        const m = r[key];
        assert.ok(!m.neverPaysOff, `${key} should pay off`);
        const net = (base.income - base.spending) * m.months;
        const owed = base.balance + m.cost;
        // Cash put in covers principal + all interest + fees, with less
        // than one month of leftover cash to spare.
        assert.ok(net >= owed - 1, `${key} ${payStrategy}/${spendTiming}: paid ${net} < owed ${owed}`);
        assert.ok(net - owed < base.income, `${key} ${payStrategy}/${spendTiming}: ${net - owed} unaccounted`);
      }
    }
  }
});

test("zero leftover never pays off early and never looks like a win", () => {
  const p = E.normalize(base);
  const r = E.run(Object.assign({}, base, { spending: base.income - p.payment }));
  assert.equal(r.extra.months, 336);
  assert.ok(r.heloc.neverPaysOff || r.heloc.cost > r.standard.cost, "HELOC must not beat the standard schedule");
  assert.ok(r.aio.neverPaysOff || r.aio.cost > r.extra.cost, "AIO at a higher rate must not win with no float benefit");
});

test("negative leftover is reported as never paying off", () => {
  const r = E.run(Object.assign({}, base, { spending: 7000 }));
  assert.ok(r.heloc.neverPaysOff || r.heloc.lineMaxed);
  assert.ok(r.aio.neverPaysOff);
});

test("HELOC at the mortgage's own rate is never worse than extra payments (float only helps)", () => {
  const r = E.run(Object.assign({}, base, { helocRate: base.rate }));
  assert.ok(r.heloc.interest <= r.extra.interest + 1, `${r.heloc.interest} > ${r.extra.interest}`);
});

test("a higher HELOC rate costs more than the same plan at the mortgage rate", () => {
  const r = E.run(base);
  assert.ok(r.helocBreakdown.rateCost > 0);
  assert.ok(r.helocBreakdown.timing <= 0);
  near(r.helocBreakdown.timing + r.helocBreakdown.rateCost + r.helocBreakdown.fees, r.helocBreakdown.net, 0.01, "breakdown sums");
});

test("HELOC is unavailable without enough equity, instead of crashing", () => {
  const r = E.run(Object.assign({}, base, { homeValue: 360000 }));
  assert.equal(r.heloc.unavailable, true);
  assert.equal(r.helocBreakdown, null);
});

test("the HELOC line never exceeds its limit", () => {
  const r = E.run(Object.assign({}, base, { helocLimit: 15000 }));
  assert.ok(r.heloc.peakLine <= 15000 + 0.5, `peak ${r.heloc.peakLine}`);
});

test("switching cost is charged to the all-in-one loan", () => {
  const a = E.run(base).aio;
  const b = E.run(Object.assign({}, base, { aioCost: 8000 })).aio;
  assert.ok(b.cost > a.cost + 8000, "cost should include the fee plus interest on it");
  assert.ok(b.months >= a.months);
});

test("all-in-one lands close to a lender's own simulator (CMG AIO, Mar 2026)", () => {
  // Lender printout: $350,000 at 7.668%, $12,769/mo deposits,
  // $7,661.40/mo spending incl. taxes & insurance -> 92 payments, $112,406.
  const r = E.run({
    balance: 350000,
    rate: 7.668,
    yearsLeft: 30,
    homeValue: 600000,
    income: 12769,
    spending: 7661.4,
    aioRate: 7.668,
    payStrategy: "monthly",
    startYear: 2026,
    startMonth: 3,
  });
  near(r.aio.months, 92, 3, "payments");
  near(r.aio.interest, 112406, 112406 * 0.08, "interest");
});
