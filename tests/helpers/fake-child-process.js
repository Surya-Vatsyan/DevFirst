'use strict';

const { EventEmitter } = require('events');

const createFakeChildProcess = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn((signal) => {
    setImmediate(() => {
      child.emit('close', null, signal || 'SIGKILL');
    });
  });

  return child;
};

const createCleanupChildProcess = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();

  setImmediate(() => {
    child.emit('close', 0, null);
  });

  return child;
};

module.exports = {
  createFakeChildProcess,
  createCleanupChildProcess
};
