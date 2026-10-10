const { add } = require('./math');

function greet(name, times) {
  const total = add(times, 0);
  const line = `hello ${name}`; //?
  console.log('greeting', name);
  return Array(total).fill(line).join('\n');
}

module.exports = { greet };
