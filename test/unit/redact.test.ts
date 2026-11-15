import { describe, expect, it } from 'vitest';
import { compilePatterns, preparePrompt, redact } from '../../src/capture/redact';

describe('redact', () => {
  it.each([
    ['API key', 'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz for this', 'sk-ant-api03'],
    ['GitHub token', 'token is ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghij'],
    ['AWS key id', 'AKIAIOSFODNN7EXAMPLE is the key', 'AKIAIOSFODNN7EXAMPLE'],
    ['bearer header', 'Authorization: Bearer abcdefghijklmnop.qrstuv', 'abcdefghijklmnop'],
    ['password pair', 'connect with password=hunter2secret now', 'hunter2secret'],
    ['quoted api key pair', 'set API_KEY: "abc123def456" in env', 'abc123def456'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'MIIEow'],
  ])('removes a %s', (_name, input, secret) => {
    const out = redact(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('keeps the key name of a key=value pair', () => {
    expect(redact('password=hunter2secret')).toBe('password=[REDACTED]');
  });

  it('leaves ordinary prompts alone', () => {
    const prompt = 'Add a token bucket rate limiter and rename the password field to passphrase.';
    expect(redact(prompt)).toBe(prompt);
  });

  it('applies user patterns and skips invalid ones', () => {
    const patterns = compilePatterns(['ACME-\\d+', '([unclosed', 42]);
    expect(patterns).toHaveLength(1);
    expect(redact('ticket ACME-1234 is internal', patterns)).toBe('ticket [REDACTED] is internal');
  });
});

describe('preparePrompt', () => {
  const prompt = 'Fix the login bug\nwith password=hunter2secret';

  it('full: keeps everything, redacted', () => {
    expect(preparePrompt(prompt, 'full')).toBe('Fix the login bug\nwith password=[REDACTED]');
  });

  it('firstLine: keeps only the first line', () => {
    expect(preparePrompt(prompt, 'firstLine')).toBe('Fix the login bug');
  });

  it('none: stores nothing', () => {
    expect(preparePrompt(prompt, 'none')).toBe('');
  });
});
