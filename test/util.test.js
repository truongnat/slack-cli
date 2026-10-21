import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UsageError,
  closestMatch,
  cookieDomainMatches,
  formatBytes,
  formatDuration,
  isPlainObject,
  normalizeName,
  oneLine,
  parsePositiveInt,
  relativeTimeFromNow,
  renderKeyValues,
  renderTable,
  resolveTimeout,
  truncateMiddle,
  uniqueBy,
} from '../src/util.js';

test('parsePositiveInt validates range and fallback', () => {
  assert.equal(parsePositiveInt('5', '--limit'), 5);
  assert.equal(parsePositiveInt(undefined, '--limit', { fallback: 20 }), 20);
  assert.throws(() => parsePositiveInt('0', '--limit'), UsageError);
  assert.throws(() => parsePositiveInt('1.5', '--limit'), UsageError);
  assert.throws(() => parsePositiveInt('abc', '--limit'), UsageError);
  assert.throws(() => parsePositiveInt(undefined, '--limit'), UsageError);
});

test('resolveTimeout converts seconds to milliseconds', () => {
  assert.equal(resolveTimeout(undefined, 45), 45_000);
  assert.equal(resolveTimeout('10', 45), 10_000);
  assert.throws(() => resolveTimeout('0', 45), UsageError);
  assert.throws(() => resolveTimeout('9999', 45), UsageError);
});

test('normalizeName strips prefixes and lowercases', () => {
  assert.equal(normalizeName('#General'), 'general');
  assert.equal(normalizeName('  @Alice '), 'alice');
  assert.equal(normalizeName(null), '');
});

test('cookieDomainMatches handles leading dots and subdomains', () => {
  assert.equal(cookieDomainMatches('.slack.com', 'slack.com'), true);
  assert.equal(cookieDomainMatches('app.slack.com', 'slack.com'), true);
  assert.equal(cookieDomainMatches('slack.com', 'slack.com'), true);
  assert.equal(cookieDomainMatches('notslack.com', 'slack.com'), false);
  assert.equal(cookieDomainMatches('slack.com.evil.test', 'slack.com'), false);
});

test('renderTable aligns columns and truncates long cells', () => {
  const output = renderTable(['NAME', 'VALUE'], [
    ['alpha', 'one'],
    ['b', 'a very long cell'],
  ], { maxCellWidth: 8 });
  const lines = output.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^NAME\s+VALUE/);
  assert.match(output, /a very …/);
});

test('renderTable returns empty string without rows', () => {
  assert.equal(renderTable(['A'], []), '');
});

test('renderKeyValues pads keys to a common width', () => {
  const output = renderKeyValues([
    ['Team', 'Acme'],
    ['Team ID', 'T123'],
  ]);
  assert.equal(output, 'Team    : Acme\nTeam ID : T123');
});

test('oneLine collapses whitespace and truncates', () => {
  assert.equal(oneLine(' a\n b\t c '), 'a b c');
  assert.equal(oneLine('abcdef', 4), 'abc…');
});

test('truncateMiddle keeps both ends', () => {
  assert.equal(truncateMiddle('short', 10), 'short');
  assert.equal(truncateMiddle('abcdefghijklmnop', 9), 'abcd…mnop');
});

test('uniqueBy preserves first occurrence order', () => {
  const items = [{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 1, v: 'c' }];
  assert.deepEqual(uniqueBy(items, (item) => item.id).map((item) => item.v), ['a', 'b']);
});

test('closestMatch filters by partial name overlap', () => {
  const result = closestMatch('gen', ['general', 'random', 'general-2'], 5);
  assert.deepEqual(result, ['general', 'general-2']);
});

test('isPlainObject accepts only plain objects', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('x'), false);
});

test('formatBytes renders human-readable sizes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(10 * 1024), '10 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes('nope'), '-');
  assert.equal(formatBytes(-5), '-');
});

test('formatDuration renders compact durations', () => {
  assert.equal(formatDuration(500), '0s');
  assert.equal(formatDuration(65_000), '1m');
  assert.equal(formatDuration(3 * 60 * 60 * 1000), '3h');
  assert.equal(formatDuration(-1), '-');
});

test('relativeTimeFromNow handles invalid and past values', () => {
  assert.equal(relativeTimeFromNow(null), '-');
  assert.equal(relativeTimeFromNow('not-a-date'), 'not-a-date');
  assert.match(relativeTimeFromNow(new Date(Date.now() - 60_000).toISOString()), /^(1m|60s|59s) ago$/);
});
