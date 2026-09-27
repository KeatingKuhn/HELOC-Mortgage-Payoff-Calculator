# Mortgage Payoff Comparison

A calculator (four tabs: Compare, Chart, Why & risks, Learn) that compares four ways to pay off a mortgage using the
**same money coming in and going out**:

1. **Current schedule** – pay the required payment only.
2. **Extra payments** – send leftover cash to the mortgage as extra principal.
3. **HELOC chunking** ("velocity banking") – deposit pay into a HELOC and move
   lump sums onto the mortgage.
4. **All-in-one loan** – a first-lien HELOC that replaces the mortgage and works
   as your bank account.

The goal is an honest answer. Almost all of the speed comes from leftover cash,
so the page shows how each method compares with plain extra payments. It also
splits the difference into what the float saves and what the higher rate costs.

## Files

- `index.html` – page markup and styles
- `src/engine.js` – the math: no dependencies, runs in the browser and Node
- `src/app.js` – reads the form, runs the engine, draws the results
- `tests/engine.test.js` – checks the math

## Run it

Open `index.html` in a browser. There's no build step and nothing to install.

## Test it

```sh
node --test tests/*.test.js
```

The tests check that every method accounts for every dollar, that zero or
negative leftover never shows a payoff, that the HELOC line never exceeds its
limit, and that the all-in-one model lands near a lender's own simulator.

## Disclaimer

Built by a homeowner for personal use and shared as-is, with no warranty. These are
educational estimates, not financial, tax, or legal advice.
