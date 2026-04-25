/**
 * Circuit Breaker — per-retailer failure isolation
 *
 * States:
 *   CLOSED   → Normal operation. Requests flow through.
 *   OPEN     → Retailer is failing. Requests are rejected immediately (fast-fail).
 *              After timeout_ms, transitions to HALF_OPEN.
 *   HALF_OPEN → One probe request allowed. If it succeeds → CLOSED. If it fails → OPEN again.
 *
 * Why per-retailer:
 *   A Walmart outage should never block Kroger scrapes.
 *   Failure isolation is fundamental to high availability in multi-retailer systems.
 *
 * In production: store state in Redis so all workers share circuit state.
 * Locally: in-memory Map is sufficient.
 */

import { CircuitState } from '../utils/types';
import { CIRCUIT_BREAKER_THRESHOLD, CIRCUIT_BREAKER_TIMEOUT_MS } from '../utils/config';
import { logger } from '../utils/logger';

interface BreakState {
  state: CircuitState;
  failures: number;
  openedAt: number | null;
}

export class CircuitBreaker {
  private states: Map<string, BreakState> = new Map();

  private getState(retailer: string): BreakState {
    if (!this.states.has(retailer)) {
      this.states.set(retailer, { state: 'CLOSED', failures: 0, openedAt: null });
    }
    return this.states.get(retailer)!;
  }

  /**
   * Check if a request should be allowed for this retailer.
   * Throws if circuit is OPEN (not yet timed out).
   */
  allowRequest(retailer: string): void {
    const s = this.getState(retailer);

    if (s.state === 'CLOSED') return; // Happy path

    if (s.state === 'OPEN') {
      const elapsed = Date.now() - (s.openedAt ?? 0);
      if (elapsed >= CIRCUIT_BREAKER_TIMEOUT_MS) {
        // Transition to HALF_OPEN — probe one request
        s.state = 'HALF_OPEN';
        logger.warn(`Circuit HALF_OPEN for retailer=${retailer} — probe request allowed`);
        return;
      }
      const remaining = Math.ceil((CIRCUIT_BREAKER_TIMEOUT_MS - elapsed) / 1000);
      throw new Error(
        `Circuit OPEN for retailer=${retailer}. Retry in ${remaining}s. ` +
        `(${s.failures} consecutive failures)`
      );
    }

    // HALF_OPEN: allow the probe through (one at a time)
  }

  /**
   * Record a successful request — resets failure count, closes circuit.
   */
  onSuccess(retailer: string): void {
    const s = this.getState(retailer);
    if (s.state !== 'CLOSED') {
      logger.info(`Circuit CLOSED for retailer=${retailer} — recovery successful`);
    }
    s.state = 'CLOSED';
    s.failures = 0;
    s.openedAt = null;
  }

  /**
   * Record a failure — increments failure count, opens circuit at threshold.
   */
  onFailure(retailer: string): void {
    const s = this.getState(retailer);
    s.failures += 1;

    if (s.state === 'HALF_OPEN') {
      // Probe failed — re-open immediately
      s.state = 'OPEN';
      s.openedAt = Date.now();
      logger.error(`Circuit re-OPENED for retailer=${retailer} — probe failed`);
      return;
    }

    if (s.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      s.state = 'OPEN';
      s.openedAt = Date.now();
      logger.error(
        `Circuit OPENED for retailer=${retailer} after ${s.failures} consecutive failures. ` +
        `Blocking requests for ${CIRCUIT_BREAKER_TIMEOUT_MS / 1000}s.`
      );
    } else {
      logger.warn(
        `retailer=${retailer} failure ${s.failures}/${CIRCUIT_BREAKER_THRESHOLD}`
      );
    }
  }

  getStatus(): Record<string, BreakState> {
    const out: Record<string, BreakState> = {};
    this.states.forEach((v, k) => { out[k] = { ...v }; });
    return out;
  }
}

// Singleton — shared across all job workers in the process
export const circuitBreaker = new CircuitBreaker();
