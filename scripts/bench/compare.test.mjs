import assert from 'node:assert/strict';
import test from 'node:test';
import { compareDiagnostics, parseDiagnostics } from './compare.mjs';

const key = (...fields) => JSON.stringify(fields);

test('normalizes diagnostic identities without dropping duplicates', () => {
  const output = '\x1b[31m./src/App.vue(3,7): error TS2322: First\x1b[0m\r\n'
    + '  Nested message\r\n'
    + '/bench/src/App.vue(3,7): error TS2322: Second\r\n'
    + 'error TS18003: No inputs were found.\r\n';
  assert.deepEqual(parseDiagnostics(output, '/bench'), {
    diagnostics: [key('src/App.vue', 3, 7, 'error', 2322), key('src/App.vue', 3, 7, 'error', 2322),
      key(null, null, null, 'error', 18003)],
    unknown: [],
  });
});

test('retains unexpected output rather than counting it as a clean diagnostic stream', () => {
  assert.deepEqual(parseDiagnostics('\nError: checker crashed\n    at entry.js:42\n'), {
    diagnostics: [], unknown: ['Error: checker crashed', '    at entry.js:42'],
  });
});

test('surfaces extra duplicates and source column mismatches', () => {
  const first = ['App.vue', 1, 4, 'error', 2322];
  const second = ['App.vue', 1, 5, 'error', 2322];
  const [a, b] = [first, second].map(JSON.stringify);
  assert.deepEqual(compareDiagnostics([a, a], [a, b]), {
    equal: false, oracleOnly: [first], candidateOnly: [second],
  });
  assert.equal(compareDiagnostics([a, b], [b, a]).equal, true);
});
