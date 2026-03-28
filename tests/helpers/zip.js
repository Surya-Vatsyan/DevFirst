'use strict';

const yazl = require('yazl');

const createZipBuffer = (entries) =>
  new Promise((resolve, reject) => {
    const zipFile = new yazl.ZipFile();
    const chunks = [];

    for (const entry of entries) {
      zipFile.addBuffer(Buffer.from(entry.content, 'utf8'), entry.name);
    }

    zipFile.outputStream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    zipFile.outputStream.on('error', reject);
    zipFile.outputStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    zipFile.end();
  });

module.exports = {
  createZipBuffer
};
