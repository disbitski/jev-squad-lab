import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export class Budget {
  constructor({ path, ceiling = 5, maxRequests = 1500, price = .042, provider = 'typesafe' }) {
    if (![ceiling, maxRequests].every(n => Number.isFinite(n) && n > 0) || !Number.isFinite(price) || (provider === 'ollama' ? price !== 0 : price <= 0) || ceiling > 5 || !Number.isInteger(maxRequests) || maxRequests > 1500) throw new Error('Invalid budget configuration (maximum $5 and 1500 requests)');
    this.path = path; this.ceiling = ceiling; this.maxRequests = maxRequests; this.price = price;
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, provider, price, requests: 0, tokens: 0, accountedUsd: 0, uncertainRequests: 0 };
    if (this.data.provider !== provider || this.data.price !== price) throw new Error('Provider/pricing differs from existing ledger. Review it before starting a separate experiment.');
    if (!Number.isFinite(this.data.accountedUsd) || !Number.isFinite(this.data.requests)) throw new Error('Invalid budget ledger');
  }
  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
  reserve() {
    const reserved = 65536 * this.price / 1e6;
    if (this.data.requests >= this.maxRequests) throw new Error('request_limit');
    if (this.data.accountedUsd + reserved > this.ceiling) throw new Error('budget_exhausted');
    // Keep the maximum context charge if a response is lost or the process exits.
    this.data.requests++; this.data.accountedUsd += reserved; this.data.uncertainRequests++; this.save();
    return reserved;
  }
  settle(reserved, tokens) {
    if (!Number.isInteger(tokens) || tokens < 0 || tokens > 65536) return;
    this.data.tokens += tokens; this.data.accountedUsd += tokens * this.price / 1e6 - reserved; this.data.uncertainRequests--; this.save();
  }
  summary() { return { ...this.data, ceilingUsd: this.ceiling, maxRequests: this.maxRequests }; }
}
