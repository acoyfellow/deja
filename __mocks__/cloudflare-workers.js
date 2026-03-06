// Mock for cloudflare:workers module

const DurableObject = class {
  constructor(state, env) {
    this.ctx = state;
    this.state = state;
    this.env = env;
  }
};

module.exports = {
  DurableObject,
};
