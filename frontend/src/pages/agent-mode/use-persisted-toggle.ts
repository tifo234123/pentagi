import { useCallback, useState } from 'react';

const read = (key: string, fallback: boolean): boolean => {
    try {
        const value = window.localStorage.getItem(key);

        return value === null ? fallback : value === 'true';
    } catch {
        return fallback;
    }
};

export function usePersistedToggle(key: string, fallback: boolean) {
    const [isOpen, setIsOpen] = useState(() => read(key, fallback));

    const setOpen = useCallback(
        (next: boolean) => {
            setIsOpen(next);

            try {
                window.localStorage.setItem(key, String(next));
            } catch {
                // Storage can be unavailable (private mode); the toggle still works for this visit.
            }
        },
        [key],
    );

    const toggle = useCallback(() => setOpen(!isOpen), [isOpen, setOpen]);

    return [isOpen, setOpen, toggle] as const;
}
