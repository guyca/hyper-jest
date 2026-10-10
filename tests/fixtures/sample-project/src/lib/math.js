function add(a, b) {
  return a + b;
}

function divide(a, b) {
  if (b === 0) {
    throw new Error('division by zero');
  }
  return a / b;
}

function classify(n) {
  if (n < 0) return 'negative';
  if (n === 0) return 'zero';
  return 'positive';
}

function neverCalled() {
  return 'unreachable in tests';
}

module.exports = { add, divide, classify, neverCalled };
