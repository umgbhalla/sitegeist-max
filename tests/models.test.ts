import assert from 'node:assert/strict';
import { SYSTEM_PROMPT } from '../src/prompts/prompts.ts';
import { browserMessageTransformer } from '../src/messages/message-transformer.ts';
import { getModel, getModels, getSupportedThinkingLevels, clampThinkingLevel } from '@earendil-works/pi-ai/compat';
import { installLatestModelFilter, refreshOpenAIModel, getDefaultOpenAIModel } from '../src/models/latest.ts';
installLatestModelFilter();
for (const provider of ['openai', 'openai-codex']) {
  const models = getModels(provider);
  assert.deepEqual(models.map(m => m.id).sort(), ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra'].sort());
  for (const m of models) {
    assert.equal(getModel(provider, m.id), m);
    assert.equal(m.contextWindow, 1050000);
    assert.equal(m.maxTokens, 128000);
    assert.equal(m.api, provider === 'openai' ? 'openai-responses' : 'openai-codex-responses');
    assert.equal(m.thinkingLevelMap.off, m.id !== 'gpt-6.1-sol' ? 'none' : null);
    assert.deepEqual(getSupportedThinkingLevels(m), m.id !== 'gpt-6.1-sol' ? ['off', 'low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(clampThinkingLevel(m, 'minimal'), 'low');
    assert.equal(clampThinkingLevel(m, 'off'), m.id !== 'gpt-6.1-sol' ? 'off' : 'low');
    assert(getSupportedThinkingLevels(m).includes('xhigh'));
  }
  assert.equal(refreshOpenAIModel(getModel(provider, 'gpt-5.6-sol')).id, 'gpt-6.1-sol');
  assert.equal(refreshOpenAIModel(getModel(provider, 'gpt-5.6-luna')).id, 'gpt-6-luna');
  assert.equal(refreshOpenAIModel(getModel(provider, 'gpt-5.6-terra')).id, 'gpt-6.1-terra');
  assert.equal(refreshOpenAIModel(getModel(provider, 'gpt-6.1-terra')).id, 'gpt-6.1-terra');
  assert.equal(getModel(provider, 'gpt-6.1-terra').cost.input, 1);
  assert.equal(getDefaultOpenAIModel(provider).id, 'gpt-6.1-sol');
}
const other = getModel('anthropic', 'claude-sonnet-5');
assert.equal(refreshOpenAIModel(other), other);
installLatestModelFilter();
assert.equal(getModels('openai').length, 3);
console.log('Model catalog, routing, saved selections, reasoning and repeat installation passed.');

assert.match(SYSTEM_PROMPT, /active tab is optional context/);
assert.match(SYSTEM_PROMPT, /For general requests, answer directly/);
const navigation = await browserMessageTransformer([{ role: 'navigation', url: 'https://example.com', title: 'Example', tabId: 1, skillsOutput: '' }]);
assert.match(String(navigation[0].content), /task may be global or unrelated to this tab/);
assert.doesNotMatch(String(navigation[0].content), /CONTINUE IMMEDIATELY/);
console.log('General-task system prompt and optional browser-context prompt passed.');
