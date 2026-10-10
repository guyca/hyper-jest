const { add, divide, classify } = require('../lib/math');

describe('add', () => {
  it('adds two numbers', () => {
    expect(add(1, 2)).toBe(3);
  });

  it('adds negative numbers', () => {
    expect(add(-1, -2)).toBe(-3);
  });
});

describe('divide', () => {
  it('divides', () => {
    expect(divide(6, 3)).toBe(2);
  });

  it('throws on zero', () => {
    expect(() => divide(1, 0)).toThrow('division by zero');
  });
});

describe('classify', () => {
  it.each([
    [-5, 'negative'],
    [0, 'zero'],
  ])('classify(%i) -> %s', (n, expected) => {
    expect(classify(n)).toBe(expected);
  });

  it('positive numbers (intentionally failing)', () => {
    expect(classify(5)).toBe('positiv');
  });

  it.skip('skipped test', () => {
    expect(true).toBe(false);
  });

  it.todo('todo test');
});
