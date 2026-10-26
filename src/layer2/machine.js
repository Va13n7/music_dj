/**
 * Claudiao · 播放状态机（M4-T7，docs/01 §8.1）
 *
 * IDLE / THINKING / RESOLVING / SPEAKING / PLAYING / DEGRADED / FALLBACK_AUDIO / MUSIC_ONLY
 * 非法迁移抛 E_BAD_TRANSITION；SPEAKING 与 PLAYING 互斥；三态都能回 IDLE。
 */
export const STATES = ['IDLE', 'THINKING', 'RESOLVING', 'SPEAKING', 'PLAYING', 'DEGRADED', 'FALLBACK_AUDIO', 'MUSIC_ONLY'];

const TRANSITIONS = {
  IDLE: ['THINKING', 'PLAYING', 'MUSIC_ONLY'],
  THINKING: ['RESOLVING', 'IDLE', 'SPEAKING', 'DEGRADED', 'MUSIC_ONLY'],
  RESOLVING: ['SPEAKING', 'PLAYING', 'DEGRADED', 'FALLBACK_AUDIO', 'MUSIC_ONLY', 'IDLE'],
  SPEAKING: ['PLAYING', 'IDLE', 'DEGRADED', 'MUSIC_ONLY'],
  PLAYING: ['IDLE', 'THINKING', 'SPEAKING', 'RESOLVING', 'DEGRADED', 'MUSIC_ONLY'],
  DEGRADED: ['PLAYING', 'SPEAKING', 'IDLE', 'FALLBACK_AUDIO', 'MUSIC_ONLY'],
  FALLBACK_AUDIO: ['IDLE', 'PLAYING'],
  MUSIC_ONLY: ['PLAYING', 'IDLE', 'THINKING'],
};

export class Machine {
  constructor(initial = 'IDLE', { onChange } = {}) {
    this.state = initial;
    this.onChange = onChange || (() => {});
  }

  can(next) {
    return (TRANSITIONS[this.state] || []).includes(next);
  }

  to(next) {
    if (!STATES.includes(next)) throw Object.assign(new Error(`未知状态 ${next}`), { code: 'E_BAD_STATE' });
    if (!this.can(next)) throw Object.assign(new Error(`非法迁移 ${this.state} → ${next}`), { code: 'E_BAD_TRANSITION' });
    const prev = this.state;
    this.state = next;
    this.onChange(next, prev);
    return prev;
  }

  /** 宽松版：非法迁移静默保持（日志由调用方记），返回是否实际迁移 */
  tryTo(next) {
    if (!this.can(next)) return false;
    this.to(next);
    return true;
  }
}
