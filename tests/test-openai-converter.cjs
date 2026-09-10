/**
 * Unit tests for OpenAI <-> Anthropic Converter and Model Mapper
 */

const assert = require('assert');

async function runTests() {
    console.log('Testing OpenAI <-> Anthropic Converter & Model Mapper...');

    const { openAiToAnthropic, anthropicToOpenAi, OpenAiStreamTransformer } = await import('../src/openai/converter.js');
    const { resolveOpenAiModel, getOpenAiModelAliases } = await import('../src/openai/model-mapper.js');

    // 1. Test Model Resolution (Aliases + Direct Native IDs)
    console.log('\n--- 1. Testing Model Resolution ---');
    assert.strictEqual(resolveOpenAiModel('gpt-4o'), 'claude-sonnet-4-6', 'gpt-4o should map to claude-sonnet-4-6');
    assert.strictEqual(resolveOpenAiModel('gpt-4o-mini'), 'gemini-2.5-flash', 'gpt-4o-mini should map to gemini-2.5-flash');
    assert.strictEqual(resolveOpenAiModel('o1'), 'claude-opus-4-6-thinking', 'o1 should map to claude-opus-4-6-thinking');
    assert.strictEqual(resolveOpenAiModel('gpt-3.5-turbo'), 'gemini-2.5-flash', 'gpt-3.5-turbo should map to gemini-2.5-flash');

    // Direct native model IDs must be preserved as requested by user
    assert.strictEqual(resolveOpenAiModel('claude-sonnet-4-6'), 'claude-sonnet-4-6', 'Native claude-sonnet-4-6 must remain unchanged');
    assert.strictEqual(resolveOpenAiModel('claude-opus-4-6-thinking'), 'claude-opus-4-6-thinking', 'Native claude-opus-4-6-thinking must remain unchanged');
    assert.strictEqual(resolveOpenAiModel('gemini-2.5-pro'), 'gemini-2.5-pro', 'Native gemini-2.5-pro must remain unchanged');
    assert.strictEqual(resolveOpenAiModel('gemini-2.5-flash'), 'gemini-2.5-flash', 'Native gemini-2.5-flash must remain unchanged');
    console.log('✓ Model resolution passed (aliases + native models)');

    // 2. Test Model Aliases List
    console.log('\n--- 2. Testing Model Aliases List ---');
    const aliases = getOpenAiModelAliases();
    assert(Array.isArray(aliases) && aliases.length >= 5, 'Should return list of OpenAI aliases');
    assert(aliases.some(a => a.id === 'gpt-4o'), 'Should include gpt-4o');
    assert(aliases.some(a => a.id === 'o1'), 'Should include o1');
    console.log(`✓ Got ${aliases.length} OpenAI model aliases`);

    // 3. Test openAiToAnthropic Request Transformation
    console.log('\n--- 3. Testing openAiToAnthropic ---');
    const openAiReq = {
        model: 'gpt-4o',
        messages: [
            { role: 'system', content: 'You are a test assistant.' },
            { role: 'user', content: 'What is the weather in Tokyo?' },
            {
                role: 'assistant',
                content: 'Checking weather...',
                tool_calls: [
                    {
                        id: 'call_123',
                        type: 'function',
                        function: {
                            name: 'get_weather',
                            arguments: '{"location":"Tokyo"}'
                        }
                    }
                ]
            },
            {
                role: 'tool',
                tool_call_id: 'call_123',
                content: 'Sunny, 22C'
            }
        ],
        tools: [
            {
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Get current weather',
                    parameters: {
                        type: 'object',
                        properties: { location: { type: 'string' } },
                        required: ['location']
                    }
                }
            }
        ],
        tool_choice: 'auto',
        temperature: 0.7,
        max_tokens: 1000
    };

    const anthropicReq = openAiToAnthropic(openAiReq, 'claude-sonnet-4-6');
    assert.strictEqual(anthropicReq.model, 'claude-sonnet-4-6');
    assert.strictEqual(anthropicReq.system, 'You are a test assistant.');
    assert.strictEqual(anthropicReq.max_tokens, 1000);
    assert.strictEqual(anthropicReq.temperature, 0.7);

    // Check message turns
    assert.strictEqual(anthropicReq.messages.length, 3, 'Should have 3 turns (user, assistant, user with tool result)');
    assert.strictEqual(anthropicReq.messages[0].role, 'user');
    assert.strictEqual(anthropicReq.messages[0].content[0].text, 'What is the weather in Tokyo?');

    // Assistant turn with tool call
    assert.strictEqual(anthropicReq.messages[1].role, 'assistant');
    assert(Array.isArray(anthropicReq.messages[1].content));
    assert.strictEqual(anthropicReq.messages[1].content[0].type, 'text');
    assert.strictEqual(anthropicReq.messages[1].content[1].type, 'tool_use');
    assert.strictEqual(anthropicReq.messages[1].content[1].id, 'call_123');
    assert.strictEqual(anthropicReq.messages[1].content[1].name, 'get_weather');
    assert.deepStrictEqual(anthropicReq.messages[1].content[1].input, { location: 'Tokyo' });

    // User turn with tool result
    assert.strictEqual(anthropicReq.messages[2].role, 'user');
    assert(Array.isArray(anthropicReq.messages[2].content));
    assert.strictEqual(anthropicReq.messages[2].content[0].type, 'tool_result');
    assert.strictEqual(anthropicReq.messages[2].content[0].tool_use_id, 'call_123');
    assert.strictEqual(anthropicReq.messages[2].content[0].content, 'Sunny, 22C');

    // Check tools mapping
    assert(Array.isArray(anthropicReq.tools) && anthropicReq.tools.length === 1);
    assert.strictEqual(anthropicReq.tools[0].name, 'get_weather');
    assert.deepStrictEqual(anthropicReq.tools[0].input_schema, openAiReq.tools[0].function.parameters);
    console.log('✓ openAiToAnthropic request transformation passed');

    // 4. Test anthropicToOpenAi Response Transformation
    console.log('\n--- 4. Testing anthropicToOpenAi ---');
    const mockAnthropicResp = {
        id: 'msg_987654',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
            { type: 'thinking', thinking: 'The user asked for weather in Tokyo. Result was 22C.' },
            { type: 'text', text: 'The weather in Tokyo is currently sunny and 22°C.' }
        ],
        stop_reason: 'end_turn',
        usage: {
            input_tokens: 45,
            cache_read_input_tokens: 12,
            cache_creation_input_tokens: 0,
            output_tokens: 28
        }
    };

    const openAiResp = anthropicToOpenAi(mockAnthropicResp, 'gpt-4o');
    assert(openAiResp.id.startsWith('chatcmpl-'), 'ID should start with chatcmpl-');
    assert.strictEqual(openAiResp.object, 'chat.completion');
    assert.strictEqual(openAiResp.model, 'gpt-4o');
    assert.strictEqual(openAiResp.choices[0].finish_reason, 'stop');
    assert.strictEqual(openAiResp.choices[0].message.content, 'The weather in Tokyo is currently sunny and 22°C.');
    assert.strictEqual(openAiResp.choices[0].message.reasoning_content, 'The user asked for weather in Tokyo. Result was 22C.');

    // Token usage mapping
    assert.strictEqual(openAiResp.usage.prompt_tokens, 57);
    assert.strictEqual(openAiResp.usage.completion_tokens, 28);
    assert.strictEqual(openAiResp.usage.total_tokens, 85);
    assert.strictEqual(openAiResp.usage.prompt_tokens_details.cached_tokens, 12);
    console.log('✓ anthropicToOpenAi response transformation passed');

    // 5. Test OpenAiStreamTransformer
    console.log('\n--- 5. Testing OpenAiStreamTransformer ---');
    const transformer = new OpenAiStreamTransformer('gpt-4o', { include_usage: true });

    // message_start event
    const startChunks = transformer.transformEvent({
        type: 'message_start',
        message: {
            id: 'msg_stream_001',
            usage: { input_tokens: 15, cache_read_input_tokens: 5 }
        }
    });
    assert(startChunks.length > 0, 'Should produce initial chunk');
    assert(startChunks[0].includes('"role":"assistant"'), 'Should declare assistant role');

    // content_block_start (thinking)
    transformer.transformEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking' }
    });

    // content_block_delta (thinking delta)
    const thinkChunks = transformer.transformEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Analyzing query...' }
    });
    assert(thinkChunks.length > 0 && thinkChunks[0].includes('reasoning_content'), 'Should stream reasoning_content');

    // content_block_start (text)
    transformer.transformEvent({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' }
    });

    // content_block_delta (text delta)
    const textChunks = transformer.transformEvent({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Hello world' }
    });
    assert(textChunks.length > 0 && textChunks[0].includes('Hello world'), 'Should stream text delta');

    // message_delta
    const deltaChunks = transformer.transformEvent({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 10 }
    });
    assert(deltaChunks.length > 0 && deltaChunks[0].includes('"finish_reason":"stop"'), 'Should stream stop finish_reason');

    // message_stop
    const stopChunks = transformer.transformEvent({ type: 'message_stop' });
    assert(stopChunks.some(c => c.includes('data: [DONE]')), 'Should conclude stream with data: [DONE]');
    console.log('✓ OpenAiStreamTransformer streaming events passed');

    console.log('\nALL CONVERTER & MAPPER TESTS PASSED SUCCESSFULLY! 🎉');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
