/**
 * User configurable correction rules.
 *
 * Rules are regular expressions that are applied to the raw metadata before
 * parsing. They are the escape hatch for metadata shapes the heuristic
 * parser cannot know about (station specific quirks, recurring typos, ...).
 *
 * Invalid regular expressions are rejected instead of throwing at runtime.
 */

import type { CorrectionRule } from './types';

export interface CompiledRule {
  id: string;
  label?: string;
  regex: RegExp;
  replacement: string;
  channel?: string;
  scope: 'raw' | 'artist' | 'title';
  enabled: boolean;
}

export interface CompiledRules {
  rules: CompiledRule[];
  /** Rules that could not be compiled, with the reason. */
  invalid: { id: string; label?: string; error: string }[];
}

/** Compile the user rules. Invalid expressions are collected in `invalid`. */
export function compileRules(rules: CorrectionRule[]): CompiledRules {
  const compiled: CompiledRule[] = [];
  const invalid: { id: string; label?: string; error: string }[] = [];

  for (const rule of rules ?? []) {
    if (!rule || rule.enabled === false) continue;
    if (!rule.pattern) {
      invalid.push({ id: rule.id, label: rule.label, error: 'Empty pattern' });
      continue;
    }
    try {
      const regex = new RegExp(rule.pattern, 'iu');
      compiled.push({
        id: rule.id,
        label: rule.label,
        regex,
        replacement: rule.replacement ?? '',
        channel: rule.channel,
        scope: rule.scope ?? 'raw',
        enabled: rule.enabled,
      });
    } catch (error) {
      invalid.push({
        id: rule.id,
        label: rule.label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { rules: compiled, invalid };
}

export interface RuleApplication {
  text: string;
  /** Identifiers of the rules that changed the text. */
  applied: string[];
}

/**
 * Apply the compiled rules to a string.
 *
 * Every rule is applied at most once per call, which keeps the result
 * predictable for the user.
 */
export function applyRules(
  text: string,
  compiled: CompiledRule[],
  scope: 'raw' | 'artist' | 'title',
  channel?: string | null,
): RuleApplication {
  let current = text;
  const applied: string[] = [];

  for (const rule of compiled) {
    if (rule.scope !== scope) continue;
    if (rule.channel && channel && rule.channel.trim() !== channel.trim()) continue;

    rule.regex.lastIndex = 0;
    if (!rule.regex.test(current)) continue;

    rule.regex.lastIndex = 0;
    const next = current.replace(rule.regex, rule.replacement);
    if (next !== current) {
      current = next;
      applied.push(rule.id);
    }
  }

  return { text: current, applied };
}
