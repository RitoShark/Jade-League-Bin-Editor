/**
 * Tiny localStorage-backed `useState` for booleans.
 *
 * Used for panel open/closed state (Photo Studio sub-panels, Anim
 * Studio sub-panels, the general edit / particle / bin-nav side
 * panels — anything the user explicitly toggles via the toolbar or
 * a button). Dock placement is handled separately by
 * `useToolLayout` which already persists to its own key.
 *
 * Behaviour:
 *   - Reads the stored value on mount; falls back to `defaultValue`
 *     when the key is missing.
 *   - Writes on every `setValue` call. Storage failures (private
 *     mode, quota) are swallowed silently — state still updates
 *     in memory.
 *
 * Why not just inline localStorage in each useState initializer?
 *   The pattern repeats 12+ times across App.tsx; centralising it
 *   means a single bug-fix (e.g. namespacing the keys, migrating
 *   stored values) lands once.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Setter accepts either the next value or a `(prev) => next`
 *  function — matches the standard React `useState` signature so
 *  callers can swap `useState` → `usePersistedBool` with no other
 *  changes. */
type SetBool = (next: boolean | ((prev: boolean) => boolean)) => void;

export function usePersistedBool(
    key: string,
    defaultValue: boolean,
): [boolean, SetBool] {
    const [value, setValueState] = useState<boolean>(() => {
        if (typeof window === 'undefined') return defaultValue;
        try {
            const raw = window.localStorage.getItem(key);
            if (raw === null) return defaultValue;
            return raw === '1';
        } catch {
            return defaultValue;
        }
    });
    // Mirror the latest value in a ref so the setter's callback
    // form can resolve `prev` without depending on React's batched
    // state being readable synchronously.
    const latestRef = useRef(value);
    latestRef.current = value;

    const setValue = useCallback<SetBool>((next) => {
        const resolved = typeof next === 'function'
            ? (next as (prev: boolean) => boolean)(latestRef.current)
            : next;
        latestRef.current = resolved;
        setValueState(resolved);
        try {
            window.localStorage.setItem(key, resolved ? '1' : '0');
        } catch {
            // Quota / private mode — in-memory state still works,
            // the value just won't survive a reload.
        }
    }, [key]);
    return [value, setValue];
}

/** Shared-state string variant — same broadcast pattern, holds an
 *  arbitrary string (callers narrow the type with a generic). */
const sharedStringListeners: Map<string, Set<(v: string) => void>> = new Map();

export function useSharedPersistedString<T extends string>(
    key: string,
    defaultValue: T,
): [T, (next: T) => void] {
    const [value, setValueState] = useState<T>(() => {
        if (typeof window === 'undefined') return defaultValue;
        try {
            const raw = window.localStorage.getItem(key);
            return (raw ?? defaultValue) as T;
        } catch {
            return defaultValue;
        }
    });

    useEffect(() => {
        const cb = (v: string) => setValueState(v as T);
        let set = sharedStringListeners.get(key);
        if (!set) {
            set = new Set();
            sharedStringListeners.set(key, set);
        }
        set.add(cb);
        return () => { set!.delete(cb); };
    }, [key]);

    const setValue = useCallback((next: T) => {
        setValueState(next);
        try { window.localStorage.setItem(key, next); } catch { /* */ }
        const set = sharedStringListeners.get(key);
        if (set) for (const cb of set) cb(next);
    }, [key]);

    return [value, setValue];
}

/** Shared-state variant of `usePersistedBool` — every hook subscribed
 *  to the same `key` sees writes immediately, in addition to persisting
 *  through localStorage. Use this when two distinct components need to
 *  agree on a setting (e.g. a toolbar reads its orientation, and the
 *  shell wrapping it reads the same value to position the toolbar). */
const sharedListeners: Map<string, Set<(v: boolean) => void>> = new Map();

export function useSharedPersistedBool(
    key: string,
    defaultValue: boolean,
): [boolean, SetBool] {
    const [value, setValueState] = useState<boolean>(() => {
        if (typeof window === 'undefined') return defaultValue;
        try {
            const raw = window.localStorage.getItem(key);
            if (raw === null) return defaultValue;
            return raw === '1';
        } catch {
            return defaultValue;
        }
    });
    const latestRef = useRef(value);
    latestRef.current = value;

    useEffect(() => {
        const cb = (v: boolean) => {
            latestRef.current = v;
            setValueState(v);
        };
        let set = sharedListeners.get(key);
        if (!set) {
            set = new Set();
            sharedListeners.set(key, set);
        }
        set.add(cb);
        return () => { set!.delete(cb); };
    }, [key]);

    const setValue = useCallback<SetBool>((next) => {
        const resolved = typeof next === 'function'
            ? (next as (prev: boolean) => boolean)(latestRef.current)
            : next;
        latestRef.current = resolved;
        setValueState(resolved);
        try { window.localStorage.setItem(key, resolved ? '1' : '0'); } catch { /* */ }
        const set = sharedListeners.get(key);
        if (set) for (const cb of set) cb(resolved);
    }, [key]);

    return [value, setValue];
}
