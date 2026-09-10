# Testing

GravityRoute includes comprehensive automated test suites covering proxy streaming, reasoning models, load-balancing strategies, authentication, and mail delivery.

## Running the Full Test Suite

Start the server in one terminal:
```bash
npm start
```

Run the tests in another terminal:
```bash
npm test
```

To run a specific test filter:
```bash
node tests/run-all.cjs <filter>
```

---

## Targeted Test Suites

### Authentication, Security & SMTP Tests
```bash
node tests/test-webui-auth.cjs        # WebUI login, sessions, rate limits, cookies & password updates
node tests/test-password-recovery.cjs  # CLI reset (npm run reset-password) & SMTP OTP recovery
node tests/test-smtp.cjs               # SMTP transporter configuration, credential saving & diagnostics
node tests/test-api-keys.cjs           # API key generation, permissions, and request authorization
node tests/test-ip-restriction-api.cjs # Client IP restrictions and whitelist enforcement
```

### Proxy, Thinking & Reasoning Tests
```bash
npm run test:signatures    # Cross-model thinking signatures validation
npm run test:multiturn     # Multi-turn conversations with tool calling
npm run test:streaming     # Real-time SSE streaming events
npm run test:interleaved   # Interleaved thinking and assistant responses
npm run test:images        # Image processing & multimodal conversions
npm run test:caching       # Prompt caching transformations
npm run test:crossmodel    # Claude <-> Gemini model switching
npm run test:cache-control # Cache control stripping for Cloud Code API
```

### Strategy & Routing Tests
```bash
npm run test:strategies    # Account selection unit tests (Hybrid, Sticky, Round-Robin)
npm run test:emptyretry    # Empty response retries and rotation
npm run test:sanitizer     # Request schema sanitization
npm run test:oauth         # Headless OAuth flow tests
```
