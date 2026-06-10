import type { Monaco } from '@monaco-editor/react';
import { RITOBIN_LANGUAGE_ID } from './ritobinLanguage';

/**
 * Monaco hard-caps bracket-pair colorization.
 *
 * `BracketPairsTextModelPart.canBuildAST` (in monaco's
 * bracketPairsImpl.js) is a getter that returns
 *   `this.textModel.getValueLength() <= 50_000 * 100`   // ≈ 5 MB
 * with NO option to override it — `largeFileOptimizations`,
 * `bracketPairColorization.enabled`, nothing touches it.
 *
 * That ~5 MB CHARACTER cap doesn't match the app's policy, which thinks
 * in LINES: a file is "big" past `BIG_FILE_LINES` (125k). A 110k-line
 * bin dump is ~11 MB — well under the line limit but over monaco's char
 * cap — so bracket colorization died on files the user expected it on
 * (perf pref "auto" / off-on-big-files).
 *
 * We replace the getter so the limit is LINE-based and tracks the app's
 * policy:
 *   - "on"   → unlimited (colorize even past the big-file line limit)
 *   - "auto" → up to `BIG_FILE_LINES` (matches the editor's own
 *              `isBig` gate, so the option and the AST agree)
 *   - "off"  → up to `BIG_FILE_LINES` too (colorization is disabled via
 *              the editor option anyway; this only governs whether the
 *              AST exists for bracket matching)
 * A generous absolute character backstop still guards against
 * pathological few-but-enormous-line files (which the original cap
 * existed to protect against).
 */

// Absolute char ceiling — never hit by normal bin dumps (125k lines ×
// ~100 chars ≈ 12 MB); protects against a 1-line 300 MB blob.
const CHAR_BACKSTOP = 256 * 1024 * 1024;

// Default mirrors the app's `BIG_FILE_LINES` for the common "auto" pref
// so files opened before the saved pref loads still colorize correctly.
let astLineLimit = 125_000;
let patched = false;

/**
 * Set the bracket-AST line budget from the `bracketColors` perf pref.
 * Call synchronously when the pref loads/changes so monaco sees the
 * right budget the moment colorization is (re-)requested.
 */
export function setBracketAstPolicy(
    mode: 'on' | 'auto' | 'off',
    bigFileLines: number,
): void {
    astLineLimit = mode === 'on' ? Number.POSITIVE_INFINITY : bigFileLines;
}

/**
 * Patch monaco's bracket-pair AST size cap (once). Safe to call from
 * every `beforeMount` — it no-ops after the first success and degrades
 * gracefully if monaco's internals ever move.
 */
export function patchBracketPairLimit(monaco: Monaco): void {
    if (patched) return;
    let model: ReturnType<Monaco['editor']['createModel']> | undefined;
    try {
        // A throwaway model is the only handle we get to the
        // BracketPairsTextModelPart prototype where the getter lives.
        model = monaco.editor.createModel('', RITOBIN_LANGUAGE_ID);
        const bp = (model as unknown as { bracketPairs?: object }).bracketPairs;
        const proto = bp && Object.getPrototypeOf(bp);
        const desc = proto && Object.getOwnPropertyDescriptor(proto, 'canBuildAST');
        if (desc && typeof desc.get === 'function') {
            Object.defineProperty(proto, 'canBuildAST', {
                configurable: true,
                get(this: { textModel: { getLineCount(): number; getValueLength(): number } }) {
                    return (
                        this.textModel.getLineCount() <= astLineLimit &&
                        this.textModel.getValueLength() <= CHAR_BACKSTOP
                    );
                },
            });
            patched = true;
        }
    } catch {
        /* best-effort: if monaco's internals shift, leave default behavior */
    } finally {
        model?.dispose();
    }
}
