import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentIdFrom, processAgentId } from './agent-id.js';

test('a session id wins: passed directly or from CLAUDE_CODE_SESSION_ID', () => {
  assert.equal(agentIdFrom({ sessionId: 'abc', env: { HC_TERMINAL_ID: 't1' } }), 'claude:abc');
  assert.equal(agentIdFrom({ env: { CLAUDE_CODE_SESSION_ID: ' abc ', HC_TERMINAL_ID: 't1' } }), 'claude:abc');
  // The direct value beats the environment.
  assert.equal(agentIdFrom({ sessionId: 'hook', env: { CLAUDE_CODE_SESSION_ID: 'env' } }), 'claude:hook');
});

test('without a session, the Herdr terminal (plus harness when known)', () => {
  assert.equal(agentIdFrom({ env: { HC_TERMINAL_ID: 't1' }, harness: 'pi' }), 'term:t1:pi');
  assert.equal(agentIdFrom({ env: { HC_TERMINAL_ID: 't1' } }), 'term:t1');
  assert.equal(agentIdFrom({ env: { HC_TERMINAL_ID: 't1' }, harness: '  ' }), 'term:t1');
  assert.equal(agentIdFrom({ sessionId: ' ', env: { HC_TERMINAL_ID: 't1' } }), 'term:t1');
});

test('nothing known → undefined; the env is never read implicitly', () => {
  assert.equal(agentIdFrom({}), undefined);
  assert.equal(agentIdFrom({ env: { CLAUDE_CODE_SESSION_ID: '', HC_TERMINAL_ID: '' } }), undefined);
});

test('the per-process fallback is minted once', () => {
  const id = processAgentId();
  assert.match(id, /^proc:[0-9a-f-]{36}$/);
  assert.equal(processAgentId(), id);
});
