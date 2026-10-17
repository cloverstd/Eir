import test from 'node:test';
import assert from 'node:assert/strict';
import { canManageCollector, previewBlocked, operationLabel } from '../src/lifecycleDomain.ts';

test('remote lifecycle excludes offline and legacy firmware even when previously supported', () => {
  assert.equal(canManageCollector({online: false, supports_lifecycle: true}), false);
  assert.equal(canManageCollector({online: true, protocol_version: 1}), false);
  assert.equal(canManageCollector({online: true, supports_lifecycle: true}), true);
  assert.equal(canManageCollector({online: true, protocol_version: 2, lifecycle_state: 'binding'}), false);
  assert.equal(canManageCollector({online: true, status: {protocol_version: 2}}), true);
});
test('reset cannot run without a token, through blockers, or after preview expiry', () => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  assert.equal(previewBlocked(null, now), true);
  assert.equal(previewBlocked({counts: {measurements: 0}}, now), true);
  assert.equal(previewBlocked({preview_token:'p', blockers:['collector offline']}, now), true);
  assert.equal(previewBlocked({preview_token:'p', expires_at:'2026-10-16T23:59:59Z'}, now), true);
  assert.equal(previewBlocked({preview_token:'p', blockers:[], expires_at:'2026-10-17T00:10:00Z'}, now), false);
});
test('operation progress distinguishes requested, completed, and waiting for provisioning', () => {
  assert.notEqual(operationLabel('pending'), operationLabel('completed'));
  assert.equal(operationLabel('waiting_reprovision'), '等待重新配网');
  assert.equal(operationLabel('new-future-state'), 'new-future-state');
});
