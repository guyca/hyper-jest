const { greet } = require('../lib/greet');

describe('greet', () => {
  it('greets once', () => {
    expect(greet('world', 1)).toBe('hello world');
  });

  it('greets twice', () => {
    expect(greet('bob', 2)).toBe('hello bob\nhello bob');
  });

  it('matches snapshot', () => {
    expect({ text: greet('snap', 1) }).toMatchSnapshot();
  });

  it('duplicate name', () => { expect(1).toBe(1); });
  it('duplicate name', () => { expect(2).toBe(2); });
});
